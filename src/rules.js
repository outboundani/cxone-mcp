// Pure safety rails for the raw API tool (cxone_api_call). No I/O here, so
// everything that decides "is this allowed / what gets sent" is unit tested
// in test/rules.test.js.
//
// The pattern is normalize-then-allowlist. CXone builds the request URL with
// `new URL(...)`, which resolves dot segments, and the server decodes %XX
// before routing. A regex on the raw path string is therefore not a guard:
// "skills/1/../1/start" reads as harmless and lands on skills/1/start. So:
//   1. refuse anything the URL parser or the server could read differently
//      than we do (encoding, dot segments, empty segments, ?, #, ;, \),
//   2. validate the version and query instead of trusting them,
//   3. refuse the ignition and live-contact families outright,
//   4. allow writes only on the resource families the typed tools build,
//   5. deep-scan bodies and query for ignition keys (startSkill and kin).

export const VERSION_RE = /^v\d{2}\.\d$/;
export const DEFAULT_VERSION = 'v30.0';

// Numeric ids everywhere in the ACD Admin API, plus GUIDs for the few
// resources that carry them.
const ID = '(?:\\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const R = (s) => new RegExp(`^${s.replace(/\{id\}/g, ID)}$`, 'i');

// Writes (POST/PUT/PATCH) are allowed only on these templates: the same
// families the typed tools touch, checked against the vendored swagger in
// specs-reference/. Anything else is refused - including skills/{id}/stop,
// scripts/kick, */status toggles, suppressed-contact, and every DELETE.
const SKILL_PARAMS = '(?:general-settings|retry-settings|schedule-settings|cadence-settings|time-zones|delivery-preferences|cpa-management|xs-settings)';
const WRITES = [
  [['POST'], 'skills'],
  [['PUT'], 'skills/{id}'],
  [['PUT'], `skills/{id}/parameters/${SKILL_PARAMS}`],
  [['POST', 'PUT'], 'skills/{id}/agents'],
  [['POST', 'PUT'], 'agents/{id}/skills'],
  [['POST'], 'campaigns'],
  [['PUT'], 'campaigns/{id}'],
  [['POST'], 'campaigns/{id}/skills'],
  [['POST'], 'teams'],
  [['PUT'], 'teams/{id}'],
  [['POST'], 'teams/{id}/agents'],
  [['POST'], 'dispositions'],
  [['PUT'], 'dispositions/{id}'],
  [['POST'], 'hours-of-operation'],
  [['PUT'], 'hours-of-operation/{id}'],
  [['POST'], 'points-of-contact'],
  [['PUT'], 'points-of-contact/{id}'],
  [['POST'], 'unavailable-codes'],
  [['PUT'], 'unavailable-codes/{id}'],
  [['POST'], 'address-books'],
  [['POST', 'PUT'], 'address-books/{id}/entries'],
  [['POST'], 'address-books/{id}/assignment'],
  [['POST'], 'dnc-groups'],
  [['PUT'], 'dnc-groups/{id}'],
  [['POST'], 'dnc-groups/{id}/records'],
  [['POST'], 'dnc-groups/{id}/scrubbed-skills/{id}'],
  [['POST'], 'dnc-groups/{id}/contributing-skills/{id}'],
  [['POST'], 'lists/call-lists'],
  [['POST'], 'lists/call-lists/{id}/upload'],
  [['POST'], 'scripts'],
].map(([methods, p]) => [methods, R(p)]);

export const WRITE_FAMILIES = 'skills (create, update, dialer parameters, agent assignment), agents/{id}/skills, campaigns (create, update, attach skills), teams, dispositions, hours-of-operation, points-of-contact, unavailable-codes, address-books (create, entries, assignment), dnc-groups (create, records, scrubbed/contributing skills), lists/call-lists (create, upload), and scripts (save only)';

// Keys that can switch a skill on or start dialing. Compared after
// lowercasing and dropping _ and -, so StartSkill / start_skill / startskill
// all match. The only acceptable value is the boolean false.
const IGNITION_KEYS = new Set(['startskill', 'isrunning', 'running', 'isnaturalcallingrunning', 'autostart', 'start', 'startnow', 'startdialing', 'startonupload']);
const normKey = (k) => String(k).toLowerCase().replace(/[_-]/g, '');
export const isIgnitionKey = (k) => IGNITION_KEYS.has(normKey(k));

// Secret-looking fields scrubbed from raw responses.
const SECRET_KEY = /passw|pwd|secret|token|accesskey|apikey|credential/;
const isSecretKey = (k) => SECRET_KEY.test(normKey(k));

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = isSecretKey(k) && v !== null && v !== '' ? '[redacted]' : redactSecrets(v);
  return out;
}

const MAX_DEPTH = 64;

// Walks the whole body. Returns { ignition: [paths], caseDupes: bool, tooDeep: bool }.
function scanBody(value) {
  const found = { ignition: [], caseDupes: false, tooDeep: false };
  const walk = (v, where, depth) => {
    if (depth > MAX_DEPTH) { found.tooDeep = true; return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`, depth + 1)); return; }
    if (!v || typeof v !== 'object') return;
    const keys = Object.keys(v);
    const lowered = keys.map((k) => k.toLowerCase());
    if (new Set(lowered).size !== lowered.length) found.caseDupes = true;
    for (const k of keys) {
      const here = where ? `${where}.${k}` : k;
      if (isIgnitionKey(k) && v[k] !== false) found.ignition.push(here);
      walk(v[k], here, depth + 1);
    }
  };
  walk(value, '', 0);
  return found;
}

const refuse = (message) => ({ ok: false, message });

// Validates a raw call. Returns { ok: true, method, path, version, query }
// with the exact values to send, or { ok: false, message } to refuse.
// Nothing is sent unless this says ok.
export function checkRawCall({ method, path, query, body, version } = {}) {
  const m = String(method ?? '').toUpperCase();
  if (m === 'DELETE') return refuse('Refused: this server ships no deletes, and the raw tool refuses DELETE by design.');
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(m)) return refuse(`Refused: method ${m || '(none)'} is not allowed. Use GET, POST, PUT, or PATCH.`);

  // 1. Version: a plain vNN.N, or refused. It is spliced into the URL path,
  // so anything else is an injection point.
  const ver = version === undefined || version === null || version === '' ? DEFAULT_VERSION : version;
  if (typeof ver !== 'string' || !VERSION_RE.test(ver)) return refuse(`Refused: version must look like v30.0 or v33.0 (got ${JSON.stringify(version)}).`);

  // 2. Path: validate BEFORE any URL is built.
  if (typeof path !== 'string' || !path) return refuse('Refused: path is required.');
  if (/[%;\\#?]/.test(path)) return refuse('Refused: the path may not contain %, ;, \\, #, or ? - pass query parameters in `query`.');
  if (/\s/.test(path)) return refuse('Refused: the path may not contain whitespace.');
  const rel = path.startsWith('/') ? path.slice(1) : path;
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return refuse('Refused: empty, "." and ".." path segments are not allowed.');
  // Plain segments only: letters, digits, _ and -, with dots only between
  // them (no trailing dots, which some servers strip before routing).
  if (segments.some((s) => !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(s))) return refuse('Refused: path segments may only contain letters, digits, _, -, and inner dots.');
  const lower = segments.map((s) => s.toLowerCase());

  // 3. Hard refusals, every method.
  if (lower.includes('start') || (lower[0] === 'skills' && lower.some((s) => s.includes('start')))) {
    return refuse('Refused: this server never starts outbound dialing or spawns script runs (skills/{id}/start, scripts/start). A human presses go in CXone.');
  }
  if (['contacts', 'interactions', 'agent-sessions'].includes(lower[0])) {
    return refuse('Refused: live-contact control (contacts/*, interactions/*, agent-sessions/*) is out of scope for this server by design.');
  }

  // 4. Query: plain identifier keys, no case-insensitive duplicates,
  // scalar values only (stringified here so what we check is what we send).
  if (query !== undefined && query !== null && (typeof query !== 'object' || Array.isArray(query))) return refuse('Refused: query must be an object of name/value pairs.');
  const q = query || {};
  const qkeys = Object.keys(q);
  if (qkeys.some((k) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(k))) return refuse('Refused: query parameter names must be plain identifiers (letters, digits, _).');
  const qlower = qkeys.map((k) => k.toLowerCase());
  if (new Set(qlower).size !== qlower.length) return refuse('Refused: duplicate query parameters (including case variants) are not allowed.');
  const sendQuery = {};
  for (const k of qkeys) {
    const v = q[k];
    if (v !== null && typeof v === 'object') return refuse(`Refused: query value for ${k} must be a single scalar, not an object or array.`);
    if (v === undefined || v === null || v === '') continue;
    if (isIgnitionKey(k) && v !== false && v !== 'false') return refuse(`Refused: query parameter ${k} can start dialing - it may only be false. A human starts skills in CXone.`);
    sendQuery[k] = String(v);
  }

  // 5. Body: objects only, and never on GET.
  if (body !== undefined && body !== null) {
    if (m === 'GET') return refuse('Refused: GET calls take no body - use `query`.');
    if (typeof body !== 'object' || Array.isArray(body)) return refuse('Refused: the body must be a single JSON object.');
  }
  const scan = scanBody(body ?? {});
  if (scan.tooDeep) return refuse(`Refused: the body is nested more than ${MAX_DEPTH} levels deep.`);
  if (scan.caseDupes) return refuse('Refused: the body repeats a field name with different casing - ambiguous to the server\'s binder.');
  if (scan.ignition.length) {
    return refuse(`Refused: ${[...new Set(scan.ignition)].join(', ')} can start dialing - the only accepted value is boolean false. A human starts skills in CXone.`);
  }

  // 6. Allowlist. GETs may read any path that survived the checks above;
  // writes only hit the templates the typed tools use.
  if (m !== 'GET') {
    const allowed = WRITES.some(([methods, r]) => methods.includes(m) && r.test(rel));
    if (!allowed) return refuse(`Refused: ${m} ${rel} is not on the raw tool's write allowlist. Writes are limited to the families the typed tools build: ${WRITE_FAMILIES}. Deletes, starts, live contacts, users, and credentials are out of scope.`);
    // Call-list uploads must say startSkill false out loud.
    if (/^lists\/call-lists\/[^/]+\/upload$/i.test(rel)) {
      const key = Object.keys(body || {}).find((k) => normKey(k) === 'startskill');
      if (!key || body[key] !== false) return refuse('Refused: call-list uploads through the raw tool must carry startSkill: false explicitly - records land staged and a human starts the skill.');
    }
  }

  return { ok: true, method: m, path: rel, version: ver, query: sendQuery };
}
