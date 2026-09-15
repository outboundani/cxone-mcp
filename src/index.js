// cxone-mcp - an MCP server (streamable HTTP, stateless) for NiCE CXone,
// running on Cloudflare Workers with zero dependencies.

import { CxoneError, CxoneClient } from './cxone.js';
import { toolDefs, callTool } from './tools.js';
import { handleOAuth, checkAuth, unauthorized } from './oauth.js';
import { INSTRUCTIONS } from './about.js';
import { landingPage, setupPage } from './ui.js';
import { loadConfig, saveConfig, randomToken } from './config.js';

const SERVER_INFO = { name: 'cxone-mcp', version: '0.1.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    const res = await route(request, env);
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
    return res;
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  const cfg = await loadConfig(env);

  const oauthRes = await handleOAuth(request, cfg.authToken, url);
  if (oauthRes) return oauthRes;

  if (request.method === 'GET' && path === '/') return html(landingPage(toolDefs(), cfg));
  if (request.method === 'GET' && path === '/setup') return html(setupPage(cfg));
  if (request.method === 'POST' && path === '/setup') return handleSetup(request, env, cfg);
  if (request.method === 'GET' && path === '/health') return json({ ok: true, server: SERVER_INFO, configured: cfg.configured });

  if (path === '/' || path === '/mcp') {
    if (request.method !== 'POST') {
      return json({ error: 'MCP requests must be POSTed to /mcp' }, 405);
    }
    if (!(await checkAuth(request, cfg.authToken))) return unauthorized(url.origin);
    let body;
    try { body = await request.json(); } catch {
      return json(rpcError(null, -32700, 'Parse error: body must be JSON'), 400);
    }
    if (Array.isArray(body)) {
      const results = (await Promise.all(body.map((m) => handleMessage(m, cfg)))).filter(Boolean);
      return results.length ? json(results) : new Response(null, { status: 202 });
    }
    const result = await handleMessage(body, cfg);
    return result ? json(result) : new Response(null, { status: 202 });
  }

  return json({ error: 'Not found' }, 404);
}

// In-browser setup wizard. First run (nothing configured) is open; once
// configured, changes require the current access key. Env-managed servers
// (Wrangler secrets) can't be edited here - secrets win over KV.
async function handleSetup(request, env, cfg) {
  if (cfg.source === 'env') {
    return json({ error: 'This server is configured with Wrangler secrets, which override the setup wizard. Update it with `npx wrangler secret put`.' }, 409);
  }
  if (!cfg.hasKv) {
    return json({ error: 'No CONFIG KV namespace is bound to this Worker - add the [[kv_namespaces]] block from wrangler.toml and redeploy.' }, 500);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Body must be JSON.' }, 400); }

  if (cfg.configured) {
    const auth = request.headers.get('Authorization') || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (body.current_key || '');
    if (!cfg.authToken || presented !== cfg.authToken) {
      return json({ error: 'This server is already configured - enter its current access key to make changes.' }, 401);
    }
  }

  const accessKeyId = String(body.access_key_id || '').trim();
  const accessKeySecret = String(body.access_key_secret || '').trim();
  const apiBase = String(body.api_base || '').trim().replace(/\/+$/, '');
  if (!accessKeyId || !accessKeySecret) return json({ error: 'Access Key ID and Access Key Secret are required.' }, 400);

  // Validate the credentials against CXone before saving anything - and
  // discover the tenant while we're at it.
  let tenant, businessUnit;
  try {
    const probe = new CxoneClient({ accessKeyId, accessKeySecret, apiBase });
    const session = await probe.session();
    tenant = session.tenant;
    const bu = await probe.get('business-unit');
    businessUnit = bu.businessUnits?.[0]?.businessUnitName || session.tenant;
  } catch (e) {
    return json({ error: `CXone rejected these credentials: ${e.message}` }, 400);
  }

  const isFirstRun = !cfg.configured;
  const authToken = cfg.authToken || randomToken();
  await saveConfig(env, { accessKeyId, accessKeySecret, apiBase, authToken });
  return json({
    ok: true,
    tenant,
    businessUnit,
    // The key is shown once, on first configuration only.
    accessKey: isFirstRun ? authToken : undefined,
    note: isFirstRun
      ? `Connected to "${businessUnit}" (tenant ${tenant}). Save this access key somewhere safe - it is shown only once. Use it to connect Claude, ChatGPT, or any MCP client.`
      : `Credentials updated (business unit "${businessUnit}"). Your existing access key is unchanged.`,
  });
}

async function handleMessage(msg, cfg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return rpcError(msg?.id ?? null, -32600, 'Invalid JSON-RPC 2.0 request');
  }
  const { id, method, params } = msg;

  // Notifications (no id) get no response body.
  if (id === undefined || id === null) return null;

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: toolDefs() });
      case 'tools/call': {
        const name = params?.name;
        try {
          const result = await callTool(cfg, name, params?.arguments);
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
        } catch (e) {
          if (e instanceof CxoneError || e.message?.startsWith('Unknown tool')) {
            return rpcResult(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
          }
          throw e;
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return rpcError(id, -32603, `Internal error: ${e.message}`);
  }
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function html(markup) {
  return new Response(markup, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
