// Tool-level hardening: input validation before any write, exact matching for
// the objects a write acts on, and state passed through without guessing.
// Mocked fetch only (test/fake-cxone.js); no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/tools.js';
import { makeCxone } from './fake-cxone.js';

const SKILLS = [{ skillId: 7, skillName: 'Reactivation', isOutbound: true, isRunning: false }];

// ---------- upload_call_list ----------

test('upload_call_list builds a safe CSV and never starts the skill', async () => {
  const fake = makeCxone({ skills: SKILLS });
  await callTool(fake.cfg, 'upload_call_list', {
    name: 'Fall', skill: 'Reactivation',
    records: [
      { phone: '+1 (555) 123-4567', first_name: 'Ann, Jr', notes: 'line1\rline2' },
      { phone: '5551234568', first_name: 'Bo "B"', notes: 'ok' },
    ],
  });
  const upload = fake.api().find((r) => r.path.endsWith('/upload'));
  const body = JSON.parse(upload.body);
  assert.equal(body.startSkill, false);
  const csv = Buffer.from(body.listFile, 'base64').toString('utf8');
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 3, 'a bare CR inside a value does not split the row');
  assert.equal(lines[0], 'external_id,phone,first_name,notes');
  assert.equal(lines[1], 'rec1,+15551234567,"Ann, Jr","line1\rline2"');
  assert.equal(lines[2], 'rec2,5551234568,"Bo ""B""",ok');
});

test('upload_call_list refuses column names and values that would corrupt the CSV, before any request', async () => {
  const cases = [
    [{ phone: '5551234567', 'x,y': 1 }, /column name/],
    [{ phone: '5551234567', 'a\nb': 1 }, /column name/],
    [{ phone: '5551234567', nested: { a: 1 } }, /must be text or a number/],
    [{ phone: '12345' }, /phone must be 10 to 15 digits/],
    [{ first_name: 'no phone' }, /phone must be 10 to 15 digits/],
    ['not an object', /must be an object/],
  ];
  for (const [rec, re] of cases) {
    const fake = makeCxone({ skills: SKILLS });
    await assert.rejects(callTool(fake.cfg, 'upload_call_list', { name: 'L', skill: 'Reactivation', records: [rec] }), re, JSON.stringify(rec));
    assert.equal(fake.api().length, 0);
  }
  for (const d of [0, -1, 1.5, 366]) {
    const fake = makeCxone({ skills: SKILLS });
    await assert.rejects(callTool(fake.cfg, 'upload_call_list', { name: 'L', skill: 'Reactivation', records: [{ phone: '5551234567' }], expiration_days: d }), /expiration_days/);
    assert.equal(fake.api().length, 0);
  }
});

test('upload_call_list uploads nothing when the list create returns no id', async () => {
  const fake = makeCxone({ skills: SKILLS, raw: { 'POST lists/call-lists': { ok: true } } });
  await assert.rejects(callTool(fake.cfg, 'upload_call_list', { name: 'L', skill: 'Reactivation', records: [{ phone: '5551234567' }] }), /no list id/);
  assert.ok(!fake.api().some((r) => r.path.includes('/upload')));
});

// ---------- configure_outbound_skill ----------

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

test('configure_outbound_skill checks every argument before the first write (no half-applied change)', async () => {
  const bad = [
    { max_attempts: 3, schedule: [{ days: WEEKDAYS, start: '09:00', end: '19:00' }] }, // weekend missing
    { max_attempts: 3, schedule: [{ days: [...WEEKDAYS, 'saturday', 'sunday'], start: '9am', end: '19:00' }] },
    { minimum_retry_minutes: 30, schedule: [{ days: [...WEEKDAYS, 'saturday', 'sunday'], start: '10:00', end: '10:00' }] },
    { max_attempts: 0 },
    { max_attempts: 2.5 },
    { max_attempts: 301 },
    { minimum_retry_minutes: -5 },
    {},
  ];
  for (const extra of bad) {
    const fake = makeCxone({ skills: SKILLS });
    await assert.rejects(callTool(fake.cfg, 'configure_outbound_skill', { skill: 'Reactivation', ...extra }), (e) => e.status === 400, JSON.stringify(extra));
    assert.equal(fake.api().filter((r) => r.method !== 'GET').length, 0, JSON.stringify(extra));
  }
  const ok = makeCxone({ skills: SKILLS });
  const res = await callTool(ok.cfg, 'configure_outbound_skill', { skill: 'Reactivation', max_attempts: 3, schedule: [{ days: [...WEEKDAYS, 'saturday', 'sunday'], start: '09:00', end: '19:00' }] });
  assert.equal(res.retrySettings.maximumAttempts, 3);
  assert.deepEqual(ok.api().filter((r) => r.method === 'PUT').map((r) => r.path.split('/').pop()), ['retry-settings', 'schedule-settings']);
});
