import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRawCall, redactSecrets, isIgnitionKey, VERSION_RE } from '../src/rules.js';

const refused = (call, re) => {
  const r = checkRawCall(call);
  assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(call)}`);
  if (re) assert.match(r.message, re);
  return r;
};
const allowed = (call) => {
  const r = checkRawCall(call);
  assert.equal(r.ok, true, `expected allow for ${JSON.stringify(call)}: ${r.message}`);
  return r;
};

// ---------- regression: the verified bypasses of the old regex guard ----------

test('bypass: dot-segment traversal onto skills/{id}/start is refused', () => {
  refused({ method: 'POST', path: 'skills/123/../123/start' }, /segments/);
  refused({ method: 'POST', path: 'skills/123/x/../start' }, /segments/);
  refused({ method: 'POST', path: 'skills/123/./start' }, /segments/);
  refused({ method: 'GET', path: 'skills/123/../123/start' }, /segments/);
});

test('bypass: version injection is refused (version must be vNN.N)', () => {
  refused({ method: 'POST', path: 'x', version: 'v30.0/skills/123/start?' }, /version/);
  refused({ method: 'GET', path: 'skills', version: 'v30.0/../v33.0' }, /version/);
  refused({ method: 'GET', path: 'skills', version: '../v30.0' }, /version/);
  refused({ method: 'GET', path: 'skills', version: 'v33' }, /version/);
  refused({ method: 'GET', path: 'skills', version: 'V30.0' }, /version/);
  refused({ method: 'GET', path: 'skills', version: 'v30.0 ' }, /version/);
  refused({ method: 'GET', path: 'skills', version: 30 }, /version/);
  assert.ok(VERSION_RE.test('v30.0') && VERSION_RE.test('v33.0'));
});

test('bypass: percent-encoding (server-side decode) is refused', () => {
  refused({ method: 'POST', path: 'skill%73/123/start' }, /may not contain/);
  refused({ method: 'POST', path: 'skills/123/%73tart' }, /may not contain/);
  refused({ method: 'POST', path: 'skills/123/..%2fstart' }, /may not contain/);
});

test('bypass: ignition coercion in the body is refused (any casing, any truthy value, any depth)', () => {
  refused({ method: 'POST', path: 'lists/call-lists/5/upload', body: { startSkill: 1 } }, /startSkill can start dialing/);
  refused({ method: 'POST', path: 'lists/call-lists/5/upload', body: { StartSkill: true } }, /StartSkill/);
  refused({ method: 'POST', path: 'lists/call-lists/5/upload', body: { startSkill: 'true' } }, /only accepted value is boolean false/);
  refused({ method: 'POST', path: 'lists/call-lists/5/upload', body: { startSkill: 'false' } }, /only accepted value is boolean false/);
  refused({ method: 'POST', path: 'lists/call-lists/5/upload', body: { startSkill: null } }, /boolean false/);
  refused({ method: 'POST', path: 'lists/call-lists/5/upload', body: { start_skill: true } }, /start_skill/);
  refused({ method: 'POST', path: 'skills', body: { skills: [{ skillName: 'x', isRunning: true }] } }, /skills\[0\]\.isRunning/);
  refused({ method: 'PUT', path: 'skills/9', body: { a: { b: { c: { ISRUNNING: 1 } } } } }, /ISRUNNING/);
  refused({ method: 'PUT', path: 'skills/9/parameters/general-settings', body: { isNaturalCallingRunning: true } }, /isNaturalCallingRunning/);
  refused({ method: 'PUT', path: 'skills/9', body: { autoStart: 'yes' } }, /autoStart/);
});

test('bypass: traversal into contacts/interactions is refused', () => {
  refused({ method: 'POST', path: 'x/../contacts/999/end' }, /segments/);
  refused({ method: 'POST', path: 'contacts/999/end' }, /live-contact/);
  refused({ method: 'GET', path: 'contacts/active' }, /live-contact/);
  refused({ method: 'POST', path: 'Contacts/999/record' }, /live-contact/);
  refused({ method: 'POST', path: 'interactions/1/signal' }, /live-contact/);
  refused({ method: 'POST', path: 'agent-sessions/1/dial-phone' }, /live-contact/);
});

// ---------- normalization ----------

test('start endpoints are refused directly, in any casing, for every method', () => {
  for (const m of ['GET', 'POST', 'PUT', 'PATCH']) {
    refused({ method: m, path: 'skills/123/start' }, /never starts/);
    refused({ method: m, path: 'Skills/123/START' }, /never starts/);
    refused({ method: m, path: 'scripts/start' }, /never starts/);
    refused({ method: m, path: '/skills/123/start' }, /never starts/);
  }
  refused({ method: 'POST', path: 'skills/123/restart' }, /never starts/);
  refused({ method: 'POST', path: 'skills/123/start-now' }, /never starts/);
});

test('path hygiene: slashes, dots, separators, whitespace', () => {
  refused({ method: 'POST', path: 'skills/123/start/' }, /segments/);
  refused({ method: 'POST', path: '//skills/123/start' }, /segments/);
  refused({ method: 'GET', path: 'skills//123' }, /segments/);
  refused({ method: 'POST', path: 'skills/123/start.' }, /letters, digits/);
  refused({ method: 'POST', path: 'skills/123/.start' }, /letters, digits/);
  refused({ method: 'POST', path: 'skills/123/start;x=1' }, /may not contain/);
  refused({ method: 'POST', path: 'skills/123/start#frag' }, /may not contain/);
  refused({ method: 'POST', path: 'skills/123?x=/start' }, /may not contain/);
  refused({ method: 'POST', path: 'skills\\123\\start' }, /may not contain/);
  refused({ method: 'POST', path: 'skills/123/start ' }, /whitespace/);
  refused({ method: 'POST', path: 'skills/123/\tstart' }, /whitespace/);
  refused({ method: 'POST', path: 'skills/123/start::$DATA' }, /letters, digits/);
  refused({ method: 'GET', path: 'skills/１２３' }, /letters, digits/);
  refused({ method: 'GET', path: '' }, /path is required/);
  refused({ method: 'GET' }, /path is required/);
});

test('only one leading slash is stripped', () => {
  assert.equal(allowed({ method: 'GET', path: '/skills' }).path, 'skills');
  refused({ method: 'GET', path: '//skills' }, /segments/);
});

test('methods: DELETE and unknown methods are refused', () => {
  refused({ method: 'DELETE', path: 'skills/1' }, /no deletes/);
  refused({ method: 'delete', path: 'skills/1' }, /no deletes/);
  refused({ method: 'HEAD', path: 'skills' }, /not allowed/);
  refused({ path: 'skills' }, /not allowed/);
});

test('query: identifier keys, no case-duplicates, scalars only, no ignition', () => {
  refused({ method: 'GET', path: 'skills', query: { 'a b': 1 } }, /plain identifiers/);
  refused({ method: 'GET', path: 'skills', query: { 'x[0]': 1 } }, /plain identifiers/);
  refused({ method: 'GET', path: 'skills', query: { top: 1, TOP: 2 } }, /duplicate/);
  refused({ method: 'GET', path: 'skills', query: { top: { $gt: 1 } } }, /single scalar/);
  refused({ method: 'GET', path: 'skills', query: { top: [1, 2] } }, /single scalar/);
  refused({ method: 'GET', path: 'skills', query: 'top=1' }, /object/);
  refused({ method: 'POST', path: 'lists/call-lists/5/upload', query: { startSkill: true }, body: { startSkill: false } }, /query parameter startSkill/);
  refused({ method: 'POST', path: 'lists/call-lists/5/upload', query: { StartSkill: '1' }, body: { startSkill: false } }, /query parameter StartSkill/);
  const r = allowed({ method: 'GET', path: 'skills', query: { top: 1, isActive: true, skip: 0, empty: '', gone: null } });
  assert.deepEqual(r.query, { top: '1', isActive: 'true', skip: '0' });
});

test('body: object only, never on GET, no case-duplicate keys, bounded depth', () => {
  refused({ method: 'GET', path: 'skills', body: { a: 1 } }, /GET calls take no body/);
  refused({ method: 'POST', path: 'skills', body: [{ skillName: 'x' }] }, /single JSON object/);
  refused({ method: 'POST', path: 'skills', body: 'x' }, /single JSON object/);
  refused({ method: 'POST', path: 'lists/call-lists/5/upload', body: { startSkill: false, StartSkill: true } }, /casing/);
  refused({ method: 'POST', path: 'teams', body: { teams: [{ teamName: 'a', TeamName: 'b' }] } }, /casing/);
  let deep = { startSkill: true };
  for (let i = 0; i < 80; i++) deep = { n: deep };
  refused({ method: 'POST', path: 'skills', body: deep }, /nested/);
});

// ---------- write allowlist ----------

test('writes outside the allowlist are refused with the family list', () => {
  const r = refused({ method: 'POST', path: 'skills/1/stop' }, /write allowlist/);
  assert.match(r.message, /skills \(create/);
  refused({ method: 'POST', path: 'scripts/kick' }, /write allowlist/);
  refused({ method: 'PUT', path: 'scripts' }, /write allowlist/);
  refused({ method: 'PUT', path: 'agents/1' }, /write allowlist/);
  refused({ method: 'POST', path: 'agents' }, /write allowlist/);
  refused({ method: 'POST', path: 'suppressed-contact' }, /write allowlist/);
  refused({ method: 'PATCH', path: 'campaigns/1/status' }, /write allowlist/);
  refused({ method: 'PATCH', path: 'skills/1' }, /write allowlist/);
  refused({ method: 'POST', path: 'scriptschedules' }, /write allowlist/);
  refused({ method: 'POST', path: 'skills/abc' }, /write allowlist/);
  refused({ method: 'PUT', path: 'skills/1/parameters/whatever' }, /write allowlist/);
  refused({ method: 'POST', path: 'skills/1/tags' }, /write allowlist/);
});

test('call-list uploads must say startSkill false explicitly', () => {
  refused({ method: 'POST', path: 'lists/call-lists/5/upload', body: { listFile: 'x' } }, /startSkill: false explicitly/);
  allowed({ method: 'POST', path: 'lists/call-lists/5/upload', body: { listFile: 'x', skillId: 7, startSkill: false, forceOverwrite: true } });
});

// ---------- normal calls still work ----------

test('normal typed-tool-shaped calls are allowed and pass through unchanged', () => {
  assert.deepEqual(allowed({ method: 'GET', path: 'skills' }), { ok: true, method: 'GET', path: 'skills', version: 'v30.0', query: {} });
  allowed({ method: 'GET', path: 'agents/123/skills' });
  allowed({ method: 'GET', path: 'scripts/search', query: { scriptName: 'Main IVR' } });
  allowed({ method: 'GET', path: 'business-unit' });
  allowed({ method: 'GET', path: 'skills/9/parameters/retry-settings' });
  allowed({ method: 'get', path: 'dnc-groups/4/records', query: { top: 100 } });
  allowed({ method: 'POST', path: 'skills', body: { skills: [{ skillName: 'MCP_Test', isOutbound: true }] } });
  allowed({ method: 'PUT', path: 'skills/9', body: { skillName: 'MCP_Test_2', isRunning: false } });
  allowed({ method: 'PUT', path: 'skills/9/parameters/retry-settings', body: { retrySettings: { maxNumberOfAttempts: 3 } } });
  allowed({ method: 'PUT', path: 'skills/9/parameters/schedule-settings', body: { scheduleSettings: [{ day: 'Monday', startTime: '09:00', endTime: '17:00' }] } });
  allowed({ method: 'POST', path: 'skills/9/agents', body: { agents: [{ agentId: 1, proficiency: 10 }] } });
  allowed({ method: 'POST', path: 'agents/1/skills', body: { skills: [{ skillId: '9' }] } });
  const camp = allowed({ method: 'POST', path: 'campaigns', body: { name: 'MCP_Test', isActive: true }, version: 'v33.0' });
  assert.equal(camp.version, 'v33.0');
  allowed({ method: 'POST', path: 'campaigns/3/skills', body: { skills: [{ skillId: 9 }] } });
  allowed({ method: 'POST', path: 'teams', body: { teams: [{ teamName: 'MCP_Test' }] } });
  allowed({ method: 'POST', path: 'teams/2/agents', body: { agentIds: [1] } });
  allowed({ method: 'POST', path: 'dispositions', body: { dispositions: [{ dispositionName: 'Sale' }] } });
  allowed({ method: 'POST', path: 'hours-of-operation', body: { hoursOfOperationProfileName: 'x', days: [{ day: 'Monday', openTime: '09:00', closeTime: '17:00' }] } });
  allowed({ method: 'PUT', path: 'points-of-contact/0c2e7d1a-1111-2222-3333-444455556666', body: { scriptName: 'x' } });
  allowed({ method: 'POST', path: 'unavailable-codes', body: { name: 'Lunch' } });
  allowed({ method: 'POST', path: 'address-books', query: { addressBookName: 'x', addressBookType: 'Standard' } });
  allowed({ method: 'POST', path: 'address-books/5/entries', body: { addressBookEntries: [] } });
  allowed({ method: 'POST', path: 'address-books/5/assignment', query: { entityType: 'Skill' } });
  allowed({ method: 'POST', path: 'dnc-groups', body: { dncGroupName: 'x' } });
  allowed({ method: 'POST', path: 'dnc-groups/4/records', body: { dncGroupRecords: [{ phoneNumber: 5555550100 }] } });
  allowed({ method: 'POST', path: 'dnc-groups/4/scrubbed-skills/9' });
  allowed({ method: 'POST', path: 'lists/call-lists', query: { listName: 'x', externalIdColumn: 'external_id' }, body: { destinationMappings: [] } });
  allowed({ method: 'POST', path: 'scripts', body: { scriptContent: { header: { scriptName: 'x' }, actions: [{ StartOffset: '0' }] } } });
});

test('isIgnitionKey matches the family and nothing time-shaped', () => {
  for (const k of ['startSkill', 'StartSkill', 'start_skill', 'START-SKILL', 'isRunning', 'autoStart', 'start', 'isNaturalCallingRunning']) assert.ok(isIgnitionKey(k), k);
  for (const k of ['startTime', 'startDate', 'StartOffset', 'scheduleStartTime', 'isActive', 'restartable']) assert.ok(!isIgnitionKey(k), k);
});

// ---------- redaction ----------

test('redactSecrets scrubs secret-looking fields at any depth, case-insensitively', () => {
  const out = redactSecrets({
    agents: [{ agentId: 1, userName: 'a', Password: 'p', accessKeySecret: 's', api_key: 'k', ApiKey: 'k2', AccessKey: 'ak', credentials: { user: 'u' }, refreshToken: 't', pwd: 'x', empty: '', passwordHint: null }],
    note: 'password is fine in a value',
  });
  const a = out.agents[0];
  assert.equal(a.agentId, 1);
  assert.equal(a.userName, 'a');
  for (const k of ['Password', 'accessKeySecret', 'api_key', 'ApiKey', 'AccessKey', 'credentials', 'refreshToken', 'pwd']) assert.equal(a[k], '[redacted]', k);
  assert.equal(a.empty, '');
  assert.equal(a.passwordHint, null);
  assert.equal(out.note, 'password is fine in a value');
  assert.equal(redactSecrets(null), null);
  assert.deepEqual(redactSecrets([{ token: 'x' }]), [{ token: '[redacted]' }]);
});
