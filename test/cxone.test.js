// Client tests: API host pinning, sign in hosts and what login errors reveal.
// Mocked fetch only (test/fake-cxone.js); no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CxoneClient, officialApiHost, AUTH_HOSTS } from '../src/cxone.js';
import { callTool } from '../src/tools.js';
import { makeCxone, SECRET, API_HOST } from './fake-cxone.js';

test('officialApiHost accepts NiCE API hosts only', () => {
  for (const ok of ['api-na1.niceincontact.com', 'https://api-b32.nice-incontact.com/', 'API-C4.incontact.com', 'api-de-na1.niceincontact.com', 'api-na1.niceincontact.com.']) {
    assert.ok(officialApiHost(ok), ok);
  }
  for (const bad of [
    'api-na1.niceincontact.com.evil.com', 'xapi-na1.niceincontact.com', 'api-na1.xniceincontact.com', 'evil.com',
    'http://api-na1.niceincontact.com', 'https://user:pw@api-na1.niceincontact.com', 'https://api-na1.niceincontact.com:8443',
    'https://api-na1.niceincontact.com/x', 'https://api-na1.niceincontact.com?x', 'api-na1.niceincontact.com/x',
    'api-x.evil.example.com.nice-incontact.com', 'api-eu1.nicecxone.com', 'api-test.example', '', null,
  ]) {
    assert.equal(officialApiHost(bad), null, String(bad));
  }
});

test('a discovery answer naming a non NiCE host is refused, and the token never goes there', async () => {
  for (const discovery of [
    { api_endpoint: 'https://api-na1.evil.example' },
    { api_endpoint: 'https://evil.example' },
    { api_endpoint: 'https://api-na1.niceincontact.com.evil.example' },
    { area: 'na1', domain: 'evil.example' },
  ]) {
    const fake = makeCxone({ discovery });
    await assert.rejects(callTool(fake.cfg, 'list_skills', {}), /not an official NiCE CXone/);
    assert.ok(!fake.requests.some((r) => /evil/.test(r.host)), JSON.stringify(discovery));
    assert.equal(fake.api().length, 0);
  }
});

test('the token claims cannot steer the API host off NiCE domains either', async () => {
  const fake = makeCxone({ discovery: null, claims: { tenantId: 'T-1', icClusterId: 'x.evil.example.com' } });
  await assert.rejects(callTool(fake.cfg, 'list_skills', {}), /not an official NiCE CXone/);
  assert.ok(!fake.requests.some((r) => /evil/.test(r.host)));
  const viaArea = makeCxone({ discovery: null, claims: { tenantId: 'T-1', area: 'na1', domain: 'evil.example' } });
  await assert.rejects(callTool(viaArea.cfg, 'list_skills', {}), /not an official NiCE CXone/);
  assert.ok(!viaArea.requests.some((r) => /evil/.test(r.host)));
  // A real cluster id still works.
  const good = makeCxone({ discovery: null, claims: { tenantId: 'T-1', icClusterId: 'B32' } });
  await callTool(good.cfg, 'list_skills', {});
  assert.ok(good.api().every((r) => r.host === 'api-b32.nice-incontact.com'));
});

test('a configured API base must be official, and is checked before the key is sent anywhere', async () => {
  const fake = makeCxone();
  await assert.rejects(callTool({ ...fake.cfg, apiBase: 'https://attacker.example' }, 'list_skills', {}), /not an official NiCE CXone API host/);
  await assert.rejects(callTool({ ...fake.cfg, apiBase: 'http://api-na1.niceincontact.com' }, 'list_skills', {}), /not an official/);
  assert.equal(fake.requests.length, 0, 'no sign in, no discovery, no API call');
  await callTool({ ...fake.cfg, apiBase: `https://${API_HOST}/` }, 'list_skills', {});
  assert.ok(fake.api().length > 0 && fake.api().every((r) => r.host === API_HOST));
});

test('the tenant id is URL encoded into the discovery query', async () => {
  const fake = makeCxone({ claims: { tenantId: 'T-1&api_endpoint=https://evil.example', icClusterId: 'B32' } });
  await callTool(fake.cfg, 'list_skills', {});
  const disc = fake.requests.find((r) => r.path === '/.well-known/cxone-configuration');
  assert.deepEqual(Object.keys(disc.query), ['tenantId']);
  assert.equal(disc.query.tenantId, 'T-1&api_endpoint=https://evil.example');
});

test('a failed login never echoes the response body (which can carry the secret)', async () => {
  const fake = makeCxone();
  const bad = { ...fake.cfg, accessKeyId: 'not-the-key' };
  await assert.rejects(callTool(bad, 'list_skills', {}), (e) => {
    assert.ok(!e.message.includes(SECRET), e.message);
    assert.ok(!e.message.includes('invalid_grant'), e.message);
    assert.match(e.message, /CXone login failed \(HTTP 401\)/);
    return true;
  });
});

test('sign in tries the documented areas (na1, eu1, au1), and the configured area first', async () => {
  assert.deepEqual(AUTH_HOSTS, ['na1.nice-incontact.com', 'cxone.niceincontact.com', 'eu1.nice-incontact.com', 'au1.nice-incontact.com']);
  const eu = makeCxone({ authAccept: ['eu1.nice-incontact.com'] });
  await callTool(eu.cfg, 'list_skills', {});
  assert.deepEqual(eu.requests.filter((r) => r.path.startsWith('/authentication')).map((r) => r.host), ['na1.nice-incontact.com', 'cxone.niceincontact.com', 'eu1.nice-incontact.com']);
  const first = makeCxone({ authAccept: ['au1.nice-incontact.com'] });
  await callTool({ ...first.cfg, apiBase: 'https://api-au1.niceincontact.com' }, 'list_skills', {});
  assert.deepEqual(first.requests.filter((r) => r.path.startsWith('/authentication')).map((r) => r.host), ['au1.nice-incontact.com']);
});

test('the client pins the URL it sends even if a cached session were tampered with', async () => {
  const fake = makeCxone();
  const cx = new CxoneClient(fake.cfg);
  const s = await cx.session();
  s.apiBase = 'https://evil.example';
  await assert.rejects(cx.get('skills'), /not an official NiCE CXone host/);
  assert.equal(fake.api().length, 0);
});

// ---------- time budget ----------

test('a hanging CXone answer ends at the call budget; nothing sent means "nothing was changed"', async () => {
  const slow = makeCxone({ hang: true });
  const started = Date.now();
  await assert.rejects(callTool({ ...slow.cfg, budgetMs: 300 }, 'configure_outbound_skill', { skill: 'Reactivation', max_attempts: 3 }), (e) => e.code === 'time_limit' && /nothing was changed/.test(e.message));
  assert.ok(Date.now() - started < 2000, 'aborted at the budget');
  // A read that times out says so, without talking about changes.
  await assert.rejects(callTool({ ...makeCxone({ hang: true }).cfg, budgetMs: 300 }, 'list_skills', {}), (e) => e.code === 'time_limit' && /^CXone did not answer in time/.test(e.message));
});

test('a time out after a write went out is reported as possibly completed, never as unchanged', async () => {
  const fake = makeCxone({ hangMethods: ['POST'] });
  await assert.rejects(callTool({ ...fake.cfg, budgetMs: 300 }, 'create_unavailable_code', { name: 'Huddle' }), (e) => {
    assert.equal(e.code, 'time_limit');
    assert.match(e.message, /may have completed/);
    assert.doesNotMatch(e.message, /nothing was changed/);
    return true;
  });
});

test('the 429 backoff stops at the budget instead of sleeping past it', async () => {
  const fake = makeCxone({ status: { 'GET skills': 429 } });
  const started = Date.now();
  await assert.rejects(callTool({ ...fake.cfg, budgetMs: 1000 }, 'list_skills', {}), (e) => e.code === 'time_limit');
  assert.ok(Date.now() - started < 1500, 'did not sleep the 2 s backoff');
  assert.equal(fake.api().length, 1);
});
