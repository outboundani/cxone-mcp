// Studio script authoring: IVR spec validation, composition into the web
// Studio JSON format ({header, actions, properties, branches}), and Mermaid
// rendering (specs pre-deploy; existing scripts from their JSON or XML).
//
// Deploying goes through POST /scripts, which runs CXone's own server-side
// SYNTAX_CHECK before saving: its errors/warnings are the validation report,
// and this module formats them for the model to relay verbatim.
//
// Action library ids are CXone product constants: the same GUID identifies
// an action type on every tenant (verified against multiple orgs and public
// script exports). The tenant's licensing still gates which actions are
// allowed - the syntax check reports "action-not-available" for anything the
// tenant can't run, and that message is surfaced as-is.
//
// Save-endpoint realities, learned the hard way and honored here:
//   - every action MUST carry integer xws/yws workspace coordinates (the GET
//     shape omits them; the POST validator demands them per action)
//   - custom DTMF branches are {type: "case", label: "<digit>"}
//   - the script NAME is the identity: saving an existing name overwrites
//     (a new masterID is minted; history survives)

import { CxoneError } from './cxone.js';

// Verified action-name -> library GUID constants (phone scripts, mediaType 4).
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
export const IVR_ACTIONS = ['transfer_to_skill', 'play_message', 'submenu', 'hangup', 'previous_menu'];
const MAX_MENU_DEPTH = 3;

// ---------- spec validation ----------

// Spec: an inbound phone IVR with an optional TTS greeting and a DTMF menu
// tree (submenus nest up to 3 levels).
// {
//   name, greeting?: "TTS text",
//   menu: {
//     prompt: "TTS text",
//     timeout_seconds?: 5,
//     no_input?: 'repeat' (default) | 'hangup',
//     choices: [ { digit: '0'-'9'|'*'|'#',
//                  action: 'transfer_to_skill'|'play_message'|'submenu'|'hangup'|'previous_menu',
//                  name?,
//                  skill? (name or id), pre_transfer_message? (TTS), hold_music_seconds?,
//                  message? (TTS), then? ('return_to_menu'|'hangup'),
//                  menu? (a nested menu object, same shape) } ]
//   }
// }
// transfer_to_skill queues the caller on a skill (optional pre-transfer TTS,
// then hold music). play_message speaks TTS info and returns to its menu
// (default) or hangs up. submenu opens a nested menu. previous_menu (submenus
// only) returns the caller to the parent menu.
export function validateIvrSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return { ok: false, errors: ['spec must be an object'] };

  const name = String(spec.name || '').trim();
  if (!name) errors.push('name is required');
  else if (!/^[\w][\w .\-]{0,99}$/.test(name)) errors.push('name must be 1-100 chars: letters, digits, spaces, dot, dash, underscore');

  const checkMenu = (menu, path, depth) => {
    if (!menu || typeof menu !== 'object') { errors.push(`${path} is required`); return; }
    if (depth > MAX_MENU_DEPTH) { errors.push(`${path}: menus nest at most ${MAX_MENU_DEPTH} levels deep`); return; }
    if (!String(menu.prompt || '').trim()) errors.push(`${path}.prompt (TTS text) is required`);
    if (menu.timeout_seconds !== undefined && !(Number(menu.timeout_seconds) >= 1 && Number(menu.timeout_seconds) <= 60)) {
      errors.push(`${path}.timeout_seconds must be 1-60`);
    }
    if (menu.no_input !== undefined && !['repeat', 'hangup'].includes(menu.no_input)) {
      errors.push(`${path}.no_input must be repeat or hangup (got "${menu.no_input}")`);
    }
    const choices = menu.choices;
    if (!Array.isArray(choices) || !choices.length) { errors.push(`${path}.choices must be a non-empty array`); return; }
    if (choices.length > 12) errors.push(`${path}.choices supports at most 12 choices (digits 0-9, *, #)`);
    const seen = new Set();
    choices.forEach((c, i) => {
      const where = `${path}.choices[${i}]`;
      const d = String(c.digit);
      if (!DIGITS.includes(d)) errors.push(`${where}.digit must be one of 0-9, *, # (got "${c.digit}")`);
      else if (seen.has(d)) errors.push(`${where}: duplicate digit "${d}"`);
      seen.add(d);
      if (!IVR_ACTIONS.includes(c.action)) { errors.push(`${where}.action must be one of ${IVR_ACTIONS.join(', ')}`); return; }
      if (c.action === 'transfer_to_skill' && !String(c.skill || '').trim()) {
        errors.push(`${where}: transfer_to_skill requires a skill (name or id)`);
      }
      if (c.action === 'play_message') {
        if (!String(c.message || '').trim()) errors.push(`${where}: play_message requires message (TTS text)`);
        if (c.then !== undefined && !['return_to_menu', 'hangup'].includes(c.then)) {
          errors.push(`${where}.then must be return_to_menu or hangup (got "${c.then}")`);
        }
      }
      if (c.action === 'submenu') {
        if (!c.menu) errors.push(`${where}: submenu requires a nested menu`);
        else checkMenu(c.menu, `${where}.menu`, depth + 1);
      }
      if (c.action === 'previous_menu' && depth === 1) {
        errors.push(`${where}: previous_menu only makes sense inside a submenu (the main menu has no parent)`);
      }
    });
  };
  checkMenu(spec.menu, 'menu', 1);
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

// Verified property vectors (names and defaults lifted from live scripts).
const PROPS = {
  BEGIN: () => P([['RootFolder', ''], ['Application', ''], ['ParamCount', ''], ['Parameters', []]]),
  MENU: (prompt, timeout) => P([
    ['Sequence', ttsSequence(prompt)], ['Phrase', String(prompt)],
    ['ClearDigits', 'True'], ['MaxDigits', '1'], ['Terminator', '#-'],
    ['Timeout', String(timeout ?? 5)], ['InterDigitTimeout', '5'], ['Variable', 'MENUCHOICE'],
  ]),
  PLAY: (text, { clear = true, detectDtmf = false } = {}) => P([
    ['Sequence', ttsSequence(text)], ['Phrase', String(text)],
    ['ClearDigits', clear ? 'True' : 'False'], ['DetectDTMF', detectDtmf ? 'True' : 'False'],
  ]),
  REQAGENT: (skill) => P([
    ['Skill', String(skill)], ['TargetAgent', ''], ['PriorityManagement', 'DefaultfromSkill'],
    ['InitialPriority', '0'], ['Acceleration', '1'], ['Function', ''], ['MaxPriority', '1000'],
    ['Sequence', ''], ['ZipTone', 'AfterSequence'], ['ScreenPopSource', 'DefaultFromSkill'],
    ['ScreenPopURL', ''], ['HighProficiency', '1'], ['LowProficiency', '20'], ['RoutingAttribute', 'NotApplicable'],
  ]),
  MUSIC: (seconds) => P([
    ['MusicFile', 'Carefree Days.wav'], ['StartOffset', '0'],
    ['SecondstoPlay', String(seconds ?? 30)], ['reserved1073742978', ''],
    ['InterruptMessages', ''], ['RepeatIndex', ''], ['DetectDTMF', 'False'], ['ClearDigits', 'True'],
  ]),
  HANGUP: () => ({}),
};

// Compose the spec into a saveable scriptContent. `busNo` comes from the
// session; `resolveSkill` maps a skill name/id in the spec to the exact
// skill NAME Studio expects on REQAGENT.
export function specToScript(spec, busNo, resolveSkill = (s) => s) {
  const v = validateIvrSpec(spec);
  if (!v.ok) throw new CxoneError(`Invalid IVR spec: ${v.errors.join('; ')}`, 400);

  const actions = {};
  const properties = {};
  const branches = {};
  let nextId = 1;
  // Column layout: depth 0 = BEGIN/greeting, each menu level one column
  // right, leaf chains rightmost. nextY tracks rows per column.
  const nextY = {};
  const place = (col) => {
    nextY[col] = (nextY[col] ?? 40) + 110;
    return { x: 60 + col * 230, y: nextY[col] };
  };
  const add = (name, label, props, col) => {
    const id = nextId++;
    const { x, y } = place(col);
    actions[id] = {
      actionId: id, libraryId: ACTION_LIBRARY[name], name, version: 1, label,
      dependencyOrder: String(id - 1), implType: '0', x, y, xws: x, yws: y,
    };
    properties[id] = props;
    return id;
  };
  const wire = (from, to, label = '', type = 'default') => {
    const list = (branches[from] = branches[from] || []);
    list.push({ to, label, type, index: list.length, ports: '', lineType: '', elbows: [] });
  };

  const begin = add('BEGIN', 'Begin', PROPS.BEGIN(), 0);

  let menuFeed = begin;
  if (String(spec.greeting || '').trim()) {
    // DetectDTMF on the greeting lets impatient callers key ahead.
    const greet = add('PLAY', 'Greeting', PROPS.PLAY(spec.greeting, { clear: false, detectDtmf: true }), 0);
    wire(begin, greet);
    menuFeed = greet;
  }

  let hangup = null;
  const ensureHangup = () => {
    if (!hangup) hangup = add('HANGUP', 'Hangup', PROPS.HANGUP(), 5);
    return hangup;
  };

  // Recursively add a menu and everything hanging off it. parentMenuId is
  // null for the main menu (previous_menu is rejected there by validation).
  const addMenu = (menu, depth, parentMenuId, label) => {
    const col = depth; // main menu at column 1
    const menuId = add('MENU', label, PROPS.MENU(menu.prompt, menu.timeout_seconds), col);
    for (const c of menu.choices) {
      const digit = String(c.digit);
      if (c.action === 'hangup') {
        wire(menuId, ensureHangup(), digit, 'case');
        continue;
      }
      if (c.action === 'previous_menu') {
        wire(menuId, parentMenuId, digit, 'case');
        continue;
      }
      if (c.action === 'play_message') {
        const play = add('PLAY', c.name || 'Info', PROPS.PLAY(c.message), col + 1);
        wire(menuId, play, digit, 'case');
        if ((c.then || 'return_to_menu') === 'hangup') wire(play, ensureHangup());
        else wire(play, menuId);
        continue;
      }
      if (c.action === 'submenu') {
        const subId = addMenu(c.menu, depth + 1, menuId, c.name || `Submenu ${digit}`);
        wire(menuId, subId, digit, 'case');
        continue;
      }
      // transfer_to_skill: optional pre-transfer TTS, queue on the skill,
      // hold music while waiting. The MUSIC self-loop is the canonical
      // Studio hold pattern and keeps every default branch wired (bare
      // REQAGENTs draw "default branch is not wired up" warnings).
      let target;
      const req = add('REQAGENT', c.name || `Queue: ${c.skill}`, PROPS.REQAGENT(resolveSkill(c.skill)), col + 1);
      if (String(c.pre_transfer_message || '').trim()) {
        const pre = add('PLAY', 'Pre-transfer', PROPS.PLAY(c.pre_transfer_message), col + 1);
        wire(pre, req);
        target = pre;
      } else {
        target = req;
      }
      const hold = add('MUSIC', 'Hold Music', PROPS.MUSIC(c.hold_music_seconds), col + 2);
      wire(menuId, target, digit, 'case');
      wire(req, hold);
      wire(hold, hold);
    }
    // No-input / no-match: repeat this menu (default) or hang up.
    if ((menu.no_input || 'repeat') === 'hangup') wire(menuId, ensureHangup());
    else wire(menuId, menuId);
    return menuId;
  };

  const mainMenu = addMenu(spec.menu, 1, null, 'Main Menu');
  wire(menuFeed, mainMenu);

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
// (rejected, nothing saved) with a `results` array. Normalize it so the
// model can relay CXone's own validation verdict verbatim.
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
  let n = 0;
  const uid = (p) => `${p}${n++}`;
  L.push(`  start(["📞 ${mLabel(spec.name)}"])`);
  let feed = 'start';
  if (String(spec.greeting || '').trim()) {
    L.push(`  greet["🔊 ${mLabel(spec.greeting)}"]`);
    L.push('  start --> greet');
    feed = 'greet';
  }
  const drawMenu = (menu, parentId) => {
    const id = uid('m');
    L.push(`  ${id}{"${mLabel(menu.prompt)}"}`);
    for (const c of menu.choices) {
      if (c.action === 'previous_menu') {
        L.push(`  ${id} -.->|${c.digit} back| ${parentId}`);
        continue;
      }
      if (c.action === 'submenu') {
        const sub = drawMenu(c.menu, id);
        L.push(`  ${id} -->|${c.digit}| ${sub}`);
        continue;
      }
      const cid = uid('c');
      if (c.action === 'hangup') L.push(`  ${cid}(("👋 ${mLabel(c.name || 'Hang up', 30)}"))`);
      else if (c.action === 'play_message') L.push(`  ${cid}["🔈 ${mLabel(c.message, 45)}"]`);
      else L.push(`  ${cid}[["🎧 Skill: ${mLabel(c.skill, 40)}"]]`);
      L.push(`  ${id} -->|${c.digit}| ${cid}`);
      if (c.action === 'play_message' && (c.then || 'return_to_menu') === 'return_to_menu') L.push(`  ${cid} -.-> ${id}`);
    }
    if ((menu.no_input || 'repeat') === 'hangup') {
      const noin = uid('c');
      L.push(`  ${noin}(("👋 no input"))`);
      L.push(`  ${id} -.->|no input| ${noin}`);
    }
    return id;
  };
  const main = drawMenu(spec.menu, null);
  L.push(`  ${feed} --> ${main}`);
  return L.join('\n');
}

// Render an EXISTING script from its web Studio JSON content. Faithful for
// the composable blocks; every other action renders as a labeled node, so
// any script in the tenant diagrams into instant documentation.
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
    const shape = a.name === 'MENU' ? ['{"', '"}'] : a.name === 'HANGUP' ? ['(("', '"))'] : a.name === 'REQAGENT' ? ['[["', '"]]'] : ['["', '"]'];
    L.push(`  a${id}${shape[0]}${icon} ${mLabel(label, 50)}${shape[1]}`);
  }
  for (const [from, list] of Object.entries(content.branches || {})) {
    for (const b of list || []) {
      if (!actions[b.to]) continue;
      const label = b.label ? `|${mLabel(b.label, 16)}|` : (b.type && b.type !== 'default' ? `|${b.type}|` : '');
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
