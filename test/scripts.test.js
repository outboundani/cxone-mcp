import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIvrSpec, specToScript, specToMermaid, ttsSequence,
  formatSaveReport, scriptJsonToMermaid, scriptXmlToMermaid, ACTION_LIBRARY,
} from '../src/scripts.js';

const GOOD_SPEC = {
  name: 'MCP_Test_IVR',
  greeting: 'Thanks for calling outboundANI.',
  menu: {
    prompt: 'Press 1 for sales, 2 for support, or 3 to hear our hours.',
    choices: [
      { digit: '1', action: 'transfer_to_skill', skill: 'Sales' },
      { digit: '2', action: 'transfer_to_skill', skill: 'Support' },
      { digit: '3', action: 'play_message', message: 'We are open 9 to 7 eastern.' },
      { digit: '9', action: 'hangup' },
    ],
  },
};

test('validateIvrSpec accepts a good spec', () => {
  assert.deepEqual(validateIvrSpec(GOOD_SPEC), { ok: true, errors: [] });
});

test('validateIvrSpec catches missing fields and bad digits', () => {
  const v = validateIvrSpec({ name: '', menu: { prompt: '', choices: [{ digit: 'x', action: 'nope' }, { digit: '1', action: 'transfer_to_skill' }] } });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('name is required')));
  assert.ok(v.errors.some((e) => e.includes('menu.prompt')));
  assert.ok(v.errors.some((e) => e.includes('digit')));
  assert.ok(v.errors.some((e) => e.includes('requires a skill')));
});

test('validateIvrSpec rejects duplicate digits', () => {
  const v = validateIvrSpec({
    name: 'x',
    menu: { prompt: 'p', choices: [{ digit: '1', action: 'hangup' }, { digit: '1', action: 'hangup' }] },
  });
  assert.ok(v.errors.some((e) => e.includes('duplicate digit')));
});

test('ttsSequence wraps text and splits over 300 chars', () => {
  assert.equal(ttsSequence('hello there'), '"%hello there"');
  const long = 'word '.repeat(100).trim(); // 499 chars
  const seq = ttsSequence(long);
  const segs = seq.match(/"%[^"]+"/g);
  assert.ok(segs.length >= 2);
  for (const s of segs) assert.ok(s.length <= 304);
  assert.equal(ttsSequence('she said "hi"'), `"%she said 'hi'"`);
});

test('specToScript composes a valid scriptContent', () => {
  const s = specToScript(GOOD_SPEC, 4606137, (name) => name);
  assert.equal(s.header.scriptName, 'MCP_Test_IVR');
  assert.equal(s.header.busNo, 4606137);
  assert.equal(s.header.mediaType, 4);
  const actions = Object.values(s.actions);
  const names = actions.map((a) => a.name);
  assert.ok(names.includes('BEGIN'));
  assert.ok(names.includes('MENU'));
  assert.equal(names.filter((n) => n === 'REQAGENT').length, 2);
  assert.equal(names.filter((n) => n === 'MUSIC').length, 2);
  assert.ok(names.includes('PLAY')); // greeting + info message
  assert.ok(names.includes('HANGUP'));
  // every action carries the workspace coordinates the save endpoint requires
  for (const a of actions) {
    assert.equal(typeof a.xws, 'number');
    assert.equal(typeof a.yws, 'number');
    assert.equal(a.libraryId, ACTION_LIBRARY[a.name]);
  }
  // the menu wires a case branch per digit
  const menuId = actions.find((a) => a.name === 'MENU').actionId;
  const cases = s.branches[menuId].filter((b) => b.type === 'case');
  assert.deepEqual(cases.map((b) => b.label).sort(), ['1', '2', '3', '9']);
  // every REQAGENT default branch is wired (to hold music)
  for (const a of actions.filter((x) => x.name === 'REQAGENT')) {
    assert.ok(s.branches[a.actionId]?.length, 'REQAGENT branch wired');
  }
  // nextActionId is past every used id
  assert.ok(s.header.nextActionId > Math.max(...actions.map((a) => a.actionId)));
});

test('specToScript resolves skills through the resolver', () => {
  const s = specToScript(GOOD_SPEC, 1, (name) => `RESOLVED ${name}`);
  const req = Object.entries(s.actions).find(([, a]) => a.name === 'REQAGENT')[0];
  const skillProp = Object.values(s.properties[req]).find((p) => p.name === 'Skill');
  assert.equal(skillProp.value, 'RESOLVED Sales');
});

test('specToScript with no_input hangup wires menu default to HANGUP', () => {
  const spec = { ...GOOD_SPEC, menu: { ...GOOD_SPEC.menu, no_input: 'hangup' } };
  const s = specToScript(spec, 1);
  const actions = Object.values(s.actions);
  const menuId = actions.find((a) => a.name === 'MENU').actionId;
  const hangupId = actions.find((a) => a.name === 'HANGUP').actionId;
  const def = s.branches[menuId].find((b) => b.type === 'default');
  assert.equal(def.to, hangupId);
});

test('specToMermaid renders every choice', () => {
  const m = specToMermaid(GOOD_SPEC);
  assert.ok(m.startsWith('flowchart TD'));
  assert.ok(m.includes('|1|'));
  assert.ok(m.includes('|9|'));
  assert.ok(m.includes('Skill: Sales'));
});

test('formatSaveReport normalizes a warning save', () => {
  const r = formatSaveReport({
    results: [{
      success: true, masterId: 1, libraryId: 'x',
      error_code: { details: { totalErrors: '0', totalWarnings: '1', actions: { 3: { actionType: 'REQAGENT', errors: [], warnings: [{ key: 'not wired' }] } } } },
    }],
  });
  assert.equal(r.saved, true);
  assert.equal(r.warnings, 1);
  assert.equal(r.issues[0].severity, 'warning');
});

test('formatSaveReport normalizes a rejection', () => {
  const r = formatSaveReport({
    results: [{
      success: false,
      error_code: { details: { totalErrors: '1', totalWarnings: '0', actions: { 5: { actionType: 'HANGUP', errors: [{ key: 'action-not-available' }], warnings: [] } } } },
    }],
  });
  assert.equal(r.saved, false);
  assert.equal(r.errors, 1);
  assert.ok(r.note.includes('REJECTED'));
});

test('scriptJsonToMermaid renders a composed script', () => {
  const s = specToScript(GOOD_SPEC, 1);
  const m = scriptJsonToMermaid(s);
  assert.ok(m.startsWith('flowchart TD'));
  assert.ok(m.includes('Skill: Sales'));
  assert.ok(m.includes('-->'));
});

const NESTED_SPEC = {
  name: 'MCP_Test_Nested',
  greeting: 'Thanks for calling.',
  menu: {
    prompt: 'Press 1 for sales, 2 for billing options.',
    choices: [
      { digit: '1', action: 'transfer_to_skill', skill: 'Sales', pre_transfer_message: 'Connecting you to sales.' },
      {
        digit: '2', action: 'submenu', name: 'Billing',
        menu: {
          prompt: 'Press 1 for balance, 2 for payments, 9 to go back.',
          choices: [
            { digit: '1', action: 'play_message', message: 'Your balance is available online.' },
            { digit: '2', action: 'transfer_to_skill', skill: 'Billing' },
            { digit: '9', action: 'previous_menu' },
          ],
        },
      },
    ],
  },
};

test('validateIvrSpec accepts nested submenus with previous_menu', () => {
  assert.deepEqual(validateIvrSpec(NESTED_SPEC), { ok: true, errors: [] });
});

test('validateIvrSpec rejects previous_menu on the main menu', () => {
  const v = validateIvrSpec({ name: 'x', menu: { prompt: 'p', choices: [{ digit: '9', action: 'previous_menu' }] } });
  assert.ok(v.errors.some((e) => e.includes('previous_menu')));
});

test('validateIvrSpec rejects submenu without a nested menu and over-deep nesting', () => {
  const v = validateIvrSpec({ name: 'x', menu: { prompt: 'p', choices: [{ digit: '1', action: 'submenu' }] } });
  assert.ok(v.errors.some((e) => e.includes('submenu requires a nested menu')));
  const deep = { prompt: 'p', choices: [{ digit: '1', action: 'hangup' }] };
  const wrap = (m) => ({ prompt: 'p', choices: [{ digit: '1', action: 'submenu', menu: m }] });
  const v2 = validateIvrSpec({ name: 'x', menu: wrap(wrap(wrap(deep))) });
  assert.ok(v2.errors.some((e) => e.includes('nest at most')));
});

test('specToScript composes submenus, pre-transfer, and back-branches', () => {
  const s = specToScript(NESTED_SPEC, 4606137, (n) => n);
  const actions = Object.values(s.actions);
  const menus = actions.filter((a) => a.name === 'MENU');
  assert.equal(menus.length, 2);
  // pre-transfer PLAY exists and feeds the Sales REQAGENT
  const pre = actions.find((a) => a.name === 'PLAY' && a.label === 'Pre-transfer');
  assert.ok(pre);
  const sales = actions.find((a) => a.name === 'REQAGENT' && a.label.includes('Sales'));
  assert.equal(s.branches[pre.actionId][0].to, sales.actionId);
  // main menu case 2 goes to the submenu; submenu case 9 comes back
  const [main, sub] = menus.map((m) => m.actionId).sort((a, b) => a - b);
  const mainCases = s.branches[main].filter((b) => b.type === 'case');
  assert.ok(mainCases.some((b) => b.label === '2' && b.to === sub));
  const subCases = s.branches[sub].filter((b) => b.type === 'case');
  assert.ok(subCases.some((b) => b.label === '9' && b.to === main));
  // play_message inside the submenu returns to the SUBMENU, not the main menu
  const info = actions.find((a) => a.name === 'PLAY' && a.label === 'Info');
  assert.equal(s.branches[info.actionId][0].to, sub);
});

test('specToMermaid renders nested menus and back edges', () => {
  const m = specToMermaid(NESTED_SPEC);
  assert.equal((m.match(/\{"/g) || []).length, 2); // two menu diamonds
  assert.ok(m.includes('|9 back|'));
  assert.ok(m.includes('Skill: Billing'));
});

test('scriptXmlToMermaid parses ActionStructs', () => {
  const xml = `<Actions><ActionStruct><ActionID>1</ActionID><Action>BEGIN</Action><Caption>Begin</Caption>
    <DefaultNextAction><Text /><ActionID>2</ActionID></DefaultNextAction></ActionStruct>
    <ActionStruct><ActionID>2</ActionID><Action>MENU</Action><Caption>Main</Caption>
    <Cases><BranchStruct><Text>1</Text><ActionID>1</ActionID></BranchStruct></Cases></ActionStruct></Actions>`;
  const m = scriptXmlToMermaid(xml);
  assert.ok(m.includes('BEGIN: Begin'));
  assert.ok(m.includes('a1 --> a2'));
  assert.ok(m.includes('|1|'));
});
