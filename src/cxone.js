// NiCE CXone API client - zero-dependency, with module-level token caching
// and automatic tenant discovery: an access key pair is all it needs. The
// token's own claims name the tenant, and the public well-known endpoint
// maps the tenant to its regional API host.

export class CxoneError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'CxoneError';
    this.status = status;
    this.code = code;
  }
}

// Global User Hub auth hosts, tried in order. Auth is global (any of these
// issues tokens for any tenant); API calls are regional (discovered).
const AUTH_HOSTS = [
  'https://na1.nice-incontact.com',
  'https://cxone.niceincontact.com',
];

const ACD_VERSION = 'v30.0';

function decodeJwt(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64));
  } catch { return null; }
}

// accessKeyId → { token, refreshToken, exp (ms), apiBase, tenant, busNo }
const sessionCache = new Map();

export class CxoneClient {
  constructor({ accessKeyId, accessKeySecret, apiBase }) {
    this.accessKeyId = accessKeyId;
    this.accessKeySecret = accessKeySecret;
    this.apiBaseOverride = apiBase || '';
  }

  async session() {
    const cached = sessionCache.get(this.accessKeyId);
    if (cached && cached.exp > Date.now()) return cached;

    let lastErr = null;
    for (const host of AUTH_HOSTS) {
      try {
        const res = await fetch(`${host}/authentication/v1/token/access-key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessKeyId: this.accessKeyId, accessKeySecret: this.accessKeySecret }),
        });
        if (!res.ok) {
          const body = (await res.text()).slice(0, 200);
          lastErr = new CxoneError(
            `CXone login failed (HTTP ${res.status}) at ${host}: ${body}. ` +
            'Check the Access Key ID/Secret (Admin > Employees > your user > Security > Add Access Key).',
            res.status
          );
          continue;
        }
        const data = await res.json();
        const claims = decodeJwt(data.id_token) || decodeJwt(data.access_token) || {};
        const session = {
          token: data.access_token,
          refreshToken: data.refresh_token,
          // Refresh 5 minutes early (tokens live 1h).
          exp: Date.now() + Math.max(60, (data.expires_in || 3600) - 300) * 1000,
          tenant: claims.tenant || '',
          tenantId: claims.tenantId || '',
          busNo: claims.icBUId || null,
          cluster: claims.icClusterId || '',
          role: claims.role?.legacyId || '',
          apiBase: this.apiBaseOverride,
        };
        if (!session.apiBase) session.apiBase = await this.discoverApiBase(session);
        sessionCache.set(this.accessKeyId, session);
        return session;
      } catch (e) {
        lastErr = e instanceof CxoneError ? e : new CxoneError(`CXone login failed at ${host}: ${e.message}`, 0);
      }
    }
    throw lastErr || new CxoneError('CXone login failed: no auth host reachable', 0);
  }

  // Tenant → regional API host, via the public well-known endpoint; falls
  // back to deriving the host from the cluster id in the token claims.
  async discoverApiBase(session) {
    if (session.tenantId) {
      try {
        const res = await fetch(`https://cxone.niceincontact.com/.well-known/cxone-configuration?tenantId=${session.tenantId}`);
        if (res.ok) {
          const cfg = await res.json();
          if (cfg.api_endpoint) return cfg.api_endpoint.replace(/\/+$/, '');
        }
      } catch { /* fall through to cluster derivation */ }
    }
    if (session.cluster) return `https://api-${session.cluster.toLowerCase()}.nice-incontact.com`;
    throw new CxoneError('Could not discover the CXone API endpoint - set CXONE_API_BASE explicitly.', 500);
  }

  invalidate() {
    sessionCache.delete(this.accessKeyId);
  }

  // Core request helper for the ACD Admin API. `path` is relative to
  // /inContactAPI/services/vXX.0/ (e.g. "skills" or "scripts/search").
  // Retries once on 401 (stale token) and backs off twice on 429 (CXone
  // sends no reliable Retry-After, so exponential: 2s then 6s).
  async api(method, path, { body, query, version, _attempt = 0 } = {}) {
    const s = await this.session();
    const rel = String(path).replace(/^\/+/, '');
    const url = new URL(`${s.apiBase}/inContactAPI/services/${version || ACD_VERSION}/${rel}`);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
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
      await new Promise((r) => setTimeout(r, _attempt === 0 ? 2000 : 6000));
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
