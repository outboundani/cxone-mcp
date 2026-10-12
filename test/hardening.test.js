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

// ---------- exact references for writes ----------

const writes = (fake) => fake.api().filter((r) => r.method !== 'GET');

test('a write never acts on a skill it only partially matched', async () => {
  const skills = [{ skillId: 9, skillName: 'Sales Outbound', isOutbound: true }];
  const fake = makeCxone({ skills });
  await assert.rejects(callTool(fake.cfg, 'configure_outbound_skill', { skill: 'Sales', max_attempts: 3 }), /Did you mean "Sales Outbound"/);
  assert.equal(writes(fake).length, 0);
  // The exact name (any case) and the id still work; reads keep the partial match.
  const ok = makeCxone({ skills });
  await callTool(ok.cfg, 'configure_outbound_skill', { skill: 'sales outbound', max_attempts: 3 });
  assert.equal(writes(ok)[0].path, '/inContactAPI/services/v30.0/skills/9/parameters/retry-settings');
  const read = makeCxone({ skills, raw: { 'GET skills/9': { skills: [skills[0]] } } });
  const got = await callTool(read.cfg, 'get_skill', { skill: 'Sales' });
  assert.equal(got.skill.skillId, 9);
});

test('a write never acts on a script it only partially matched, or on any script when the id is unknown', async () => {
  const pocs = [{ pointOfContactId: 12, pointOfContact: '5551234567', pointOfContactName: 'Main line', scriptName: 'Old', skillId: 7, isActive: true }];
  const partial = makeCxone({ pocs, scripts: ['Main IVR v2'] });
  await assert.rejects(callTool(partial.cfg, 'repoint_point_of_contact', { point_of_contact: 'Main line', script: 'Main IVR' }), /Did you mean "Main IVR v2"/);
  assert.equal(writes(partial).length, 0);
  const byId = makeCxone({ pocs, scripts: ['Only Script'] });
  await assert.rejects(callTool(byId.cfg, 'repoint_point_of_contact', { point_of_contact: 'Main line', script: '99' }), /No script found with id 99/);
  assert.equal(writes(byId).length, 0);
});

test('multi-step creates resolve every reference before the first write', async () => {
  const camp = makeCxone({ skills: SKILLS });
  await assert.rejects(callTool(camp.cfg, 'create_campaign', { name: 'Q4', skills: ['Nope'] }), /No skill found/);
  assert.equal(writes(camp).length, 0, 'no campaign left behind without its skills');
  const dnc = makeCxone({ skills: SKILLS });
  await assert.rejects(callTool(dnc.cfg, 'create_dnc_group', { name: 'Internal', numbers: ['5551234567', 'call me'] }), /must have 10 to 15 digits/);
  assert.equal(dnc.api().length, 0);
});

test('repoint_point_of_contact matches a formatted number by digits', async () => {
  const pocs = [{ pointOfContactId: 12, pointOfContact: '5551234567', pointOfContactName: 'Main line', scriptName: 'Old', skillId: 7, isActive: true }];
  const fake = makeCxone({ pocs, scripts: ['New'] });
  const res = await callTool(fake.cfg, 'repoint_point_of_contact', { point_of_contact: '+1 (555) 123-4567', script: 'New' });
  assert.equal(res.repointed, true);
  assert.equal(writes(fake)[0].path, '/inContactAPI/services/v30.0/points-of-contact/12');
});

test('repoint sends back the fields it read, so only the script changes', async () => {
  const pocs = [{ pointOfContactId: 12, pointOfContact: '5551234567', pointOfContactName: 'Main line', scriptName: 'Old', skillId: 7, isActive: true, ivrReportingEnabled: false }];
  const fake = makeCxone({ pocs, scripts: ['New'] });
  await callTool(fake.cfg, 'repoint_point_of_contact', { point_of_contact: 'Main line', script: 'New' });
  assert.deepEqual(JSON.parse(writes(fake)[0].body), { scriptName: 'New', pointOfContactName: 'Main line', skillId: 7, isActive: true, ivrReportingEnabled: false });
  const noId = makeCxone({ pocs: [{ pointOfContactName: 'Main line', scriptName: 'Old', isActive: true }], scripts: ['New'] });
  await assert.rejects(callTool(noId.cfg, 'repoint_point_of_contact', { point_of_contact: 'Main line', script: 'New' }), /no numeric id|did not report a numeric id/);
  assert.equal(writes(noId).length, 0);
});

// ---------- running state ----------

test('a skill whose running state CXone does not report is never shown as stopped', async () => {
  const skills = [
    { skillId: 1, skillName: 'Dialing', isOutbound: true, isRunning: true },
    { skillId: 2, skillName: 'Stopped', isOutbound: true, isRunning: false },
    { skillId: 3, skillName: 'Unknown', isOutbound: true },
  ];
  const list = await callTool(makeCxone({ skills }).cfg, 'list_skills', {});
  assert.deepEqual(list.skills.map((s) => s.isRunning), [true, false, undefined]);
  const overview = await callTool(makeCxone({ skills }).cfg, 'outbound_overview', {});
  assert.deepEqual(overview.outboundSkills.map((s) => s.isRunning), [true, false, undefined]);
  assert.equal(overview.truncated, false);
  const many = Array.from({ length: 23 }, (_, i) => ({ skillId: i + 1, skillName: `S${i}`, isOutbound: true, isRunning: false }));
  const big = await callTool(makeCxone({ skills: many }).cfg, 'outbound_overview', {});
  assert.equal(big.outboundSkills.length, 20);
  assert.equal(big.outboundSkillCount, 23);
  assert.equal(big.truncated, true);
});
