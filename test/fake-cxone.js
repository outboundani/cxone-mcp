// A fake CXone for tests: sign in, discovery and a small slice of the ACD API,
// answered in memory. No network. Imported by the *.test.js files.

export const KEY_ID = 'AKIDCXONE0001234ABCD';
export const SECRET = 'Cx0neS3cretValue-DoNotLeak-987654321';
export const API_HOST = 'api-b32.nice-incontact.com';

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const jwt = (claims) => `${b64url({ alg: 'RS256' })}.${b64url(claims)}.c2ln`;

let keyN = 0;

// Options:
//   claims      token claims (tenant, cluster, area, domain)
//   discovery   what the well-known endpoint answers (null = 404)
//   authAccept  sign in hosts that accept the key (default: all)
//   skills, scripts, pocs   list answers
//   raw         { 'METHOD path': body } answers anything else
//   scriptJson / scriptXml  get_script answers
//   hang        never answer API calls (until aborted); hangMethods: only these methods
export function makeCxone({
  claims = { tenantId: 'T-1', tenant: 'acme', icBUId: 4606137, icClusterId: 'B32' },
  discovery = { api_endpoint: `https://${API_HOST}` },
  authAccept = null, skills = [], scripts = [], pocs = [], raw = {}, scriptJson = null, scriptXml = null,
  hang = false, hangMethods = null, status = {},
} = {}) {
  const requests = [];
  let logins = 0;
  const respond = (data, s = 200) => new Response(JSON.stringify(data), { status: s, headers: { 'Content-Type': 'application/json' } });
  async function fetch(input, init = {}) {
    const url = new URL(String(input?.url ?? input));
    const method = (init.method || 'GET').toUpperCase();
    const entry = { method, host: url.hostname, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: init.headers?.Authorization, body: init.body };
    requests.push(entry);
    if (url.pathname === '/authentication/v1/token/access-key') {
      const body = JSON.parse(init.body);
      if (body.accessKeyId !== cfg.accessKeyId || body.accessKeySecret !== SECRET) return respond({ error: 'invalid_grant', echo: body.accessKeySecret }, 401);
      if (authAccept && !authAccept.includes(url.hostname)) return respond({ error: 'wrong area', echo: body.accessKeySecret }, 401);
      logins++;
      const t = jwt({ ...claims, n: logins });
      return respond({ access_token: t, id_token: t, refresh_token: 'r', expires_in: 3600 });
    }
    if (url.pathname === '/.well-known/cxone-configuration') return discovery ? respond(discovery) : respond({}, 404);
    const p = url.pathname.replace(/^\/inContactAPI\/services\/v\d+\.\d\//, '');
    if (hang || (hangMethods && hangMethods.includes(method))) {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)));
    }
    if (status[`${method} ${p}`]) return respond({ error: 'upstream says no' }, status[`${method} ${p}`]);
    if (raw[`${method} ${p}`] !== undefined) return respond(raw[`${method} ${p}`]);
    if (method === 'GET' && p === 'scripts' && url.searchParams.get('scriptPath')) return scriptJson ? respond(scriptJson) : respond({ error: 'desktop only' }, 500);
    if (method === 'GET' && /^scripts\/\d+$/.test(p) && scriptXml !== null) {
      const body = Buffer.isBuffer(scriptXml) ? scriptXml.toString('base64') : Buffer.from(scriptXml).toString('base64');
      return respond({ name: 'Legacy', ScriptId: 3, body });
    }
    if (method === 'GET' && p === 'business-unit') return respond({ businessUnits: [{ businessUnitId: 4606137, businessUnitName: 'Acme BU' }] });
    if (method === 'GET' && p === 'skills') return respond({ skills, totalRecords: String(skills.length) });
    if (method === 'GET' && p === 'agents') return respond({ agents: [], totalRecords: '0' });
    if (method === 'GET' && p === 'points-of-contact') return respond({ pointsOfContact: pocs });
    if (method === 'GET' && p === 'scripts/search') return respond({ scriptSearchDetails: scripts.map((n, i) => ({ masterID: i + 1, scriptName: n, status: 'CURR' })) });
    if (method === 'POST' && p === 'lists/call-lists') return respond({ listId: 55 });
    if (method !== 'GET') return respond({ ok: true });
    return respond({ error: 'not found' }, 404);
  }
  // A fresh access key per fake keeps the module-level session cache apart.
  const cfg = { configured: true, accessKeyId: `${KEY_ID}-${++keyN}`, accessKeySecret: SECRET, apiBase: '', fetch };
  const api = () => requests.filter((r) => r.path.startsWith('/inContactAPI'));
  return { fetch, requests, api, cfg, logins: () => logins };
}
