// Live smoke test against a real CXone tenant, exercising the tool layer
// directly (no Worker needed). Reads credentials from .env in the repo root.
// Read-only by default; pass --writes to also exercise the write tools
// (creates MCP_Test_-prefixed artifacts in the tenant - sandbox only!).
import { readFileSync } from 'node:fs';
import { callTool } from '../src/tools.js';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);

const cfg = {
  accessKeyId: env.CXONE_ACCESS_KEY_ID,
  accessKeySecret: env.CXONE_ACCESS_KEY_SECRET,
  apiBase: '', // exercise auto-discovery
  configured: true,
};

const WRITES = process.argv.includes('--writes');
const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '');
let pass = 0, fail = 0;

async function step(name, fn, check = () => true) {
  try {
    const out = await fn();
    if (!check(out)) throw new Error(`check failed: ${JSON.stringify(out).slice(0, 300)}`);
    console.log(`PASS  ${name}`);
    pass++;
    return out;
  } catch (e) {
    console.log(`FAIL  ${name}: ${e.message}`);
    fail++;
    return null;
  }
}

const call = (name, args = {}) => callTool(cfg, name, args);

// ---------- reads ----------
const conn = await step('check_connection', () => call('check_connection'), (o) => o.ok && o.busNo);
await step('about', () => call('about'), (o) => typeof o === 'string' && o.includes('vocabulary'));
await step('get_business_unit', () => call('get_business_unit'), (o) => o.businessUnitId);
await step('list_skills', () => call('list_skills'), (o) => o.total >= 1);
await step('list_skills search', () => call('list_skills', { search: 'default' }), (o) => o.total >= 1);
const skills = await step('get_skill by name', () => call('get_skill', { skill: 'Default Skill 4606137' }), (o) => o.skill);
await step('list_agents', () => call('list_agents'), (o) => o.total >= 1);
await step('list_teams', () => call('list_teams'), (o) => o.total >= 1);
await step('list_campaigns', () => call('list_campaigns'), (o) => o.total >= 1);
await step('list_dispositions', () => call('list_dispositions'), (o) => 'total' in o);
await step('list_hours_of_operation', () => call('list_hours_of_operation'), (o) => 'total' in o);
await step('list_points_of_contact', () => call('list_points_of_contact'), (o) => 'total' in o);
await step('list_unavailable_codes', () => call('list_unavailable_codes'), (o) => 'total' in o);
await step('list_address_books', () => call('list_address_books'), (o) => 'total' in o);
await step('list_dnc_groups', () => call('list_dnc_groups'), (o) => 'total' in o);
await step('list_call_lists', () => call('list_call_lists'), (o) => 'total' in o);
await step('outbound_overview', () => call('outbound_overview'), (o) => Array.isArray(o.outboundSkills) && Array.isArray(o.dncGroups));
await step('list_scripts', () => call('list_scripts'), (o) => o.total >= 1);
await step('get_script (json)', () => call('get_script', { script: 'test_inbound' }), (o) => o.format === 'json' && o.script.header);
await step('get_script (xml fallback)', () => call('get_script', { script: 'FayServices_CallSuppression' }), (o) => o.format === 'xml' && o.xml.includes('ActionStruct'));
await step('render_script (json)', () => call('render_script', { script: 'test_inbound' }), (o) => o.mermaid.startsWith('flowchart'));
await step('render_script (xml)', () => call('render_script', { script: 'FayServices_CallSuppression' }), (o) => o.mermaid.includes('SNIPPET'));
await step('script_history', () => call('script_history', { script: 'test_inbound' }), (o) => o.script);
await step('cxone_api_call GET', () => call('cxone_api_call', { method: 'GET', path: 'media-types' }), (o) => JSON.stringify(o).includes('Phone'));

// ---------- refusal rails ----------
await step('cxone_api_call refuses DELETE (schema)', async () => {
  // DELETE is not in the enum; simulate dispatch-level attempt
  try { await call('cxone_api_call', { method: 'POST', path: 'skills/123/start' }); return { refused: false }; }
  catch (e) { return { refused: e.message.includes('never starts') }; }
}, (o) => o.refused);
await step('cxone_api_call refuses scripts/start', async () => {
  try { await call('cxone_api_call', { method: 'POST', path: 'scripts/start', body: {} }); return { refused: false }; }
  catch (e) { return { refused: e.message.includes('never starts') }; }
}, (o) => o.refused);
await step('cxone_api_call refuses startSkill:true', async () => {
  try { await call('cxone_api_call', { method: 'POST', path: 'lists/call-lists/1/upload', body: { startSkill: true } }); return { refused: false }; }
  catch (e) { return { refused: e.message.includes('startSkill') }; }
}, (o) => o.refused);

// ---------- IVR compose (no deploy) ----------
const spec = {
  name: `MCP_Test_IVR_${stamp}`,
  greeting: 'Thanks for calling outbound A N I.',
  menu: {
    prompt: 'Press 1 for sales, 2 for support, or 3 to hear our hours.',
    choices: [
      { digit: '1', action: 'transfer_to_skill', skill: 'Default Skill 4606137' },
      { digit: '2', action: 'transfer_to_skill', skill: 'Default Skill 4606137' },
      { digit: '3', action: 'play_message', message: 'We are open monday to friday, 9 to 7 eastern.' },
    ],
  },
};
await step('build_ivr', () => call('build_ivr', { spec }), (o) => o.valid && o.mermaid.includes('|1|'));
await step('build_ivr rejects bad spec', () => call('build_ivr', { spec: { name: '', menu: { prompt: '', choices: [] } } }), (o) => o.valid === false && o.errors.length);
const nestedSpec = {
  name: `MCP_Test_Nested_${stamp}`,
  greeting: 'Thanks for calling outbound A N I.',
  menu: {
    prompt: 'Press 1 for sales, or 2 for billing options.',
    choices: [
      { digit: '1', action: 'transfer_to_skill', skill: 'Default Skill 4606137', pre_transfer_message: 'Connecting you now.' },
      {
        digit: '2', action: 'submenu', name: 'Billing',
        menu: {
          prompt: 'Press 1 to hear our billing hours, or 9 to go back.',
          choices: [
            { digit: '1', action: 'play_message', message: 'Billing is open weekdays, 9 to 5 eastern.' },
            { digit: '9', action: 'previous_menu' },
          ],
        },
      },
    ],
  },
};
await step('build_ivr (nested submenu)', () => call('build_ivr', { spec: nestedSpec }), (o) => o.valid && o.mermaid.includes('|9 back|'));

// ---------- writes (sandbox only) ----------
if (WRITES) {
  console.log('\n--- write tools (MCP_Test_ artifacts) ---');
  const skillName = `MCP_Test_Skill_${stamp}`;
  const created = await step('create_skill (inbound phone)', () => call('create_skill', { name: skillName }), (o) => o.created);
  const obSkill = `MCP_Test_OB_${stamp}`;
  await step('create_skill (outbound)', () => call('create_skill', { name: obSkill, outbound: true }), (o) => o.created && o.note.includes('NOT RUNNING'));
  await step('configure_outbound_skill (retry + full-week schedule)', () => call('configure_outbound_skill', {
    skill: obSkill, max_attempts: 3, minimum_retry_minutes: 240,
    schedule: [
      { days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], start: '09:00', end: '19:00' },
      { days: ['saturday', 'sunday'], start: '10:00', end: '16:00' },
    ],
  }), (o) => o.retrySettings && o.scheduleSettings);
  await step('configure_outbound_skill refuses partial-week schedule', async () => {
    try {
      await call('configure_outbound_skill', { skill: obSkill, schedule: [{ days: ['monday'], start: '09:00', end: '19:00' }] });
      return { refused: false };
    } catch (e) { return { refused: e.message.includes('all 7 days') }; }
  }, (o) => o.refused);
  await step('create_campaign', () => call('create_campaign', { name: `MCP_Test_Campaign_${stamp}`, skills: [skillName] }), (o) => o.created && o.skillsAssigned === 1);
  await step('create_dispositions', () => call('create_dispositions', { names: [`MCP_Test_Disp_${stamp}`] }), (o) => o.created === 1);
  await step('create_hours_of_operation', () => call('create_hours_of_operation', {
    name: `MCP_Test_HOO_${stamp}`,
    windows: [{ days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], open: '09:00', close: '19:00' }],
  }), (o) => o.created);
  await step('create_unavailable_code', () => call('create_unavailable_code', { name: `MCP_Test_${stamp}` }), (o) => o.created);
  await step('create_dnc_group', () => call('create_dnc_group', { name: `MCP_Test_DNC_${stamp}`, numbers: ['5550100001'], scrub_skills: [obSkill] }), (o) => o.created && o.numbersAdded === 1);
  await step('get_dnc_group', () => call('get_dnc_group', { dnc_group: `MCP_Test_DNC_${stamp}` }), (o) => o.dncGroupId && o.scrubbedSkills);
  await step('assign_agent_skills', async () => {
    const agents = await call('list_agents');
    const me = agents.agents.find((x) => /api/i.test(x.name)) || agents.agents[0];
    return call('assign_agent_skills', { agent: String(me.agentId), skills: [skillName] });
  }, (o) => o.assigned === 1);
  await step('create_address_book + assign to skill', async () => {
    const ab = await call('create_address_book', {
      name: `MCP_Test_AB_${stamp}`,
      entries: [{ first_name: 'Front', last_name: 'Desk', phone: '5550100099' }],
    });
    if (!ab.created || ab.entriesAdded !== 1) throw new Error('create failed: ' + JSON.stringify(ab).slice(0, 200));
    return call('assign_address_book', { address_book: `MCP_Test_AB_${stamp}`, entity_type: 'Skill', entities: [skillName] });
  }, (o) => o.assigned);
  await step('upload_call_list (startSkill false)', () => call('upload_call_list', {
    name: `MCP_Test_List_${stamp}`, skill: obSkill,
    records: [
      { phone: '5550100011', first_name: 'Test', last_name: 'One', external_id: 'T1' },
      { phone: '5550100012', first_name: 'Test', last_name: 'Two', external_id: 'T2' },
    ],
  }), (o) => o.created && o.note.includes('startSkill FALSE'));
  const deploySpec = { ...spec, menu: { ...spec.menu, choices: spec.menu.choices.map((c) => c.action === 'transfer_to_skill' ? { ...c, skill: skillName } : c) } };
  const deployed = await step('deploy_script (spec)', () => call('deploy_script', { spec: deploySpec }), (o) => o.saved && o.errors === 0);
  if (deployed) {
    await step('render_script (deployed IVR)', () => call('render_script', { script: deploySpec.name }), (o) => o.mermaid.includes('MENU') || o.mermaid.includes('Main Menu') || o.mermaid.includes('Press 1'));
    await step('get_script (deployed IVR round-trip)', () => call('get_script', { script: deploySpec.name }), (o) => o.format === 'json' && Object.values(o.script.actions).some((a) => a.name === 'MENU'));
  }
  const nestedDeploy = { ...nestedSpec, menu: { ...nestedSpec.menu, choices: nestedSpec.menu.choices.map((c) => c.action === 'transfer_to_skill' ? { ...c, skill: skillName } : c) } };
  const nestedOk = await step('deploy_script (nested submenu IVR)', () => call('deploy_script', { spec: nestedDeploy }), (o) => o.saved && o.errors === 0);
  if (nestedOk) {
    await step('round-trip nested IVR (2 menus)', () => call('get_script', { script: nestedDeploy.name }), (o) =>
      o.format === 'json' && Object.values(o.script.actions).filter((a) => a.name === 'MENU').length === 2);
  }
}

console.log(`\n${pass} passed, ${fail} failed${WRITES ? ' (writes exercised)' : ' (read-only; use --writes in a sandbox)'}`);
process.exit(fail ? 1 : 0);
