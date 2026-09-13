// Studio script authoring: IVR spec validation, composition into the web
// Studio JSON format ({header, actions, properties, branches}), and Mermaid
// rendering (specs pre-deploy; existing scripts from their JSON or XML).
//
// Deploying goes through POST /scripts, which runs CXone's own server-side
// SYNTAX_CHECK before saving: its errors/warnings are the validation report,
// and this module formats them for the model to relay verbatim.
//
// Action library ids are CXone product constants (identical across tenants;
// verified against multiple orgs). The tenant's licensing still gates which
// actions are allowed - the syntax check reports "action-not-available" for
// anything the tenant can't run, and that message is surfaced as-is.

import { CxoneError } from './cxone.js';

// name -> { lib, props(ctx) } for the composable phone (mediaType 4) blocks.
export const ACTION_LIBRARY = {
  BEGIN:    'b2f794c5-0232-40e7-9830-76d573bf57d7',
  MENU:     'daee9c00-12ce-4222-a42e-307c37d53b7f',
  PLAY:     'b1b9a2dd-65b6-4626-9cf5-9cfa69cf59e2',
  REQAGENT: '689a4a1b-fa0d-47b3-9a02-cbeb4735f08f',
  MUSIC:    'dbcc742b-28d8-42d1-9d95-0d9abf20b04b',
  HANGUP:   'b64a6796-4f66-4b1b-a9b5-3af926ab4b7c',
  ASSIGN:   '9015c095-98d9-441f-bf92-e90f5c5ed8c8',
};

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'];
export const IVR_ACTIONS = ['transfer_to_skill', 'play_message', 'hangup'];

// ---------- spec validation ----------

// Spec: an inbound phone IVR with an optional TTS greeting and one DTMF menu.
// {
//   name, greeting?: "TTS text",
//   menu: {
//     prompt: "TTS text",
//     timeout_seconds?: 5,
//     no_input?: 'repeat' (default) | 'hangup',
//     choices: [ { digit: '0'-'9'|'*'|'#',
//                  action: 'transfer_to_skill'|'play_message'|'hangup',
//                  name?, skill? (name or id), message? (TTS),
//                  then? ('return_to_menu'|'hangup'), hold_music_seconds? } ]
//   }
// }
// transfer_to_skill queues the caller on a skill with hold music.
// play_message speaks TTS info and returns to the menu (default) or hangs up.
export function validateIvrSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['spec must be an object'] };

  const name = String(spec.name || '').trim();
  if (!name) errors.push('name is required');
  else if (!/^[\w][\w .\-]{0,99}$/.test(name)) errors.push('name must be 1-100 chars: letters, digits, spaces, dot, dash, underscore');

  const menu = spec.menu;
  if (!menu || typeof menu !== 'object') {
    errors.push('menu is required');
  } else {
    if (!String(menu.prompt || '').trim()) errors.push('menu.prompt (TTS text) is required');
    if (menu.no_input !== undefined && !['repeat', 'hangup'].includes(menu.no_input)) {
      errors.push(`menu.no_input must be repeat or hangup (got "${menu.no_input}")`);
    }
    const choices = menu.choices;
    if (!Array.isArray(choices) || !choices.length) {
      errors.push('menu.choices must be a non-empty array');
    } else {
      if (choices.length > 12) errors.push('menu.choices supports at most 12 choices (digits 0-9, *, #)');
      const seen = new Set();
      choices.forEach((c, i) => {
        const where = `choices[${i}]`;
        const d = String(c.digit);
        if (!DIGITS.includes(d)) errors.push(`${where}.digit must be one of 0-9, *, # (got "${c.digit}")`);
        else if (seen.has(d)) errors.push(`${where}: duplicate digit "${d}"`);
        seen.add(d);
        if (!IVR_ACTIONS.includes(c.action)) errors.push(`${where}.action must be one of ${IVR_ACTIONS.join(', ')}`);
        if (c.action === 'transfer_to_skill' && !String(c.skill || '').trim()) {
          errors.push(`${where}: transfer_to_skill requires a skill (name or id)`);
        }
        if (c.action === 'play_message') {
          if (!String(c.message || '').trim()) errors.push(`${where}: play_message requires message (TTS text)`);
          if (c.then !== undefined && !['return_to_menu', 'hangup'].includes(c.then)) {
            errors.push(`${where}.then must be return_to_menu or hangup (got "${c.then}")`);
          }
        }
      });
    }
  }
  return { ok: !errors.length, errors };
}

// ---------- composition ----------

// The Sequence prompt format: "%text" segments are TTS, each capped at 300
// chars; longer text splits into concatenated segments on word boundaries.
export function ttsSequence(text) {
  const clean = String(text).replace(/[\r\n\t]+/g, ' ').replace(/"/g, "'").trim();
  const segs = [];
  let rest = clean;
  while (rest.length > 300) {
    let cut = rest.lastIndexOf(' ', 300);
    if (cut < 200) cut = 300;
    segs.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  segs.push(rest);
  return segs.map((s) => `"%${s}"`).join(' ');
}

const P = (pairs) => Object.fromEntries(pairs.map(([name, value], i) => [String(i), { name, value }]));

const REQAGENT_PROPS = (skill) => P([
  ['Skill', String(skill)], ['TargetAgent', ''], ['PriorityManagement', 'DefaultfromSkill'],
  ['InitialPriority', '0'], ['Acceleration', '1'], ['Function', ''], ['MaxPriority', '1000'],
  ['Sequence', ''], ['ZipTone', 'AfterSequence'], ['ScreenPopSource', 'DefaultFromSkill'],
  ['ScreenPopURL', ''], ['HighProficiency', '1'], ['LowProficiency', '20'], ['RoutingAttribute', 'NotApplicable'],
]);

// Compose the spec into a saveable scriptContent. `busNo` comes from the
// session; `skillResolver` maps a skill name/id in the spec to the value
// REQAGENT wants (the skill NAME as Studio shows it).
export function specToScript(spec, busNo, resolveSkill = (s) => s) {
  const v = validateIvrSpec(spec);
  if (!v.ok) throw new CxoneError(`Invalid IVR spec: ${v.errors.join('; ')}`, 400);

  const actions = {};
  const properties = {};
  const branches = {};
  let nextId = 1;
  const add = (name, label, props, x, y) => {
    const id = nextId++;
    actions[id] = {
      actionId: id, libraryId: ACTION_LIBRARY[name], name, version: 1, label,
      dependencyOrder: String(id - 1), implType: '0', x, y, xws: x, yws: y,
    };
    properties[id] = props;
    return id;
  };
  const wire = (from, to, label = '', type = 'default') => {
    (branches[from] = branches[from] || []).push({
      to, label, type, index: branches[from].length ? branches[from].length : 0, ports: '', lineType: '', elbows: [],
    });
  };

  const begin = add('BEGIN', 'Begin', P([['RootFolder', ''], ['Application', ''], ['ParamCount', ''], ['Parameters', []]]), 60, 220);

  let menuFeed = begin;
  if (String(spec.greeting || '').trim()) {
    const greet = add('PLAY', 'Greeting',
      P([['Sequence', ttsSequence(spec.greeting)], ['Phrase', String(spec.greeting)], ['ClearDigits', 'False'], ['DetectDTMF', 'True']]),
      220, 220);
    wire(begin, greet);
    menuFeed = greet;
  }

  const menu = add('MENU', 'Main Menu', P([
    ['Sequence', ttsSequence(spec.menu.prompt)], ['Phrase', String(spec.menu.prompt)],
    ['ClearDigits', 'True'], ['MaxDigits', '1'], ['Terminator', '#-'],
    ['Timeout', String(spec.menu.timeout_seconds ?? 5)], ['InterDigitTimeout', '5'], ['Variable', 'MENUCHOICE'],
  ]), 400, 220);
  wire(menuFeed, menu);

  let hangup = null;
  const ensureHangup = () => {
    if (!hangup) hangup = add('HANGUP', 'Hangup', {}, 940, 420);
    return hangup;
  };

  let row = 0;
  for (const c of spec.menu.choices) {
    const y = 80 + row++ * 120;
    if (c.action === 'hangup') {
      wire(menu, ensureHangup(), String(c.digit), 'case');
      continue;
    }
    if (c.action === 'play_message') {
      const play = add('PLAY', c.name || 'Info',
        P([['Sequence', ttsSequence(c.message)], ['Phrase', String(c.message)], ['ClearDigits', 'True'], ['DetectDTMF', 'False']]),
        640, y);
      wire(menu, play, String(c.digit), 'case');
      if ((c.then || 'return_to_menu') === 'hangup') wire(play, ensureHangup());
      else wire(play, menu);
      continue;
    }
    // transfer_to_skill: queue on the skill, hold music while waiting. The
    // MUSIC loop is the canonical Studio hold pattern and keeps the
    // REQAGENT default branch wired (a bare REQAGENT draws a warning).
    const req = add('REQAGENT', c.name || `Queue: ${c.skill}`, REQAGENT_PROPS(resolveSkill(c.skill)), 640, y);
    const hold = add('MUSIC', 'Hold Music', P([
      ['MusicFile', 'Carefree Days.wav'], ['StartOffset', '0'],
      ['SecondstoPlay', String(c.hold_music_seconds ?? 30)], ['reserved1073742978', ''],
      ['InterruptMessages', ''], ['RepeatIndex', ''], ['DetectDTMF', 'False'], ['ClearDigits', 'True'],
    ]), 820, y);
    wire(menu, req, String(c.digit), 'case');
    wire(req, hold);
    wire(hold, hold); // loop until an agent answers
  }

  // No-input / no-match on the menu: repeat it (default) or hang up.
  if ((spec.menu.no_input || 'repeat') === 'hangup') wire(menu, ensureHangup());
  else wire(menu, menu);

  return {
    header: {
      scriptName: spec.name, busNo, mediaType: 4, mediaTypeName: 'call',
      purposeType: 'General', variableRedaction: '', libraryId: null, masterId: null,
      lockInfo: { lockedName: '', lockedId: '', lockedDate: '' },
      nextActionId: nextId, status: 'Active', lastSavedIn: '',
    },
    actions, properties, branches,
  };
}

// ---------- the syntax-check report ----------

// POST /scripts replies 200 (clean), 206 (saved with warnings), or 409
// (rejected) with a `results` array. Normalize it for the model.
export function formatSaveReport(res) {
  const r = Array.isArray(res?.results) ? res.results[0] : res;
  if (!r) return { saved: false, report: 'No response from the scripts endpoint.' };
  const details = r.error_code?.details;
  const issues = [];
  for (const [actionId, a] of Object.entries(details?.actions || {})) {
    for (const e of a.errors || []) issues.push({ severity: 'error', actionId, actionType: a.actionType, message: e.key });
    for (const w of a.warnings || []) issues.push({ severity: 'warning', actionId, actionType: a.actionType, message: w.key });
  }
  return {
    saved: Boolean(r.success),
    masterId: r.masterId,
    libraryId: r.libraryId,
    errors: Number(details?.totalErrors || 0),
    warnings: Number(details?.totalWarnings || 0),
    issues: issues.length ? issues : undefined,
    note: r.success
      ? (issues.length ? 'Saved. The warnings above are CXone\'s own syntax check - relay them verbatim.' : 'Saved clean: CXone\'s syntax check passed with no errors or warnings.')
      : 'REJECTED by CXone\'s syntax check - nothing was saved. The errors above are the server-side validation report.',
  };
}

// ---------- Mermaid rendering ----------

function mLabel(s, max = 60) {
  const t = String(s ?? '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function specToMermaid(spec) {
  const L = ['flowchart TD'];
  L.push(`  start(["📞 ${mLabel(spec.name)}"])`);
  let feed = 'start';
  if (String(spec.greeting || '').trim()) {
    L.push(`  greet["🔊 ${mLabel(spec.greeting)}"]`);
    L.push('  start --> greet');
    feed = 'greet';
  }
  L.push(`  menu{"${mLabel(spec.menu.prompt)}"}`);
  L.push(`  ${feed} --> menu`);
  spec.menu.choices.forEach((c, i) => {
    const id = `c${i}`;
    if (c.action === 'hangup') L.push(`  ${id}(("👋 ${mLabel(c.name || 'Hang up', 30)}"))`);
    else if (c.action === 'play_message') L.push(`  ${id}["🔈 ${mLabel(c.message, 45)}"]`);
    else L.push(`  ${id}[["🎧 Skill: ${mLabel(c.skill, 40)}"]]`);
    L.push(`  menu -->|${c.digit}| ${id}`);
    if (c.action === 'play_message' && (c.then || 'return_to_menu') === 'return_to_menu') L.push(`  ${id} -.-> menu`);
  });
  if ((spec.menu.no_input || 'repeat') === 'hangup') {
    L.push('  noin(("👋 no input: hang up"))');
    L.push('  menu -.->|no input| noin');
  }
  return L.join('\n');
}

// Render an EXISTING script from its web Studio JSON content. Faithful for
// the composable blocks; every other action renders as a labeled node, so
// any script in the org diagrams into instant documentation.
export function scriptJsonToMermaid(content) {
  const L = ['flowchart TD'];
  const actions = content.actions || {};
  const ICONS = { BEGIN: '📞', MENU: '☎️', PLAY: '🔊', MUSIC: '🎵', REQAGENT: '🎧', HANGUP: '👋', SNIPPET: '📜', ASSIGN: '🧮' };
  const propOf = (id, name) => Object.values(content.properties?.[id] || {}).find((p) => p?.name === name)?.value;
  for (const [id, a] of Object.entries(actions)) {
    const icon = ICONS[a.name] || '⚙️';
    let label = a.label || a.name;
    if (a.name === 'MENU' || a.name === 'PLAY') label = propOf(id, 'Phrase') || label;
    if (a.name === 'REQAGENT') label = `Skill: ${propOf(id, 'Skill') || '?'}`;
    const shape = a.name === 'MENU' ? [`{"`, `"}`] : a.name === 'HANGUP' ? ['(("', '"))'] : a.name === 'REQAGENT' ? ['[["', '"]]'] : ['["', '"]'];
    L.push(`  a${id}${shape[0]}${icon} ${mLabel(label, 50)}${shape[1]}`);
  }
  for (const [from, list] of Object.entries(content.branches || {})) {
    for (const b of list || []) {
      if (!actions[b.to]) continue;
      const label = b.label ? `|${mLabel(b.label, 20)}|` : (b.type && b.type !== 'default' ? `|${b.type}|` : '');
      L.push(`  a${from} -->${label} a${b.to}`);
    }
  }
  return L.join('\n');
}

// Best-effort render for Desktop-Studio-only scripts from their exported XML
// (base64 `body` from GET /scripts/{id}). Regex-parsed on purpose: the XSD
// is undocumented and this only needs captions and wiring, not fidelity.
export function scriptXmlToMermaid(xml) {
  const L = ['flowchart TD'];
  const blocks = String(xml).split('<ActionStruct>').slice(1);
  const nodes = [];
  for (const b of blocks) {
    const id = b.match(/<ActionID>(\d+)<\/ActionID>/)?.[1];
    const name = b.match(/<Action>([A-Za-z0-9_]+)<\/Action>/)?.[1] || '?';
    const caption = b.match(/<Caption>([\s\S]*?)<\/Caption>/)?.[1] || name;
    if (!id) continue;
    nodes.push(id);
    L.push(`  a${id}["${mLabel(`${name}: ${caption}`, 50)}"]`);
    const next = b.match(/<DefaultNextAction>[\s\S]*?<ActionID>(-?\d+)<\/ActionID>/)?.[1];
    if (next && next !== '-1') L.push(`  a${id} --> a${next}`);
    const cases = b.split('<BranchStruct>').slice(1);
    for (const c of cases) {
      const text = c.match(/<Text>([\s\S]*?)<\/Text>/)?.[1] ?? '';
      const target = c.match(/<ActionID>(-?\d+)<\/ActionID>/)?.[1];
      if (target && target !== '-1') L.push(`  a${id} -->|${mLabel(text || '?', 16)}| a${target}`);
    }
  }
  if (!nodes.length) L.push('  empty["(no actions parsed)"]');
  return L.join('\n');
}
