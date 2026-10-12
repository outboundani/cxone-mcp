// Redaction of integration secrets inside CXone Studio scripts (API keys,
// passwords and auth headers that customers store in script properties and
// snippets), applied to every CXone tool result: get_script, script_history,
// render_script and raw cxone_api_call reads. Best effort by design: do not
// keep live credentials in scripts.
//
// Shapes handled (each has a test in test/studio-redact.test.js):
//   JSON (web Studio)    properties as { name|key|propertyName, value|propertyValue } pairs: a
//                        secret looking name hides its value; a split assignment
//                        { name: 'Variable', value: 'apiToken' } plus { name: 'Value' |
//                        'Expression', value: '...' } hides the value pair. A string that is
//                        itself JSON (a REST action header list) is parsed and handled the same.
//   XML (Desktop Studio) Name/Key/PropertyName/Label elements or attributes with a Value/
//                        PropertyValue/Default/Expression, other elements in between, either
//                        quote, any case; <Property Name="Password">x</Property>;
//                        <Password>x</Password>; CDATA; split Variable/Expression assignments
//                        anywhere inside one ActionStruct; a value cut off by truncation;
//                        Text/Data value elements; XML that is itself entity escaped in a value.
//   Script text          restProxy.AddHeader("x-api-key", "x") and any call whose first string
//                        argument is a secret looking name (NiCE's own SNIPPET example);
//                        ASSIGN dbPassword = "x" + "y" (plain, JSON escaped, &quot; or &#34;
//                        escaped); Authorization: <scheme> x and X-Api-Key style headers, one
//                        token each so a later header on the same line is still seen;
//                        Password= / Pwd= in connection strings; ?api_token=x style queries;
//                        a backslash escaped quote inside a literal; a literal that is never
//                        closed runs to the end of its line.
//   base64 strings       GET scripts/{id} returns the XML base64 encoded; any base64 string of
//                        64+ characters (standard or url safe) under any key is decoded as UTF-8,
//                        UTF-16 (BOM) or Windows-1252, scanned and re-encoded when it changed.
//                        A `body` that cannot be decoded to text is withheld, never passed on.
//
// Everything here is linear in the input size: XML is tokenized with indexOf scans (no
// backtracking regex over the document), every text regex has bounded quantifiers, and
// text without any secret hint is not scanned.

// Key names that are secrets on their own (compared lower case, without _ - and spaces).
const SECRET_KEY = /token|secret|passw|credential|apikey|privatekey|signingkey|accesskey|secretkey|authorization|bearer|cookie|sessionid/;
const isSecretKey = (k) => SECRET_KEY.test(String(k).toLowerCase().replace(/[_\-\s]/g, ''));

const SECRET_NAME = /token|secret|passw|pwd|passcode|credential|apikey|privatekey|signingkey|accesskey|secretkey|clientsecret|subscriptionkey|authorization|authheader|bearer|cookie|sessionid|signature|connectionstring|connstr|^auth$|^key$|^pin$|^pw$|^pass$/;
// Names ending in key (authKey, appKey, hmacKey, sharedKey, stripeKey) are secrets, except
// these ordinary words and database or UI terms.
const NOT_SECRET_KEY = new Set(['primarykey', 'foreignkey', 'sortkey', 'hotkey', 'menukey', 'partitionkey', 'rowkey', 'monkey', 'turkey', 'hockey', 'donkey', 'whiskey', 'jockey', 'keykey', 'dtmfkey', 'presskey', 'anykey', 'lookupkey', 'cachekey', 'groupkey', 'idempotencykey']);
export const isSecretName = (n) => {
  if (typeof n !== 'string' || n.length > 200) return false;
  const raw = n.trim().toLowerCase();
  const norm = raw.replace(/[_\-\s.]/g, '');
  if (isSecretKey(n) || SECRET_NAME.test(norm)) return true;
  if (/(^|[._-])(pass|pw)$/.test(raw)) return true; // creds.pass, user_pw
  return /[a-z](key|keyid)$/.test(norm) && !NOT_SECRET_KEY.has(norm);
};
export const REDACTED = '[redacted]';
export const WITHHELD_BODY = '[redacted: script body could not be checked]';

// ---------- script text ----------

// A string quote in plain, JSON escaped or XML escaped (named or numeric) form.
const QA = '&quot;|&apos;|&#34;|&#x22;|&#39;|&#x27;|\\\\?"|\\\\?\'';
const Q = `(?:${QA})`;
// The value may hold backslash escaped quotes ("ab\\"cd"); a literal with no closing quote (cut by a
// truncation) runs to the end of the line, so a partial secret is still hidden.
const ASSIGN_QUOTED = new RegExp(`(\\b[A-Za-z_][\\w.]{0,80})(\\s{0,8}=\\s{0,8})(${QA})((?:\\\\[^\\r\\n]|[^\\r\\n]){0,4000}?)(\\3|(?=[\\r\\n]|$))`, 'g');
// After a redacted literal, further concatenated literals of the same statement: "a" + "b".
const CONCAT = new RegExp(`(\\[redacted\\](?:${QA}))(\\s{0,8}\\+\\s{0,8})(${QA})([^\\r\\n]{0,4000}?)(\\3)`, 'g');
// A backslash starts a JSON escaped quote (\"), never a bare value.
const ASSIGN_BARE = /(\bASSIGN\s{1,8})([A-Za-z_][\w.]{0,80})(\s{0,8}=\s{0,8})([^\s"'&;,\\]{1,4000})/gi;
// A call whose first string argument names a header or setting: proxy.AddHeader("x-api-key", "v").
const CALL = new RegExp(`(\\b[A-Za-z_][\\w.]{0,80}\\s{0,4}\\(\\s{0,4})(${QA})([^"'&\\\\\\r\\n]{1,200})(\\2)(\\s{0,4},\\s{0,4})(${QA})([^\\r\\n]{0,4000}?)(\\6|(?=[\\r\\n]|$))`, 'g');
// "Name: value" headers, only for names that contain a secret hint, value = one token (after an
// optional scheme word), so a non secret match never swallows a later header on the line.
const HEADER = new RegExp(`(\\b[\\w-]{0,30}(?:auth|key|token|secret|cookie|session|signature|pass|pwd|credential|bearer)[\\w-]{0,30})(${Q}?\\s{0,8}:\\s{0,8}${Q}?\\s{0,8})((?:[A-Za-z0-9-]{2,30} )?[^\\s"'\\r\\n,;}&\\\\]{1,4000})`, 'gi');
const CONN = /((?:^|[;\s"'?&{])(?:pwd|password|passwd|pass|secret|token|apikey|api_key|accountkey|sharedaccesskey|sharedaccesssignature)\s{0,8}=\s{0,8})([^\s;"'&\\][^;"'&\r\n]{0,4000})/gi;
// URL query parameters: ?api_token=x, &appKey=x, &pw=x.
const QUERY = /(\?|&amp;|&)([A-Za-z_][\w.-]{0,60})(=)([^&\s"'#<>]{1,4000})/g;
const SCHEMES = new Set(['basic', 'bearer', 'digest', 'token', 'negotiate', 'ntlm', 'hawk', 'apikey', 'ssws', 'aws4-hmac-sha256', 'oauth', 'mac']);
const keepScheme = (value) => {
  const [first, ...rest] = value.trim().split(/\s+/);
  return rest.length && SCHEMES.has(first.toLowerCase()) ? `${first} ` : '';
};

// Every secret name, header and connection string key above contains one of these
// fragments, so text without any of them needs no scan (one linear pass to decide).
const HINT = /token|secret|pass|pwd|\bpw\b|credential|key|auth|bearer|cookie|session|signature|conn|pin|header/i;

export function scrubStudioText(text) {
  if (typeof text !== 'string' || text.length < 4 || !HINT.test(text)) return text;
  let s = text;
  // An unterminated match that starts with [redacted] was already handled (a second pass over
  // rendered text): keep the rest of the line as is.
  const done = (v, close) => v === REDACTED || (close === '' && v.trimStart().replace(/^[A-Za-z0-9-]{2,30} /, '').startsWith(REDACTED));
  s = s.replace(CALL, (m, call, q1, name, q1b, comma, q2, value, q2b) => (isSecretName(name) && !done(value, q2b) ? `${call}${q1}${name}${q1b}${comma}${q2}${keepScheme(value)}${REDACTED}${q2b}` : m));
  s = s.replace(ASSIGN_QUOTED, (m, name, eq, q, v, q2) => (isSecretName(name) && !done(v, q2) ? `${name}${eq}${q}${REDACTED}${q2}` : m));
  for (let i = 0; i < 8; i++) {
    const next = s.replace(CONCAT, (m, head, plus, q, _v, q2) => `${head}${plus}${q}${REDACTED}${q2}`);
    if (next === s) break;
    s = next;
  }
  s = s.replace(ASSIGN_BARE, (m, kw, name, eq, v) => (isSecretName(name) && v !== REDACTED ? `${kw}${name}${eq}${REDACTED}` : m));
  s = s.replace(HEADER, (m, name, sep, value) => {
    if (!isSecretName(name) || value.trim() === REDACTED) return m;
    // "key": "Authorization" is a header list pair, not a header: the value names the header.
    if (/^(key|name)$/i.test(name) && isSecretName(value.trim())) return m;
    return `${name}${sep}${keepScheme(value)}${REDACTED}`;
  });
  s = s.replace(CONN, (m, k, v) => (v.trim() === REDACTED ? m : `${k}${REDACTED}`));
  s = s.replace(QUERY, (m, sep, name, eq, v) => (isSecretName(name) && v !== REDACTED ? `${sep}${name}${eq}${REDACTED}` : m));
  return s;
}

// ---------- pairs (shared by JSON and XML) ----------

export const TARGET_PAIR = /^(variable|variablename|var|name|key|target|header|headername|field)$/i;
export const VALUE_PAIR = /^(value|expression|text|data|headervalue|assignvalue|defaultvalue)$/i;
const IDENT = /^[A-Za-z_][\w.]{0,80}$/;
const isSecretTarget = (name, value) => TARGET_PAIR.test(name) && typeof value === 'string' && IDENT.test(value.trim()) && isSecretName(value.trim());

// ---------- XML (Desktop Studio) ----------

// Token kinds.
const TEXT = 1, CDATA = 2, OPEN = 3, SELF = 4, CLOSE = 5, OTHER = 6;
const isNameChar = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 58 || c === 46 || c === 45;

// Linear tokenizer (indexOf scans, no backtracking): tags, text, CDATA, comments, declarations.
function tokenize(s) {
  const kind = [], start = [], end = [], name = [];
  const n = s.length;
  let i = 0;
  const push = (k, a, b, nm = null) => { kind.push(k); start.push(a); end.push(b); name.push(nm); };
  while (i < n) {
    if (s.charCodeAt(i) !== 60) { // text up to the next "<"
      const j = s.indexOf('<', i);
      const e = j < 0 ? n : j;
      push(TEXT, i, e);
      i = e;
    } else if (s.startsWith('<![CDATA[', i)) {
      const j = s.indexOf(']]>', i + 9);
      const e = j < 0 ? n : j + 3;
      push(CDATA, i, e);
      i = e;
    } else if (s.startsWith('<!--', i)) {
      const j = s.indexOf('-->', i + 4);
      const e = j < 0 ? n : j + 3;
      push(OTHER, i, e);
      i = e;
    } else {
      const j = s.indexOf('>', i + 1);
      const e = j < 0 ? n : j + 1;
      let p = i + 1;
      const closing = s.charCodeAt(p) === 47; // "/"
      if (closing) p++;
      const ns = p;
      while (p < e && p - ns < 100 && isNameChar(s.charCodeAt(p))) p++;
      const first = s.charCodeAt(ns);
      if (p === ns || !((first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95)) push(OTHER, i, e);
      else push(closing ? CLOSE : s.charCodeAt(e - 2) === 47 ? SELF : OPEN, i, e, s.slice(ns, p));
      i = e;
    }
  }
  return { kind, start, end, name };
}

// Pair layouts: the element or attribute that names a pair, and the ones that hold its value.
const NAME_LOCALS = new Set(['name', 'key', 'propertyname', 'paramname', 'label']);
const VALUE_LOCALS = new Set(['value', 'propertyvalue', 'defaultvalue', 'default', 'expression', 'text', 'data']);
const NAME_ATTRS = ['name', 'key', 'propertyname', 'paramname', 'label'];
const VALUE_ATTRS = ['value', 'propertyvalue', 'defaultvalue', 'default', 'expression', 'text', 'data'];
const ATTR = /(\s)([A-Za-z_][\w:.-]{0,100})(\s{0,8}=\s{0,8})("[^"]{0,4000}"|'[^']{0,4000}')/g;
const NO_ATTRS = new Map();
const localName = (n) => { const k = n.lastIndexOf(':'); return (k < 0 ? n : n.slice(k + 1)).toLowerCase(); };

// XML stored entity escaped inside a value (<Value>&lt;Password&gt;x&lt;/Password&gt;</Value>):
// unescaped, scanned as XML and text, and escaped again when something changed.
const unescapeXml = (t) => t.replace(/&(lt|gt|quot|apos|amp);/g, (m, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]);
const escapeXml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function redactEscapedXml(raw, depth) {
  if (depth >= 3 || !raw.includes('&lt;') || !HINT.test(raw)) return raw;
  const un = unescapeXml(raw);
  const out = scrubStudioText(redactStudioXml(un, depth + 1));
  return out === un ? raw : escapeXml(out);
}

export function redactStudioXml(xml, depth = 0) {
  const s = String(xml);
  const T = tokenize(s);
  const count = T.kind.length;

  // Elements: name, token, attributes (parsed only when the tag has an "="), children, text tokens.
  const root = { name: '#root', local: '', children: [], texts: [], action: null };
  const stack = [root];
  const elems = [];
  let nextEq = -1; // position of the next "=" at or after the current tag (monotonic, so linear)
  for (let i = 0; i < count; i++) {
    const k = T.kind[i];
    const top = stack[stack.length - 1];
    if (k === OPEN || k === SELF) {
      if (nextEq !== Infinity && nextEq < T.start[i]) { const q = s.indexOf('=', T.start[i]); nextEq = q < 0 ? Infinity : q; }
      let attrs = NO_ATTRS;
      if (nextEq < T.end[i]) {
        attrs = new Map();
        for (const m of s.slice(T.start[i], T.end[i]).matchAll(ATTR)) attrs.set(m[2].toLowerCase(), m[4].slice(1, -1));
      }
      const el = { name: T.name[i], local: localName(T.name[i]), tok: i, children: [], texts: [], attrs, pair: undefined, action: top.local === 'actionstruct' ? top : top.action };
      top.children.push(el);
      elems.push(el);
      if (k === OPEN) stack.push(el);
    } else if (k === CLOSE) {
      let d = stack.length - 1;
      while (d > 0 && stack.length - d < 64 && stack[d].name !== T.name[i]) d--;
      if (d > 0 && stack[d].name === T.name[i]) stack.length = d; // pop to the match (64 levels at most), else ignore
    } else if (k === TEXT || k === CDATA) {
      top.texts.push(i);
    }
  }

  const tokText = (i) => {
    if (T.kind[i] !== CDATA) return s.slice(T.start[i], T.end[i]);
    const closed = s.startsWith(']]>', T.end[i] - 3) && T.end[i] - 3 >= T.start[i] + 9;
    return s.slice(T.start[i] + 9, closed ? T.end[i] - 3 : T.end[i]);
  };
  const textOf = (el) => (el.texts.length === 1 ? tokText(el.texts[0]) : el.texts.map(tokText).join('')).trim();
  const hideTexts = new Set();
  const hideAttrs = new Map(); // token index -> Set of lower case attribute names
  const hideAttr = (el, a) => { if (!hideAttrs.has(el.tok)) hideAttrs.set(el.tok, new Set()); hideAttrs.get(el.tok).add(a); };
  const hideContent = (el) => { for (const i of el.texts) hideTexts.add(i); };

  // The (name, value) pair an element stands for, if any; computed once per element.
  // v is read lazily: only a target pair (Variable, Name, Key, ...) needs its value.
  const pairOf = (el) => {
    if (el.pair !== undefined) return el.pair;
    let p = null;
    let an;
    for (const a of NAME_ATTRS) if (el.attrs.has(a)) { an = el.attrs.get(a); break; }
    if (an !== undefined) {
      const va = VALUE_ATTRS.find((a) => el.attrs.has(a));
      p = { n: an, v: () => (va ? el.attrs.get(va) : textOf(el)), hide: () => { for (const a of VALUE_ATTRS) if (el.attrs.has(a)) hideAttr(el, a); hideContent(el); } };
    } else if (el.children.length) {
      let nameEl = null;
      const valueEls = [];
      for (const c of el.children) {
        if (!nameEl && NAME_LOCALS.has(c.local)) nameEl = c;
        else if (VALUE_LOCALS.has(c.local)) valueEls.push(c);
      }
      if (nameEl) p = { n: textOf(nameEl), v: () => valueEls.map(textOf).join(''), hide: () => { for (const v of valueEls) hideContent(v); } };
    }
    el.pair = p;
    return p;
  };

  const byAction = new Map(); // nearest ActionStruct -> its pairs (a split assignment may span containers)
  for (const el of elems) {
    // Secret looking element: <Password>x</Password>
    if (el.texts.length && isSecretName(el.local)) hideContent(el);
    // Secret looking attributes other than the pair keys and values: <Conn Password="x">
    if (el.attrs.size) for (const a of el.attrs.keys()) if (!NAME_ATTRS.includes(a) && !VALUE_ATTRS.includes(a) && isSecretName(a)) hideAttr(el, a);
    // A pair with a secret looking name.
    const p = pairOf(el);
    if (p && isSecretName(p.n)) p.hide();
    if (p && el.action) { if (!byAction.has(el.action)) byAction.set(el.action, []); byAction.get(el.action).push(p); }
    // A split assignment among the pairs of one block: Variable apiToken + Expression x.
    if (el.children.length >= 2) {
      let target = false;
      for (const c of el.children) { const q = pairOf(c); if (q && TARGET_PAIR.test(q.n) && isSecretTarget(q.n, q.v())) { target = true; break; } }
      if (target) for (const c of el.children) { const q = pairOf(c); if (q && VALUE_PAIR.test(q.n)) q.hide(); }
    }
  }
  for (const pairs of byAction.values()) {
    if (pairs.length >= 2 && pairs.some((q) => TARGET_PAIR.test(q.n) && isSecretTarget(q.n, q.v()))) for (const q of pairs) if (VALUE_PAIR.test(q.n)) q.hide();
  }

  const escaped = new Map(); // text token -> its redacted entity escaped XML
  for (let i = 0; i < count; i++) {
    if (T.kind[i] !== TEXT || hideTexts.has(i)) continue;
    const raw = s.slice(T.start[i], T.end[i]);
    const r = redactEscapedXml(raw, depth);
    if (r !== raw) escaped.set(i, r);
  }
  if (!hideTexts.size && !hideAttrs.size && !escaped.size) return s;
  const parts = [];
  for (let i = 0; i < count; i++) {
    const raw = s.slice(T.start[i], T.end[i]);
    if (escaped.has(i)) {
      parts.push(escaped.get(i));
    } else if (hideTexts.has(i) && raw.trim()) {
      parts.push(T.kind[i] === CDATA ? `<![CDATA[${REDACTED}]]>` : REDACTED);
    } else if (hideAttrs.has(i)) {
      const names = hideAttrs.get(i);
      parts.push(raw.replace(ATTR, (m, sp, nm, eq, val) => (names.has(nm.toLowerCase()) ? `${sp}${nm}${eq}${val[0]}${REDACTED}${val[0]}` : m)));
    } else {
      parts.push(raw);
    }
  }
  return parts.join('');
}

// ---------- base64 strings ----------

const looksXml = (s) => /^\s*(?:﻿)?\s*<[?!A-Za-z]/.test(s) || /<[A-Za-z][\w:.-]{0,60}[\s>/]/.test(s.slice(0, 1024));
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export function decodeText(bytes) {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
  } catch { return null; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('windows-1252').decode(bytes); } catch { return null; }
}

const isTextual = (t) => {
  let bad = 0;
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if ((c < 9) || (c > 13 && c < 32)) bad++; }
  return bad <= t.length / 100;
};

function encodeB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const scanText = (text) => {
  if (looksXml(text)) return scrubStudioText(redactStudioXml(text));
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { const parsed = JSON.parse(t); const out = JSON.stringify(redactStudio(parsed)); return out === JSON.stringify(parsed) ? text : out; } catch { /* not JSON */ }
  }
  return scrubStudioText(text);
};

// A base64 (standard or url safe) string: decoded to text, scanned, and re-encoded in the same
// alphabet when the scan changed something. Returns undefined when the string is not base64
// text. With withhold (the `body` of a script read), a base64 string of 64+ characters that is
// not text is replaced with WITHHELD_BODY instead of being passed through unchecked.
export function redactBase64Body(v, { withhold = true } = {}) {
  if (typeof v !== 'string') return undefined;
  const url = !/[+/]/.test(v) && /[-_]/.test(v);
  if (!(url ? /^[A-Za-z0-9_\-=\r\n]+$/ : /^[A-Za-z0-9+/=\r\n]+$/).test(v)) return undefined;
  let compact = v.replace(/\s+/g, '');
  if (compact.length < 16 || !(url ? B64URL : B64).test(compact)) return undefined;
  if (url) compact = compact.replace(/-/g, '+').replace(/_/g, '/');
  while (compact.length % 4) compact += '=';
  const refuse = () => (withhold && compact.length >= 64 ? WITHHELD_BODY : undefined);
  let bytes;
  try { bytes = Uint8Array.from(atob(compact), (c) => c.charCodeAt(0)); } catch { return refuse(); }
  const text = decodeText(bytes);
  if (text === null || !isTextual(text)) return refuse();
  const scanned = scanText(text);
  if (scanned === text) return v;
  const b = encodeB64(scanned);
  return url ? b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b;
}

// ---------- JSON results ----------

const PAIR_NAME_KEYS = ['name', 'Name', 'key', 'Key', 'propertyName', 'PropertyName'];
const PAIR_VALUE_KEYS = ['value', 'Value', 'propertyValue', 'PropertyValue', 'defaultValue', 'DefaultValue'];
const pairOf = (p) => {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const nk = PAIR_NAME_KEYS.find((k) => typeof p[k] === 'string');
  if (!nk) return null;
  const vk = PAIR_VALUE_KEYS.find((k) => Object.hasOwn(p, k));
  return { n: p[nk], v: vk ? p[vk] : undefined };
};
function redactPairValue(p) {
  const o = { ...p };
  for (const k of PAIR_VALUE_KEYS) if (Object.hasOwn(o, k) && o[k] !== null && o[k] !== '') o[k] = REDACTED;
  return o;
}
function splitAssignTarget(container) {
  const pairs = (Array.isArray(container) ? container : Object.values(container)).map(pairOf).filter(Boolean);
  return pairs.length >= 2 && pairs.some((p) => isSecretTarget(p.n, p.v));
}

export function redactStudio(value, depth = 0) {
  if (depth > 64) return value;
  if (typeof value === 'string') {
    if (value.length >= 64) { const b = redactBase64Body(value, { withhold: false }); if (b !== undefined) return b; }
    if (value.length < 1e6) { const t = value.trim(); if (t.startsWith('{') || t.startsWith('[')) return scanText(value); }
    return scrubStudioText(looksXml(value) ? redactStudioXml(value) : value);
  }
  if (Array.isArray(value)) {
    const split = splitAssignTarget(value);
    return value.map((v) => (split && VALUE_PAIR.test(pairOf(v)?.n ?? '') ? redactPairValue(v) : redactStudio(v, depth + 1)));
  }
  if (!value || typeof value !== 'object') return value;
  if (splitAssignTarget(value)) {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = VALUE_PAIR.test(pairOf(v)?.n ?? '') ? redactPairValue(v) : redactStudio(v, depth + 1);
    return o;
  }
  const out = {};
  const pair = pairOf(value);
  const secretPair = pair !== null && isSecretName(pair.n);
  for (const [k, v] of Object.entries(value)) {
    if (secretPair && PAIR_VALUE_KEYS.includes(k) && v !== null && v !== '') { out[k] = REDACTED; continue; }
    // { "Authorization": "Basic x" } and other secret looking keys (a header object stored as JSON).
    if (typeof v === 'string' && v !== '' && !PAIR_NAME_KEYS.includes(k) && isSecretName(k)) { out[k] = `${keepScheme(v)}${REDACTED}`; continue; }
    if ((k === 'body' || k === 'Body') && typeof v === 'string') {
      const b = redactBase64Body(v, { withhold: true });
      if (b !== undefined) { out[k] = b; continue; }
    }
    out[k] = redactStudio(v, depth + 1);
  }
  return out;
}

// Standard base64 to text (UTF-8, UTF-16 with a BOM, or Windows-1252), or null
// when it is not base64 text. Used for Desktop Studio script bodies.
export function decodeBase64Text(b64) {
  if (typeof b64 !== 'string' || !b64) return '';
  let bytes;
  try { bytes = Uint8Array.from(atob(b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0)); } catch { return null; }
  const text = decodeText(bytes);
  return text !== null && isTextual(text) ? text : null;
}

// True when a value carries a redaction marker from this module. Saving such
// content back would overwrite the real secret with the marker.
export function containsRedaction(value, depth = 0) {
  if (typeof value === 'string') return value.includes('[redacted');
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some((v) => containsRedaction(v, depth + 1));
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => k.includes('[redacted') || containsRedaction(v, depth + 1));
  return false;
}
