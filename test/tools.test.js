// Tool-layer tests for cxone_api_call against an in-memory fetch stub (no
// real CXone traffic). They prove the rails run BEFORE any network call and
// that only the validated path/version/query reach the wire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/tools.js';
import { CxoneClient } from '../src/cxone.js';

let keyN = 0;
function stub() {
  const state = { calls: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    state.calls.push({ method: init.method || 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), body: init.body });
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/authentication/v1/token/access-key') return reply({ access_token: 'tok', expires_in: 3600 });
    return reply({ agentId: 5, userName: 'a', password: 'hunter2', nested: { apiKey: 'k' } });
  };
  // A fresh access key per test keeps the module-level session cache apart.
  const cfg = { configured: true, accessKeyId: `test-key-${++keyN}`, accessKeySecret: 's', apiBase: 'https://api-test.niceincontact.com' };
  return { state, cfg };
}

const BYPASSES = [
  { method: 'POST', path: 'skills/123/../123/start' },
  { method: 'POST', path: 'skills/123/x/../start' },
  { method: 'POST', path: 'x', version: 'v30.0/skills/123/start?' },
  { method: 'POST', path: 'skill%73/123/start' },
  { method: 'POST', path: 'lists/call-lists/5/upload', body: { startSkill: 1 } },
  { method: 'POST', path: 'lists/call-lists/5/upload', body: { StartSkill: true } },
  { method: 'POST', path: 'x/../contacts/999/end' },
  { method: 'POST', path: 'skills/123/start' },
  { method: 'DELETE', path: 'skills/123' },
];

test('cxone_api_call refuses every known bypass before any network call', async () => {
  const { state, cfg } = stub();
  for (const args of BYPASSES) {
    await assert.rejects(callTool(cfg, 'cxone_api_call', args), (e) => e.status === 403 && /^Refused/.test(e.message), JSON.stringify(args));
  }
  assert.equal(state.calls.length, 0);
});

test('cxone_api_call sends only the validated values and redacts secrets', async () => {
  const { state, cfg } = stub();
  const res = await callTool(cfg, 'cxone_api_call', { method: 'GET', path: '/agents/5', query: { top: 1, fields: 'agentId' } });
  assert.equal(res.password, '[redacted]');
  assert.equal(res.nested.apiKey, '[redacted]');
  assert.equal(res.userName, 'a');
  const api = state.calls.find((c) => c.path.startsWith('/inContactAPI'));
  assert.equal(api.path, '/inContactAPI/services/v30.0/agents/5');
  assert.deepEqual(api.query, { top: '1', fields: 'agentId' });
  assert.equal(api.method, 'GET');
});

test('cxone_api_call write lands on the exact allowlisted path and version', async () => {
  const { state, cfg } = stub();
  await callTool(cfg, 'cxone_api_call', { method: 'POST', path: 'campaigns', version: 'v33.0', body: { name: 'MCP_Test', isActive: true } });
  const api = state.calls.find((c) => c.path.startsWith('/inContactAPI'));
  assert.equal(api.path, '/inContactAPI/services/v33.0/campaigns');
  assert.equal(api.method, 'POST');
  assert.deepEqual(JSON.parse(api.body), { name: 'MCP_Test', isActive: true });
});

test('client refuses paths that URL parsing would rewrite, and bad versions (defense in depth)', async () => {
  const { state, cfg } = stub();
  const cx = new CxoneClient(cfg);
  await assert.rejects(cx.api('POST', 'skills/1/../1/start'), /does not survive URL parsing/);
  await assert.rejects(cx.api('GET', 'skills?x=1'), /does not survive URL parsing/);
  await assert.rejects(cx.api('GET', 'skills#x'), /does not survive URL parsing/);
  await assert.rejects(cx.api('GET', 'skills', { version: 'v30.0/skills/1/start?' }), /Bad API version/);
  assert.equal(state.calls.filter((c) => c.path.startsWith('/inContactAPI')).length, 0);
  await cx.api('GET', 'skills/9');
  assert.equal(state.calls.filter((c) => c.path.startsWith('/inContactAPI')).length, 1);
});
