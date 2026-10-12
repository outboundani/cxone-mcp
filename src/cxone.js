// NiCE CXone API client - zero-dependency, with module-level token caching
// and automatic tenant discovery: an access key pair is all it needs. The
// token's own claims name the tenant, and the public well-known endpoint
// maps the tenant to its regional API host.
//
// The regional API host is pinned: whether it comes from configuration, the
// discovery endpoint or the token claims, it must be an official NiCE CXone
// API host, or nothing (least of all the bearer token) is sent to it.

export class CxoneError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'CxoneError';
    this.status = status;
    this.code = code;
  }
}

// Sign in hosts for the access key flow (developer.niceincontact.com
// "UserHub: Getting Started": POST https://na1.nice-incontact.com/authentication/v1/token/access-key,
// with area specific domains na1, eu1 and au1). cxone.niceincontact.com (the
// discovery host) also issues tokens. They are tried in order, the tenant's own
// area first when the configured API host names it. FedRAMP (cxone-gov)
// tenants are not supported.
export const AUTH_HOSTS = [
  'na1.nice-incontact.com',
  'cxone.niceincontact.com',
  'eu1.nice-incontact.com',
  'au1.nice-incontact.com',
];
export const areaAuthHost = (apiHost) => {
  const m = /^api-(?:[a-z]+-)?(na1|eu1|au1)\./.exec(String(apiHost || '').toLowerCase());
  return m ? `${m[1]}.nice-incontact.com` : null;
};
export const DISCOVERY_HOST = 'cxone.niceincontact.com';

// Official NiCE CXone API hosts: one label "api-<area or cluster>" on a NiCE
// registrable domain (developer.niceincontact.com builds https://api-{area}.{domain};
// help.nicecxone.com "FQDNs and IP Addresses by Cluster" lists hosts such as
// api-na1.niceincontact.com, api-B32.nice-incontact.com and api-C4.incontact.com).
// Compared lower case.
export const OFFICIAL_API_HOST = /^api-[a-z0-9]+(?:-[a-z0-9]+)*\.(?:niceincontact|nice-incontact|incontact)\.com$/;

// Accepts "api-b32.nice-incontact.com" or "https://api-b32.nice-incontact.com/"
// and returns the lower case host, or null when it is not an official host
// (http, userinfo, port, path, query and fragment are all refused).
export function officialApiHost(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (/^https:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
    s = u.hostname;
  } else if (/[/:@?#\\\s]/.test(s)) {
    return null;
  }
  s = s.replace(/\.$/, '').toLowerCase();
  return OFFICIAL_API_HOST.test(s) ? s : null;
}

const ACD_VERSION = 'v30.0';
// One time budget per tool call: every request, retry and wait shares it, so a
// slow or hanging CXone answer ends the call cleanly instead of running until
// the MCP client gives up.
export const DEFAULT_BUDGET_MS = 25_000;

export function decodeJwt(token) {
  try {
    const b64 = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64));
  } catch { return null; }
}

const str = (v) => (typeof v === 'string' ? v : '');

// accessKeyId + configured API host -> { token, exp (ms), apiBase, tenant, busNo }.
// Only the access token is kept; the refresh token is never stored.
const sessionCache = new Map();

export class CxoneClient {
  // fetch is optional (tests inject one); the global fetch is used otherwise.
  // One client serves one tool call: budgetMs (or an absolute deadline) bounds it.
  constructor({ accessKeyId, accessKeySecret, apiBase, fetch, budgetMs = DEFAULT_BUDGET_MS, deadline }) {
    this.accessKeyId = accessKeyId;
    this.accessKeySecret = accessKeySecret;
    this.apiBaseOverride = apiBase || '';
    this.fetch = typeof fetch === 'function' ? fetch : (...a) => globalThis.fetch(...a);
    this.cacheKey = `${accessKeyId}\n${this.apiBaseOverride}`;
    this.deadline = Number.isFinite(deadline) ? deadline : Date.now() + budgetMs;
    this.writeSent = false; // set once a POST, PUT or PATCH to the API has gone out
  }

  // Every request and every wait checks the budget.
  checkBudget(extraMs = 0) {
    if (Date.now() + extraMs > this.deadline) {
      throw new CxoneError('Stopped at the time limit for one tool call. Steps before this point may have completed; check with a read tool before retrying.', 504, 'time_limit');
    }
  }

  async sleep(ms) {
    this.checkBudget(ms);
    await new Promise((r) => setTimeout(r, ms));
  }

  // Every request carries the remaining budget as an abort signal, so one slow
  // request cannot run past it. isWrite marks an API write: once one has gone
  // out, a later failure has an unknown outcome.
  async send(url, { isWrite = false, ...init } = {}) {
    this.checkBudget();
    if (isWrite) this.writeSent = true;
    try {
      return await this.fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(1, this.deadline - Date.now())) });
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new CxoneError('Stopped at the time limit for one tool call: CXone did not answer in time. Steps before this point may have completed; check with a read tool before retrying.', 504, 'time_limit');
      }
      throw e;
    }
  }

  async session() {
    const cached = sessionCache.get(this.cacheKey);
    if (cached && cached.exp > Date.now()) return cached;

    // A configured API host is checked before any credential is sent anywhere.
    let configuredHost = null;
    if (this.apiBaseOverride) {
      configuredHost = officialApiHost(this.apiBaseOverride);
      if (!configuredHost) {
        throw new CxoneError('Refused: the configured CXone API base is not an official NiCE CXone API host (https://api-<area>.niceincontact.com, .nice-incontact.com or .incontact.com). Fix CXONE_API_BASE or leave it empty to discover the host.', 400, 'unofficial_host');
      }
    }

    const area = areaAuthHost(configuredHost);
    const order = area ? [area, ...AUTH_HOSTS.filter((h) => h !== area)] : AUTH_HOSTS;
    let lastErr = null;
    for (const host of order) {
      try {
        const res = await this.send(`https://${host}/authentication/v1/token/access-key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ accessKeyId: this.accessKeyId, accessKeySecret: this.accessKeySecret }),
        });
        if (!res.ok) {
          // The response body is not echoed: it is not needed and can carry request details.
          lastErr = new CxoneError(
            `CXone login failed (HTTP ${res.status}). ` +
            'Check the Access Key ID/Secret (Admin > Employees > your user > Security tab > Access Keys).',
            res.status
          );
          continue;
        }
        const data = await res.json();
        if (!data || typeof data.access_token !== 'string' || !data.access_token) {
          lastErr = new CxoneError('CXone login returned no access token.', 502);
          continue;
        }
        const claims = decodeJwt(data.id_token) || decodeJwt(data.access_token) || {};
        const session = {
          token: data.access_token,
          // Refresh 5 minutes early (tokens live 1h).
          exp: Date.now() + Math.max(60, (Number(data.expires_in) || 3600) - 300) * 1000,
          tenant: str(claims.tenant),
          tenantId: str(claims.tenantId),
          busNo: claims.icBUId ?? null,
          cluster: str(claims.icClusterId),
          area: str(claims.area),
          domain: str(claims.domain),
          role: claims.role?.legacyId || '',
          apiBase: configuredHost ? `https://${configuredHost}` : '',
        };
        if (!session.apiBase) session.apiBase = await this.discoverApiBase(session);
        sessionCache.set(this.cacheKey, session);
        return session;
      } catch (e) {
        if (e instanceof CxoneError && (e.code === 'unofficial_host' || e.code === 'time_limit')) throw e;
        lastErr = e instanceof CxoneError ? e : new CxoneError(`CXone login failed at ${host}: ${e.message}`, 0);
      }
    }
    throw lastErr || new CxoneError('CXone login failed: no auth host reachable', 0);
  }

  // Tenant -> regional API host, via the public well-known endpoint
  // (api_endpoint, or area + domain); falls back to the area and domain or the
  // cluster id in the token claims. Whatever the source, the result must be an
  // official NiCE CXone API host. If the well-known endpoint names an
  // unofficial host, discovery fails closed instead of falling back.
  async discoverApiBase(session) {
    const candidates = [];
    if (session.tenantId) {
      try {
        const res = await this.send(`https://${DISCOVERY_HOST}/.well-known/cxone-configuration?tenantId=${encodeURIComponent(session.tenantId)}`, { headers: { Accept: 'application/json' } });
        if (res.ok) {
          const cfg = await res.json();
          if (typeof cfg?.api_endpoint === 'string' && cfg.api_endpoint) candidates.push(cfg.api_endpoint.replace(/\/+$/, ''));
          else if (typeof cfg?.area === 'string' && typeof cfg?.domain === 'string') candidates.push(`api-${cfg.area}.${cfg.domain}`);
        }
      } catch (e) {
        if (e?.code === 'time_limit') throw e;
        /* fall through to the claims */
      }
    }
    if (!candidates.length && session.area && session.domain) candidates.push(`api-${session.area}.${session.domain}`);
    if (!candidates.length && session.cluster) candidates.push(`api-${session.cluster}.nice-incontact.com`);
    if (!candidates.length) throw new CxoneError('Could not discover the CXone API endpoint - set CXONE_API_BASE explicitly.', 500);
    const host = officialApiHost(candidates[0]);
    if (!host) throw new CxoneError('Refused: CXone discovery named an API host that is not an official NiCE CXone domain, so nothing was sent to it.', 502, 'unofficial_host');
    return `https://${host}`;
  }

  invalidate() {
    sessionCache.delete(this.cacheKey);
  }

  // Core request helper for the ACD Admin API. `path` is relative to
  // /inContactAPI/services/vXX.0/ (e.g. "skills" or "scripts/search").
  // Retries once on 401 (stale token) and backs off twice on 429 (CXone
  // sends no reliable Retry-After, so exponential: 2s then 6s), within the
  // budget: a backoff that would run past it stops instead.
  async api(method, path, { body, query, version, _attempt = 0 } = {}) {
    const s = await this.session();
    const rel = String(path).replace(/^\/+/, '');
    const ver = version || ACD_VERSION;
    if (!/^v\d{2}\.\d$/.test(ver)) throw new CxoneError(`Bad API version "${ver}" - expected the form v30.0`, 400);
    const expected = `/inContactAPI/services/${ver}/${rel}`;
    const url = new URL(`${s.apiBase}${expected}`);
    // Defense in depth: if URL parsing rewrote the path (dot segments, a
    // stray ? or #), the request would land somewhere other than what the
    // caller checked. Refuse instead of sending it.
    if (!url.pathname.endsWith(expected) || url.search || url.hash) {
      throw new CxoneError(`Refused: the path "${rel}" does not survive URL parsing unchanged.`, 400);
    }
    // The same pin, checked on the URL that is actually sent.
    if (!OFFICIAL_API_HOST.test(url.hostname) || url.protocol !== 'https:') {
      throw new CxoneError('Refused: the CXone API host is not an official NiCE CXone host.', 400, 'unofficial_host');
    }
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await this.send(url, {
      method,
      isWrite: method !== 'GET',
      headers: {
        Authorization: `Bearer ${s.token}`,
        // CXone answers "No known way to render data" without an Accept
        // header, and workerd's fetch (unlike Node's) sends none by default.
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && _attempt === 0) {
      this.invalidate();
      return this.api(method, path, { body, query, version, _attempt: 1 });
    }
    if (res.status === 429 && _attempt < 2) {
      await this.sleep(_attempt === 0 ? 2000 : 6000);
      return this.api(method, path, { body, query, version, _attempt: _attempt + 1 });
    }
    if (res.status === 204) return { ok: true };
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : { ok: true }; } catch { data = { raw: text.slice(0, 500) }; }
    // The scripts save endpoint reports validation results with 200/206/409
    // inside a `results` array; callers that want the report pass it through.
    if (!res.ok && res.status !== 206) {
      const msg = data.error_description || data.message || data.error || `HTTP ${res.status}`;
      throw new CxoneError(`${method} ${rel} failed: ${msg}`, res.status, data.error);
    }
    return data;
  }

  get(path, query, opts) { return this.api('GET', path, { query, ...opts }); }
  post(path, body, opts) { return this.api('POST', path, { body, ...opts }); }
  put(path, body, opts) { return this.api('PUT', path, { body, ...opts }); }
  patch(path, body, opts) { return this.api('PATCH', path, { body, ...opts }); }

  // Collect paged results. CXone pages with skip/top (default 50, max 100)
  // and names the payload array per resource (skills, agents, ...), so the
  // caller passes `key`. Some endpoints wrap the payload in `resultSet` and
  // return totalRecords as a STRING - both are normalized here. Caps at
  // `max` so a huge BU can't blow up a tool response.
  async listAll(path, key, query = {}, { max = 500 } = {}) {
    const out = [];
    let skip = 0;
    let total = null;
    for (;;) {
      const page = await this.get(path, { ...query, top: Math.min(100, max), skip });
      const reported = page.totalRecords ?? page.resultSet?.totalRecords;
      if (reported != null) total = Number(reported);
      const rows = page[key] || page.resultSet?.[key] || [];
      out.push(...rows);
      if (!rows.length || out.length >= max || (total != null && out.length >= total)) break;
      skip += rows.length;
    }
    return { entities: out.slice(0, max), total: total ?? out.length, truncated: total != null && total > Math.min(out.length, max) };
  }
}
