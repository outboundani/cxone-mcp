// Studio script secret redaction: unit shapes (src/studio-redact.js) and the
// tool paths that return script content (get_script, render_script,
// script_history, cxone_api_call). Mocked fetch only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/tools.js';
import { checkRawCall } from '../src/rules.js';
import { redactStudio, redactStudioXml, scrubStudioText, isSecretName, containsRedaction } from '../src/studio-redact.js';
import { makeCxone } from './fake-cxone.js';

const b64 = (s, enc = 'utf8') => Buffer.from(s, enc).toString('base64');
const fromB64 = (s) => Buffer.from(s, 'base64').toString('utf8');

// ---------- web Studio JSON ----------

const SCRIPT_JSON = {
  header: { scriptName: 'Main' },
  actions: { 1: { name: 'SNIPPET', label: 'Setup' }, 2: { name: 'REST', label: 'Call CRM' }, 3: { name: 'ASSIGN', label: 'Key' } },
  properties: {
    0: {
      0: { name: 'Password', value: 'hunter2pass' }, 1: { name: 'ApiKey', value: 'k-9f8e7d6c' }, 2: { name: 'Authorization', value: 'Basic dXNlcjpwYXNz' },
      3: { name: 'client_secret', value: 'cs-1x' }, 4: { name: 'X-Auth-Token', value: 'tok-2x' }, 5: { name: 'Phrase', value: 'Thanks for calling' }, 6: { name: 'URL', value: 'https://crm.example.com/api' },
    },
    1: { 0: { name: 'Text', value: 'ASSIGN dbPassword = "dbpw-111"\nASSIGN myToken = \'tok-99887766\'\nASSIGN greeting = "hello"\nrestProxy.AddHeader("x-api-key", "asdf-nice")\nproxy.AddHeader("Content-Type", "application/json")' } },
    2: {
      0: { name: 'Headers', value: '{"Authorization":"Basic dXNlcjpwYXNzd29yZA=="}' },
      1: { name: 'HeaderList', value: '[{"key":"Authorization","value":"Basic hl-secret-1"}]' },
      2: { name: 'HeaderBlock', value: 'Authorization: Bearer xyz-bearer-123\nX-Api-Key: k-header-456\nAccept: application/json' },
      3: { name: 'Db', value: 'Server=db.example.com;User Id=svc;Pwd=s3cr3t-conn;' },
      4: { name: 'Url', value: 'https://x.example/a?api_token=q-secret-1&page=2' },
    },
    3: { 0: { name: 'Variable', value: 'apiToken' }, 1: { name: 'Value', value: 'sk-live-split' } },
  },
};
const JSON_LEAKS = ['hunter2pass', 'k-9f8e7d6c', 'dXNlcjpwYXNz', 'cs-1x', 'tok-2x', 'dbpw-111', 'tok-99887766', 'asdf-nice', 'hl-secret-1',
  'xyz-bearer-123', 'k-header-456', 's3cr3t-conn', 'q-secret-1', 'sk-live-split'];

test('get_script redacts secrets in web Studio properties, snippets, headers and split assignments', async () => {
  const fake = makeCxone({ scripts: ['Main'], scriptJson: SCRIPT_JSON });
  const out = await callTool(fake.cfg, 'get_script', { script: 'Main' });
  const text = JSON.stringify(out);
  for (const s of JSON_LEAKS) assert.ok(!text.includes(s), s);
  const props = out.script.properties;
  assert.equal(props[0][5].value, 'Thanks for calling');
  assert.equal(props[0][6].value, 'https://crm.example.com/api');
  assert.equal(props[3][0].value, 'apiToken', 'the variable name stays');
  assert.match(text, /ASSIGN greeting = \\"hello\\"/);
  assert.match(text, /AddHeader\(\\"Content-Type\\", \\"application\/json\\"\)/, 'a non secret header stays');
  assert.match(text, /Accept: application\/json/);
  assert.match(text, /Pwd=\[redacted\]/);
  assert.match(text, /page=2/);
  assert.equal(JSON.parse(props[2][1].value)[0].key, 'Authorization', 'the header name stays');
});

test('script_history and the raw tool get the same redaction', async () => {
  const hist = makeCxone({ scripts: ['Main'], raw: { 'GET scripts/historyByName': { scriptHistory: [{ version: 2, note: 'rotated: ASSIGN apiKey = "hist-secret"' }] } } });
  const h = JSON.stringify(await callTool(hist.cfg, 'script_history', { script: 'Main' }));
  assert.ok(!h.includes('hist-secret'));
  const raw = makeCxone({ raw: { 'GET scripts': SCRIPT_JSON } });
  const viaRaw = JSON.stringify(await callTool(raw.cfg, 'cxone_api_call', { method: 'GET', path: 'scripts', query: { scriptPath: 'Main' } }));
  for (const s of JSON_LEAKS) assert.ok(!viaRaw.includes(s), `raw: ${s}`);
  assert.match(viaRaw, /Thanks for calling/);
});

// ---------- Desktop Studio XML ----------

const SECRETS_XML = ['hunter2pass', 'sk-live-split', 'cdata-secret', 'gap-secret', 'single-q', 'lower-case', 'attr-split', 'el-secret', 'esc-secret', 'text-secret'];
const DESKTOP_XML = '<Script><ActionStruct><ActionID>1</ActionID><Action>ASSIGN</Action><Caption>Set key</Caption>'
  + '<PropertyStruct><Name>Variable</Name><Value>apiToken</Value></PropertyStruct>'
  + '<PropertyStruct><Name>Expression</Name><Value>sk-live-split</Value></PropertyStruct></ActionStruct>'
  + '<ActionStruct><Action>ASSIGN</Action><Property Name="Variable" Value="crmSecret"/><Property Name="Expression" Value="attr-split"/></ActionStruct>'
  + '<ActionStruct><Action>REST</Action><Property Name="Password"><![CDATA[cdata-secret]]></Property>'
  + '<PropertyStruct><Name>Password</Name><Type>String</Type><Hint>x</Hint><Value>gap-secret</Value></PropertyStruct>'
  + "<Property Name='Token' Value='single-q'/><property name=\"apikey\" value=\"lower-case\"/>"
  + '<PropertyStruct><Name>Secret</Name><Value>hunter2pass</Value></PropertyStruct><Password>el-secret</Password>'
  + '<Param><Name>apiKey</Name><Text>text-secret</Text></Param>'
  + '<Value>&lt;Password&gt;esc-secret&lt;/Password&gt;</Value>'
  + '<PropertyStruct><Name>Phrase</Name><Value>Hello caller</Value></PropertyStruct><Caption>Password prompt</Caption></ActionStruct></Script>';

test('Desktop XML pairs, CDATA, sibling gaps, attribute quoting, split assignments and escaped XML are redacted', () => {
  const out = redactStudioXml(DESKTOP_XML);
  for (const s of SECRETS_XML) assert.ok(!out.includes(s), s);
  assert.match(out, /<Name>Variable<\/Name><Value>apiToken<\/Value>/, 'the variable name stays');
  assert.match(out, /<Value>Hello caller<\/Value>/);
  assert.match(out, /<Caption>Password prompt<\/Caption>/);
});

test('get_script (XML fallback) and a raw base64 body are redacted; the secret is gone before truncation', async () => {
  const fake = makeCxone({ scripts: ['Legacy'], scriptXml: DESKTOP_XML });
  const viaTool = await callTool(fake.cfg, 'get_script', { script: 'Legacy' });
  assert.equal(viaTool.format, 'xml');
  for (const s of SECRETS_XML) assert.ok(!viaTool.xml.includes(s), `get_script: ${s}`);
  const raw = makeCxone({ raw: { 'GET scripts/3': { body: b64(DESKTOP_XML) } } });
  const decoded = fromB64((await callTool(raw.cfg, 'cxone_api_call', { method: 'GET', path: 'scripts/3' })).body);
  for (const s of SECRETS_XML) assert.ok(!decoded.includes(s), `raw: ${s}`);
  assert.match(decoded, /Hello caller/);
  // A secret that straddles the 40,000 character cut.
  const pad = '<PropertyStruct><Name>Phrase</Name><Value>Hello caller</Value></PropertyStruct>';
  const head = `<Script><ActionStruct>${pad.repeat(Math.floor(39950 / pad.length))}<PropertyStruct><Name>Password</Name><Value>`;
  const long = `${head}${'hunter2pass'.repeat(20)}</Value></PropertyStruct></ActionStruct></Script>`;
  assert.ok(head.length < 40000 && long.length > 40000);
  const cut = await callTool(makeCxone({ scripts: ['Long'], scriptXml: long }).cfg, 'get_script', { script: 'Long' });
  assert.match(cut.xml, /truncated/);
  assert.ok(!cut.xml.includes('hunter2'), 'no secret prefix before the cut');
});

test('Windows-1252 and UTF-16 script bodies are read and redacted; undecodable bodies are withheld', async () => {
  const xml = '<Script><Caption>Café</Caption><PropertyStruct><Name>Password</Name><Value>hunter2pass</Value></PropertyStruct></Script>';
  // get_script used to throw on a non UTF-8 body; it now decodes it.
  const latin = await callTool(makeCxone({ scripts: ['Legacy'], scriptXml: Buffer.from(xml, 'latin1') }).cfg, 'get_script', { script: 'Legacy' });
  assert.match(latin.xml, /Café/);
  assert.ok(!latin.xml.includes('hunter2pass'));
  for (const [what, body] of [
    ['latin1', b64(xml, 'latin1')],
    ['utf-16le with BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]).toString('base64')],
    ['utf-8 with line breaks', b64(xml).replace(/(.{76})/g, '$1\r\n')],
  ]) {
    const text = fromB64(redactStudio({ body }).body);
    assert.ok(!text.includes('hunter2pass'), what);
    assert.match(text, /Café/, `${what}: text survives`);
  }
  const binary = Buffer.from(Array.from({ length: 96 }, (_, i) => (i * 37) % 9)).toString('base64');
  const raw = makeCxone({ raw: { 'GET scripts/4': { body: binary } } });
  assert.equal((await callTool(raw.cfg, 'cxone_api_call', { method: 'GET', path: 'scripts/4' })).body, '[redacted: script body could not be checked]');
  assert.equal(redactStudio({ body: 'Thanks for calling, goodbye' }).body, 'Thanks for calling, goodbye');
});

test('render_script redacts before the renderer requotes and cuts labels', async () => {
  const token = ['sk', 'live', '51HxQpLkeyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('_'); // built at runtime so secret scanners do not flag a fake key
  const basic = 'dXNlcjpwYXNzd29yZGxvbmdsb25nbG9uZ2xvbmc=';
  const scriptJson = {
    header: { scriptName: 'Main' },
    actions: { 1: { name: 'BEGIN', label: 'Begin' }, 2: { name: 'ASSIGN', label: `apiToken = "${token}"` }, 3: { name: 'SNIPPET', label: `Authorization = "Basic ${basic}"` } },
    branches: { 1: [{ to: 2 }], 2: [{ to: 3 }] },
    properties: {},
  };
  const out = await callTool(makeCxone({ scripts: ['Main'], scriptJson }).cfg, 'render_script', { script: 'Main' });
  assert.ok(!out.mermaid.includes('sk_live_51'), out.mermaid);
  assert.ok(!out.mermaid.includes('dXNlcjpw'), out.mermaid);
});

// ---------- script text, unit level ----------

test('script text shapes are redacted and ordinary text is untouched', () => {
  for (const [input, gone] of [
    ['ASSIGN token = &quot;abc12345&quot;', 'abc12345'], ['creds.pass = "pv1-secret"', 'pv1-secret'], ['ASSIGN pw = "pv2-secret"', 'pv2-secret'],
    ['ASSIGN hmacKey = "pv5"', 'pv5'], ['https://x.example/a?apiToken=pv9', 'pv9'], ['u?a=1&pw=pv11', 'pv11'],
    ['ASSIGN token = "abc" + "pv12"', 'pv12'], ['ASSIGN token = &#34;pv13&#34;', 'pv13'], ['proxy.SetHeader("Authorization", "Basic pv15")', 'pv15'],
    ['// prod note: Authorization: Basic pv16', 'pv16'], ['Content-Type: application/json x-api-key: pv17', 'pv17'],
    ['ASSIGN password = "ab\\"pv18tail"', 'pv18tail'], ['ASSIGN apiToken = "pv19-never-closed', 'pv19'],
  ]) assert.ok(!scrubStudioText(input).includes(gone), input);
  for (const keep of ['Say: hello there', 'ASSIGN greeting = "hello"', 'Skill: Sales', 'Press 1 for sales', 'ASSIGN primaryKey = "id"', 'https://x.example/a?page=2&sort=name']) {
    assert.equal(scrubStudioText(keep), keep);
  }
  for (const n of ['Password', 'pwd', 'API_KEY', 'clientSecret', 'Authorization', 'x-auth-token', 'SubscriptionKey', 'key', 'authKey', 'user_pw']) assert.ok(isSecretName(n), n);
  for (const n of ['Phrase', 'Skill', 'Caption', 'primaryKey', 'hotkey', 'bypass']) assert.ok(!isSecretName(n), n);
  assert.deepEqual(redactStudio({ name: 'Skill', value: 'Sales' }), { name: 'Skill', value: 'Sales' });
  assert.deepEqual(redactStudio({ Name: 'PIN', Value: '1234' }), { Name: 'PIN', Value: '[redacted]' });
});

test('redaction is linear: 1.5 MB of script XML stays fast', () => {
  const unit = '<PropertyStruct><Name>Phrase</Name><Value>Hello caller</Value></PropertyStruct>';
  const xml = `<Script><ActionStruct>${unit.repeat(Math.ceil(1.5e6 / unit.length))}</ActionStruct></Script>`;
  const time = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
  redactStudio(xml.slice(0, 10000)); // warm up
  assert.ok(time(() => redactStudio(xml)) < 400, 'ordinary XML');
  assert.ok(time(() => redactStudio({ body: b64(xml) })) < 800, 'as a base64 body');
  assert.ok(time(() => redactStudio(`<P><Name>Password</Name><Value>${'a="b '.repeat(220000)}`)) < 400, 'unterminated value');
  assert.ok(time(() => redactStudio(`<a ${'b="x '.repeat(250000)}`)) < 400, 'one huge unclosed tag');
});

// ---------- saving redacted content back ----------

test('script content carrying [redacted] placeholders is never saved back', async () => {
  const fake = makeCxone({ scripts: ['Main'], scriptJson: SCRIPT_JSON });
  const read = await callTool(fake.cfg, 'get_script', { script: 'Main' });
  assert.ok(containsRedaction(read.script));
  await assert.rejects(callTool(fake.cfg, 'deploy_script', { script_content: read.script }), /\[redacted\] placeholders/);
  assert.equal(fake.api().filter((r) => r.method === 'POST').length, 0);
  const viaRaw = checkRawCall({ method: 'POST', path: 'scripts', body: { scriptContent: read.script } });
  assert.equal(viaRaw.ok, false);
  assert.match(viaRaw.message, /\[redacted\] placeholders/);
  assert.equal(checkRawCall({ method: 'POST', path: 'scripts', body: { scriptContent: { header: { scriptName: 'X' } } } }).ok, true);
});
