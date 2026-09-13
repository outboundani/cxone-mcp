// Configuration resolution. Two sources, env wins:
//   1. Wrangler secrets / vars (CXONE_ACCESS_KEY_ID, CXONE_ACCESS_KEY_SECRET,
//      CXONE_API_BASE (optional), MCP_AUTH_TOKEN)
//   2. The KV-stored config written by the in-browser setup wizard (/setup)
//
// Only the access key pair is required: the client discovers the tenant and
// its regional API host from the token claims + the public well-known
// endpoint. CXONE_API_BASE exists as an override for private clusters.

const KV_KEY = 'cxone-config';

export async function loadConfig(env) {
  let stored = null;
  if (env.CONFIG) {
    try { stored = await env.CONFIG.get(KV_KEY, 'json'); } catch { /* KV unavailable */ }
  }
  const envManaged = Boolean(env.CXONE_ACCESS_KEY_ID || env.CXONE_ACCESS_KEY_SECRET);
  const cfg = {
    accessKeyId: env.CXONE_ACCESS_KEY_ID || stored?.accessKeyId || '',
    accessKeySecret: env.CXONE_ACCESS_KEY_SECRET || stored?.accessKeySecret || '',
    apiBase: (envManaged ? env.CXONE_API_BASE : stored?.apiBase) || env.CXONE_API_BASE || '',
    authToken: env.MCP_AUTH_TOKEN || stored?.authToken || '',
    source: envManaged ? 'env' : (stored ? 'kv' : 'none'),
    hasKv: Boolean(env.CONFIG),
  };
  cfg.configured = Boolean(cfg.accessKeyId && cfg.accessKeySecret);
  return cfg;
}

export async function saveConfig(env, { accessKeyId, accessKeySecret, apiBase, authToken }) {
  await env.CONFIG.put(KV_KEY, JSON.stringify({ accessKeyId, accessKeySecret, apiBase, authToken }));
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
