// MCP tool definitions + dispatch. Each tool maps to one or two CXone ACD
// Admin API calls and returns plain JSON for the model.
//
// Scope is deliberate: config reads + create/build actions. NO analytics/KPI
// tools, and NO dialing ignition: outbound skills are never started, call
// list uploads always land with startSkill false, and the raw API tool
// refuses DELETE and every start/spawn path. A human presses go.
//
// CXone vocabulary guardrail (it differs from Five9/Genesys): a SKILL is the
// queue/campaign workhorse (outbound skills carry the dialer config); a
// CAMPAIGN is just a reporting rollup of skills; a POINT OF CONTACT maps a
// DNIS/entry point to a script.
//
// API realities these tools encode (all verified live; the swagger drifts):
//   - several create endpoints are batch-shaped and can return HTTP 200
//     with a per-item failure inside (skills, teams, agents) - always parse
//     the *Results array, never trust the status code alone
//   - campaigns create only accepts the flat {name, isActive} body on
//     v33.0; campaign-skill assignment wants {skills: [{skillId}]}
//   - inbound phone skills require serviceLevelThreshold/Goal and
//     enableShortAbandon/shortAbandonThreshold despite the docs
//   - call-list creation takes listName/externalIdColumn as QUERY params
//     and maps the phone column via destinationMappings "PhoneNumber"
//   - DNC records are {dncGroupRecords: [{phoneNumber: <integer>}]}
//   - hours-of-operation GET requires isDeleted; script history wants
//     scriptPath; skills list can lag a create by a few seconds

import { CxoneClient, CxoneError } from './cxone.js';
import { ABOUT } from './about.js';
import {
  validateIvrSpec, specToScript, specToMermaid, formatSaveReport,
  scriptJsonToMermaid, scriptXmlToMermaid, ACTION_LIBRARY,
} from './scripts.js';

// ---------- shared helpers ----------

// Batch-shaped endpoints (POST /skills, /teams, /agents) answer HTTP 200
// with {errorCount, xxxResults: [{success, error?, ...}]}. Surface the
// per-item verdict as the real result.
function batchResult(res, key, what) {
  const item = res?.[key]?.[0] || res?.[what + 's']?.[0] || res;
  if (item?.success === false) throw new CxoneError(`CXone rejected the ${what}: ${item.error}`, 400);
  return item || {};
}

async function resolveSkill(cx, ref) {
  if (/^\d+$/.test(String(ref))) return { skillId: Number(ref), skillName: String(ref) };
  // One retry with a short wait: a just-created skill can lag the list by a
  // few seconds on some clusters.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { entities } = await cx.listAll('skills', 'skills', {}, { max: 1000 });
    const matches = entities.filter((s) => s.skillName?.toLowerCase() === String(ref).toLowerCase());
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new CxoneError(`Ambiguous skill "${ref}" - use the skillId.`, 409);
    const wide = entities.filter((s) => s.skillName?.toLowerCase().includes(String(ref).toLowerCase()));
    if (wide.length === 1) return wide[0];
    if (wide.length > 1) throw new CxoneError(`Ambiguous skill "${ref}" - matches: ${wide.map((s) => s.skillName).join(', ')}`, 409);
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2500));
  }
  throw new CxoneError(`No skill found matching "${ref}"`, 404);
}

async function resolveAgent(cx, ref) {
  if (/^\d+$/.test(String(ref))) return { agentId: Number(ref) };
  const { entities } = await cx.listAll('agents', 'agents', { isActive: true }, { max: 2000 });
  const q = String(ref).toLowerCase();
  const exact = entities.filter((a) => a.emailAddress?.toLowerCase() === q || a.userName?.toLowerCase() === q
    || `${a.firstName} ${a.lastName}`.toLowerCase() === q);
  const matches = exact.length ? exact : entities.filter((a) => `${a.firstName} ${a.lastName} ${a.emailAddress || ''}`.toLowerCase().includes(q));
  if (!matches.length) throw new CxoneError(`No agent found matching "${ref}"`, 404);
  if (matches.length > 1) {
    throw new CxoneError(`Ambiguous agent "${ref}" - matches: ${matches.slice(0, 8).map((a) => `${a.firstName} ${a.lastName} <${a.emailAddress}>`).join(', ')}. Use the email or agentId.`, 409);
  }
  return matches[0];
}

async function resolveTeam(cx, ref) {
  if (/^\d+$/.test(String(ref))) return { teamId: Number(ref), teamName: String(ref) };
  const { entities } = await cx.listAll('teams', 'teams', {}, { max: 500 });
  const matches = entities.filter((t) => t.teamName?.toLowerCase() === String(ref).toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new CxoneError(`Ambiguous team "${ref}" - use the teamId.`, 409);
  throw new CxoneError(`No team found matching "${ref}"`, 404);
}

async function resolveScript(cx, ref) {
  const search = await cx.get('scripts/search', /^\d+$/.test(String(ref)) ? {} : { scriptName: ref });
  const rows = (search.scriptSearchDetails || []).filter((s) => s.status === 'CURR');
  const matches = /^\d+$/.test(String(ref))
    ? (search.scriptSearchDetails || []).filter((s) => String(s.masterID) === String(ref))
    : rows.filter((s) => s.scriptName?.toLowerCase() === String(ref).toLowerCase());
  const found = matches.length ? matches : rows;
  if (!found.length) throw new CxoneError(`No script found matching "${ref}"`, 404);
  if (found.length > 1) throw new CxoneError(`Ambiguous script "${ref}" - matches: ${found.map((s) => s.scriptName).join(', ')}`, 409);
  return found[0];
}

async function resolveCampaign(cx, ref) {
  const { entities } = await cx.listAll('campaigns', 'campaigns', {}, { max: 500 });
  const m = entities.find((c) => String(c.campaignId) === String(ref) || c.campaignName?.toLowerCase() === String(ref).toLowerCase());
  if (!m) throw new CxoneError(`No campaign found matching "${ref}"`, 404);
  return m;
}

const HHMM = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_LOWER = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MEDIA = { email: 1, chat: 3, phone: 4, voicemail: 5, workitem: 6, sms: 7, digital: 9 };

// ---------- tools ----------

export const TOOLS = [
  {
    name: 'about',
    description: 'Who operates this server, why it exists, and the ground rules (including the CXone vocabulary guide: skills dial, campaigns report, points of contact wire numbers to scripts). Call this when you need context about the operator or how to behave.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    cxone: false,
    handler: () => ABOUT,
  },
  {
    name: 'check_connection',
    description: 'Verify that the Worker can authenticate to CXone. Returns the tenant, business unit, cluster, discovered API host, role, and object counts (skills, agents, scripts). Run this first if other tools are failing: it distinguishes bad credentials from a missing role or a discovery problem.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const s = await cx.session();
      const [bu, skills, agents, scripts] = await Promise.all([
        cx.get('business-unit'),
        cx.get('skills', { top: 1 }),
        cx.get('agents', { top: 1 }),
        cx.get('scripts/search'),
      ]);
      const unit = bu.businessUnits?.[0] || {};
      return {
        ok: true, tenant: s.tenant, businessUnit: unit.businessUnitName, busNo: s.busNo,
        cluster: s.cluster, apiBase: s.apiBase, role: s.role,
        counts: {
          skills: Number(skills.totalRecords) || 0,
          agents: Number(agents.totalRecords) || 0,
          scripts: (scripts.scriptSearchDetails || []).filter((x) => x.status === 'CURR').length,
        },
      };
    },
  },
  {
    name: 'get_business_unit',
    description: 'Get the business unit configuration: name, default time zone, dialing capabilities (predictive allowed, call suppression, blending), port limits, and which product features are enabled.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const bu = await cx.get('business-unit');
      const u = bu.businessUnits?.[0] || {};
      return {
        businessUnitId: u.businessUnitId, name: u.businessUnitName, timeZone: u.defaultTimeZone,
        allowPredictiveDialing: u.allowPredictiveDialing, callSuppression: u.callSuppression,
        priorityBasedBlending: u.priorityBasedBlending, concurrentPortLimit: u.concurrentPortLimit,
        outboundPortLimit: u.outboundPortLimit,
        features: (u.features || []).filter((f) => f.isEnabled).map((f) => f.productDescription),
      };
    },
  },

  // ----- skills (the queue/dialer workhorse) -----
  {
    name: 'list_skills',
    description: 'List ACD skills (name, id, media type, inbound/outbound, campaign, running state). In CXone a skill is the routing/dialing unit: the closest thing to a queue AND a dialing campaign in other platforms. isRunning only appears for outbound skills that are actively dialing.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Substring of the skill name' },
        media_type: { type: 'string', enum: ['phone', 'chat', 'email', 'voicemail', 'sms', 'digital', 'workitem'], description: 'Filter by media type' },
        outbound_only: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const r = await cx.listAll('skills', 'skills', {}, { max: 1000 });
      let skills = r.entities;
      if (a.search) skills = skills.filter((s) => s.skillName?.toLowerCase().includes(a.search.toLowerCase()));
      if (a.media_type) skills = skills.filter((s) => s.mediaTypeId === MEDIA[a.media_type]);
      if (a.outbound_only) skills = skills.filter((s) => s.isOutbound);
      return {
        total: skills.length,
        skills: skills.map((s) => ({
          skillId: s.skillId, name: s.skillName, mediaType: s.mediaTypeName,
          isOutbound: s.isOutbound || undefined, outboundStrategy: s.outboundStrategy || undefined,
          isRunning: s.isRunning || undefined, campaign: s.campaignName, isActive: s.isActive,
        })),
      };
    },
  },
  {
    name: 'get_skill',
    description: 'Get a skill\'s full configuration by name or id. For outbound skills, also fetches the dialer parameter blocks (retry settings, schedule, CPA, general settings) when the tenant exposes them.',
    inputSchema: {
      type: 'object',
      properties: { skill: { type: 'string', description: 'Skill name or id' } },
      required: ['skill'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const { skillId } = await resolveSkill(cx, a.skill);
      const full = await cx.get(`skills/${skillId}`);
      const skill = full.skills?.[0] || full;
      let parameters;
      if (skill.isOutbound) {
        try { parameters = await cx.get(`skills/${skillId}/parameters`); } catch { /* not all outbound types expose it */ }
      }
      return { skill, parameters };
    },
  },
  {
    name: 'create_skill',
    description: 'Create an ACD skill. media_type: phone (default), chat, email, voicemail, sms, digital, workitem. For OUTBOUND phone skills set outbound: true (strategy defaults to Personal Connection, the CXone dialer) - the skill is created NOT RUNNING and no tool here can start it; a human presses go in the CXone UI. Every skill must belong to a campaign (a reporting rollup): pass one by name or id, or the business unit\'s default campaign is used. Inbound skills get sensible service-level defaults (80% in 30s).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '1-30 chars' },
        media_type: { type: 'string', enum: ['phone', 'chat', 'email', 'voicemail', 'sms', 'digital', 'workitem'] },
        outbound: { type: 'boolean', description: 'Outbound dialing skill (phone only)' },
        caller_id_override: { type: 'string', description: 'Outbound caller id (ANI) override' },
        campaign: { type: 'string', description: 'Campaign (reporting group) name or id (defaults to the BU default campaign)' },
        script: { type: 'string', description: 'Default script name or id for the skill (outbound)' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const body = { skillName: a.name, mediaTypeId: MEDIA[a.media_type || 'phone'] };
      if (a.outbound) {
        body.isOutbound = true;
        body.outboundStrategy = 'Personal Connection';
      } else {
        // Inbound skills require service-level fields the docs call optional.
        body.serviceLevelThreshold = 30;
        body.serviceLevelGoal = 80;
        body.enableShortAbandon = false;
        body.shortAbandonThreshold = 15;
      }
      if (a.caller_id_override) body.callerIdOverride = a.caller_id_override;
      // campaignId is required in practice (every skill reports somewhere).
      const camps = await cx.listAll('campaigns', 'campaigns', {}, { max: 500 });
      if (a.campaign) {
        const m = camps.entities.find((c) => String(c.campaignId) === String(a.campaign) || c.campaignName?.toLowerCase() === a.campaign.toLowerCase());
        if (!m) throw new CxoneError(`No campaign found matching "${a.campaign}"`, 404);
        body.campaignId = Number(m.campaignId);
      } else {
        const def = camps.entities.find((c) => /^default campaign/i.test(c.campaignName || '')) || camps.entities.find((c) => c.isActive);
        if (!def) throw new CxoneError('No campaign exists to attach the skill to - create_campaign first.', 400);
        body.campaignId = Number(def.campaignId);
      }
      if (a.script) body.scriptId = (await resolveScript(cx, a.script)).masterID;
      const res = await cx.post('skills', { skills: [body] });
      const result = batchResult(res, 'skillsResults', 'skill');
      return {
        created: true, skillId: result.skillId ?? result.id, name: a.name,
        isOutbound: Boolean(a.outbound),
        note: a.outbound ? 'Outbound skill created NOT RUNNING by design. No tool here starts a skill - a human presses go in CXone (ACD > Contact Settings > Skills).' : undefined,
      };
    },
  },
  {
    name: 'configure_outbound_skill',
    description: 'Configure an outbound skill\'s dialer behavior: retry settings (max attempts per record, minimum minutes between retries) and/or the weekly dialing schedule. SCHEDULE CONSTRAINT (CXone API, not this server): the schedule endpoint only accepts a schedule where ALL SEVEN days are active with real windows - a "weekdays only" schedule must be finished in the CXone UI, and this tool says so instead of failing cryptically. This tunes HOW the skill dials once a human starts it; nothing here starts dialing.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Outbound skill name or id' },
        max_attempts: { type: 'number', description: 'Max dial attempts per record (1-300)' },
        minimum_retry_minutes: { type: 'number', description: 'Minimum minutes between attempts on a record' },
        schedule: {
          type: 'array',
          description: 'Weekly dialing windows covering ALL 7 days, e.g. [{"days":["monday","tuesday","wednesday","thursday","friday"],"start":"09:00","end":"19:00"},{"days":["saturday","sunday"],"start":"10:00","end":"16:00"}]. The CXone API requires every day to have a window; for days that should not dial, leave schedule unset and use the CXone UI.',
          items: {
            type: 'object',
            properties: {
              days: { type: 'array', items: { type: 'string', enum: DAYS_LOWER } },
              start: { type: 'string', description: '24h HH:MM' },
              end: { type: 'string', description: '24h HH:MM' },
            },
            required: ['days', 'start', 'end'],
            additionalProperties: false,
          },
        },
      },
      required: ['skill'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const { skillId, skillName } = await resolveSkill(cx, a.skill);
      const out = { skill: skillName || skillId };
      if (a.max_attempts || a.minimum_retry_minutes) {
        const retrySettings = {};
        if (a.max_attempts) retrySettings.maximumAttempts = a.max_attempts;
        if (a.minimum_retry_minutes) retrySettings.minimumRetryMinutes = a.minimum_retry_minutes;
        await cx.put(`skills/${skillId}/parameters/retry-settings`, { retrySettings });
        out.retrySettings = retrySettings;
      }
      if (a.schedule?.length) {
        for (const w of a.schedule) {
          if (!HHMM(w.start) || !HHMM(w.end)) throw new CxoneError('schedule start/end must be 24h HH:MM', 400);
          if (w.start === w.end) throw new CxoneError(`schedule window ${w.start}-${w.end} is zero-length - the CXone API rejects it`, 400);
        }
        const covered = DAYS_LOWER.filter((d) => a.schedule.some((w) => w.days.includes(d)));
        if (covered.length < 7) {
          const missing = DAYS_LOWER.filter((d) => !covered.includes(d));
          throw new CxoneError(
            `The CXone schedule API only accepts a schedule where all 7 days have an active window (verified: any inactive day is rejected as InvalidParameter, however encoded). ` +
            `Missing: ${missing.join(', ')}. Either give every day a window, or skip schedule here and set the partial week in CXone (ACD > Contact Settings > Skills > Schedule).`, 400);
        }
        const scheduleSettings = { isScheduled: true };
        for (const day of DAYS_LOWER) {
          const w = a.schedule.find((x) => x.days.includes(day));
          scheduleSettings[`${day}IsActive`] = true;
          scheduleSettings[`${day}StartTime`] = w.start;
          scheduleSettings[`${day}EndTime`] = w.end;
        }
        await cx.put(`skills/${skillId}/parameters/schedule-settings`, { scheduleSettings });
        out.scheduleSettings = scheduleSettings;
      }
      if (!out.retrySettings && !out.scheduleSettings) throw new CxoneError('Nothing to configure - pass max_attempts, minimum_retry_minutes, and/or schedule.', 400);
      out.note = 'Dialer behavior configured. The skill still only dials once a human starts it.';
      return out;
    },
  },
  {
    name: 'assign_skill_agents',
    description: 'Assign one or more agents to a skill (with optional proficiency 1-20, lower is better; default 10). Additive only - it does not remove assignments. Agents are matched by email, full name, or agentId.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name or id' },
        agents: { type: 'array', items: { type: 'string' }, description: 'Agent emails, names, or ids' },
        proficiency: { type: 'number', description: '1-20 (default 10)' },
      },
      required: ['skill', 'agents'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const { skillId, skillName } = await resolveSkill(cx, a.skill);
      const resolved = [];
      for (const ref of a.agents) resolved.push(await resolveAgent(cx, ref));
      await cx.post(`skills/${skillId}/agents`,
        resolved.map((ag) => ({ agentId: ag.agentId, proficiency: a.proficiency ?? 10, isActive: true })));
      return { assigned: resolved.length, skill: skillName || skillId, agents: resolved.map((ag) => ag.emailAddress || ag.agentId) };
    },
  },
  {
    name: 'assign_agent_skills',
    description: 'Assign multiple skills to ONE agent (the inverse of assign_skill_agents - use whichever direction reads naturally). Additive only.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent email, name, or id' },
        skills: { type: 'array', items: { type: 'string' }, description: 'Skill names or ids' },
        proficiency: { type: 'number', description: '1-20 (default 10)' },
      },
      required: ['agent', 'skills'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const agent = await resolveAgent(cx, a.agent);
      const skills = [];
      for (const s of a.skills) skills.push(await resolveSkill(cx, s));
      await cx.post(`agents/${agent.agentId}/skills`, {
        skills: skills.map((s) => ({ skillId: String(s.skillId), proficiency: a.proficiency ?? 10, isActive: true })),
      });
      return { assigned: skills.length, agent: agent.emailAddress || agent.agentId, skills: skills.map((s) => s.skillName || s.skillId) };
    },
  },

  // ----- campaigns (reporting rollups - NOT dialing) -----
  {
    name: 'list_campaigns',
    description: 'List campaigns. NOTE: in CXone a campaign is a REPORTING rollup of skills, not a dialing campaign - outbound dialing lives on skills. When a user says "campaign" meaning "thing that dials", they want an outbound skill.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const r = await cx.listAll('campaigns', 'campaigns', {}, { max: 500 });
      return { total: r.total, campaigns: r.entities.map((c) => ({ campaignId: Number(c.campaignId), name: c.campaignName, isActive: c.isActive, description: c.description || undefined })) };
    },
  },
  {
    name: 'create_campaign',
    description: 'Create a campaign (a reporting rollup), optionally assigning existing skills to it by name or id. Skills report under exactly one campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '1-80 chars' },
        description: { type: 'string' },
        skills: { type: 'array', items: { type: 'string' }, description: 'Skills to assign (names or ids)' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      // The flat create body lives on v33.0 (older versions want a different
      // wrapper and 500 on this shape).
      const res = await cx.post('campaigns', { name: a.name, isActive: true, ...(a.description ? { description: a.description } : {}) }, { version: 'v33.0' });
      const campaignId = res.id ?? res.campaignId;
      let assigned = [];
      if (a.skills?.length) {
        const ids = [];
        for (const s of a.skills) ids.push((await resolveSkill(cx, s)).skillId);
        await cx.post(`campaigns/${campaignId}/skills`, { skills: ids.map((skillId) => ({ skillId })) });
        assigned = ids;
      }
      return { created: true, campaignId, name: a.name, skillsAssigned: assigned.length };
    },
  },

  // ----- agents & teams -----
  {
    name: 'list_agents',
    description: 'List active agents (name, email, team, username). Optional search matches name or email. NOTE: creating agents (employees) is not possible through the ACD API on User Hub tenants - user management owns that surface; this server manages EXISTING agents (skills, teams).',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string' } },
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const r = await cx.listAll('agents', 'agents', { isActive: true }, { max: 2000 });
      let agents = r.entities;
      if (a.search) {
        const q = a.search.toLowerCase();
        agents = agents.filter((x) => `${x.firstName} ${x.lastName} ${x.emailAddress || ''} ${x.userName || ''}`.toLowerCase().includes(q));
      }
      return {
        total: agents.length,
        agents: agents.map((x) => ({ agentId: x.agentId, name: `${x.firstName} ${x.lastName}`, email: x.emailAddress, team: x.teamName, userName: x.userName })),
      };
    },
  },
  {
    name: 'get_agent',
    description: 'Get an agent\'s profile and skill assignments by email, name, or id.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'Email, name, or agentId' } },
      required: ['agent'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const { agentId } = await resolveAgent(cx, a.agent);
      const [profile, skills] = await Promise.all([
        cx.get(`agents/${agentId}`),
        cx.get(`agents/${agentId}/skills`).catch(() => ({})),
      ]);
      const p = profile.agents?.[0] || profile;
      return {
        agentId, name: `${p.firstName} ${p.lastName}`, email: p.emailAddress, userName: p.userName,
        team: p.teamName, isActive: p.isActive,
        skills: (skills.skillAssignments || skills.agentSkillAssignments || []).map((s) => ({ skill: s.skillName, proficiency: s.proficiency })),
      };
    },
  },
  {
    name: 'list_teams',
    description: 'List teams (name, id, active state, agent count when available).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const r = await cx.listAll('teams', 'teams', {}, { max: 500 });
      return { total: r.total, teams: r.entities.map((t) => ({ teamId: t.teamId, name: t.teamName, isActive: t.isActive, agentCount: t.agentCount })) };
    },
  },
  {
    name: 'create_team',
    description: 'Create a team, optionally moving existing agents onto it (agents belong to exactly one team, so this MOVES them - confirm with the user when the agents are not brand new).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        agents: { type: 'array', items: { type: 'string' }, description: 'Agent emails, names, or ids to move onto the team' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const res = await cx.post('teams', { teams: [{ teamName: a.name, isActive: true }] });
      const created = batchResult(res, 'teamsResults', 'team');
      const teamId = created.teamId ?? res.teams?.[0]?.teamId;
      let moved = 0;
      if (a.agents?.length && teamId) {
        const ids = [];
        for (const ref of a.agents) ids.push((await resolveAgent(cx, ref)).agentId);
        await cx.post(`teams/${teamId}/agents`, { agentIds: ids });
        moved = ids.length;
      }
      return { created: true, teamId, name: a.name, agentsMoved: moved };
    },
  },

  // ----- dispositions -----
  {
    name: 'list_dispositions',
    description: 'List dispositions (the wrap-up outcomes agents pick), with their ids, classifications, and preview flags.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const r = await cx.listAll('dispositions', 'dispositions', {}, { max: 500 });
      return {
        total: r.total,
        dispositions: r.entities.map((d) => ({ dispositionId: d.dispositionId, name: d.dispositionName, classification: d.classificationName, isPreview: d.isPreviewDisposition, isActive: d.isActive })),
      };
    },
  },
  {
    name: 'create_dispositions',
    description: 'Create one or more dispositions. is_preview marks a disposition selectable from the Personal Connection preview card. KNOWN LIMIT: attaching dispositions to a skill has no working write API on current clusters (verified against every API version) - the admin wires them to skills in the CXone UI, and this tool says so in its result.',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Disposition names (1-50 chars each)' },
        is_preview: { type: 'boolean', description: 'Default false' },
      },
      required: ['names'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      if (!a.names.length) throw new CxoneError('names must be non-empty', 400);
      await cx.post('dispositions', { dispositions: a.names.map((n) => ({ dispositionName: n, isPreviewDisposition: Boolean(a.is_preview) })) });
      return {
        created: a.names.length, names: a.names,
        note: 'Dispositions created. Attach them to skills in CXone (ACD > Contact Settings > Skills > the skill > Dispositions) - the assignment API is not exposed on current clusters.',
      };
    },
  },

  // ----- hours of operation -----
  {
    name: 'list_hours_of_operation',
    description: 'List hours-of-operation profiles (weekly open/close times, holidays). Scripts branch on these profiles to route after-hours calls differently.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const r = await cx.get('hours-of-operation', { isDeleted: false });
      const rows = r.resultSet?.hoursOfOperation || r.hoursOfOperation || [];
      return {
        total: rows.length,
        profiles: rows.map((h) => ({
          profileId: h.hoursOfOperationProfileId, name: h.profileName,
          days: (h.days || []).filter((d) => !d.isClosedAllDay).map((d) => `${d.day} ${d.openTime}-${d.closeTime}`),
          holidays: (h.holidays || []).map((x) => x.holidayName),
        })),
      };
    },
  },
  {
    name: 'create_hours_of_operation',
    description: 'Create an hours-of-operation profile from weekly windows, e.g. [{"days":["Monday","Tuesday","Wednesday","Thursday","Friday"],"open":"09:00","close":"19:00"}]. Days not listed are closed all day. A profile with NO windows is 24/7. Optionally attach skills at creation.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '1-30 chars' },
        windows: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              days: { type: 'array', items: { type: 'string', enum: DAY_NAMES } },
              open: { type: 'string', description: '24h HH:MM' },
              close: { type: 'string', description: '24h HH:MM' },
            },
            required: ['days', 'open', 'close'],
            additionalProperties: false,
          },
        },
        skills: { type: 'array', items: { type: 'string' }, description: 'Skills (names or ids) to attach' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const body = { profileName: a.name };
      if (a.windows?.length) {
        for (const w of a.windows) {
          if (!HHMM(w.open) || !HHMM(w.close)) throw new CxoneError('windows open/close must be 24h HH:MM', 400);
        }
        body.days = DAY_NAMES.map((day) => {
          const w = a.windows.find((x) => x.days.includes(day));
          return w
            ? { day, openTime: `${w.open}:00`, closeTime: `${w.close}:00`, isClosedAllDay: false, hasAdditionalHours: false }
            : { day, isClosedAllDay: true, hasAdditionalHours: false };
        });
      }
      if (a.skills?.length) {
        body.skills = [];
        for (const s of a.skills) body.skills.push({ skillId: (await resolveSkill(cx, s)).skillId });
      }
      const res = await cx.post('hours-of-operation', body);
      return { created: true, profileId: res.hoursOfOperationProfileId ?? res.profileId, name: a.name, is247: !a.windows?.length };
    },
  },

  // ----- points of contact (DNIS → script) -----
  {
    name: 'list_points_of_contact',
    description: 'List points of contact: the DNIS/entry points of the tenant and which script and default skill each one runs. This is the map of "what happens when each number is called."',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const r = await cx.get('points-of-contact');
      const rows = r.resultSet?.pointsOfContact || r.pointsOfContact || [];
      return {
        total: rows.length,
        pointsOfContact: rows.map((p) => ({
          pointOfContactId: p.pointOfContactId ?? p.pointOfContactUuid, contactAddress: p.pointOfContact,
          name: p.pointOfContactName, mediaType: p.mediaTypeName, script: p.scriptName, skill: p.skillName, isActive: p.isActive,
        })),
      };
    },
  },
  {
    name: 'create_point_of_contact',
    description: 'Create a point of contact wiring a contact address (a DNIS/phone number, or an address for other media) to a script and default skill. This is how a deployed script goes live on a number - treat it as a go-live action and confirm with the user.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_address: { type: 'string', description: 'The DNIS/number or address' },
        name: { type: 'string', description: 'Display name' },
        script: { type: 'string', description: 'Script name or id to run' },
        skill: { type: 'string', description: 'Default skill name or id' },
        media_type: { type: 'string', enum: ['phone', 'chat', 'email', 'sms'], description: 'Default phone' },
      },
      required: ['contact_address', 'name', 'script', 'skill'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const [script, skill] = await Promise.all([resolveScript(cx, a.script), resolveSkill(cx, a.skill)]);
      const res = await cx.post('points-of-contact', {
        pointOfContact: a.contact_address, pointOfContactName: a.name,
        skillId: skill.skillId, scriptName: script.scriptName, mediaTypeId: MEDIA[a.media_type || 'phone'], isActive: true,
      });
      return { created: true, pointOfContactId: res.pointOfContactId, contactAddress: a.contact_address, script: script.scriptName, skill: skill.skillName || skill.skillId };
    },
  },
  {
    name: 'repoint_point_of_contact',
    description: 'REPOINT an existing point of contact (DNIS) to a different script - the fast cutover for what a phone number runs. Confirm with the user first: calls to that number follow the new script immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        point_of_contact: { type: 'string', description: 'Contact address, display name, or id' },
        script: { type: 'string', description: 'The script name or id to point it at' },
      },
      required: ['point_of_contact', 'script'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const r = await cx.get('points-of-contact');
      const rows = r.resultSet?.pointsOfContact || r.pointsOfContact || [];
      const q = String(a.point_of_contact).toLowerCase();
      const matches = rows.filter((p) => String(p.pointOfContactId) === q || p.pointOfContact?.toLowerCase() === q || p.pointOfContactName?.toLowerCase() === q);
      if (!matches.length) throw new CxoneError(`No point of contact found matching "${a.point_of_contact}"`, 404);
      if (matches.length > 1) throw new CxoneError(`Ambiguous point of contact - matches: ${matches.map((p) => p.pointOfContactName).join(', ')}`, 409);
      const poc = matches[0];
      const script = await resolveScript(cx, a.script);
      await cx.put(`points-of-contact/${poc.pointOfContactId}`, { scriptName: script.scriptName });
      return { repointed: true, pointOfContact: poc.pointOfContactName, contactAddress: poc.pointOfContact, from: poc.scriptName, to: script.scriptName };
    },
  },
  {
    name: 'list_dnis',
    description: 'List the DNIS inventory (phone numbers provisioned on the tenant).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const r = await cx.get('dnis');
      const rows = r.resultSet?.dnis || r.dnis || r.dnisRecords || [];
      return { total: rows.length, dnis: rows };
    },
  },

  // ----- unavailable codes & address books -----
  {
    name: 'list_unavailable_codes',
    description: 'List unavailable (not-ready reason) codes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const r = await cx.get('unavailable-codes');
      const rows = r.resultSet?.unavailableCodes || r.unavailableCodes || [];
      return { total: rows.length, unavailableCodes: rows.map((u) => ({ unavailableCodeId: u.unavailableCodeId, name: u.unavailableCode ?? u.name, isActive: u.isActive, isACW: u.isAcw ?? u.isACW })) };
    },
  },
  {
    name: 'create_unavailable_code',
    description: 'Create an unavailable (not-ready reason) code, e.g. "Team Huddle" or "Coaching". is_acw marks it as after-contact work.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '1-25 chars' },
        is_acw: { type: 'boolean', description: 'Counts as after-contact work' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const res = await cx.post('unavailable-codes', { name: a.name, ...(a.is_acw !== undefined ? { isACW: a.is_acw } : {}) });
      return { created: true, unavailableCodeId: res.unavailableCodeId, name: a.name };
    },
  },
  {
    name: 'list_address_books',
    description: 'List address books (shared directories agents can dial/transfer from).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const r = await cx.get('address-books');
      const rows = r.resultSet?.addressBooks || r.addressBooks || [];
      return { total: rows.length, addressBooks: rows.map((b) => ({ addressBookId: b.addressBookId, name: b.addressBookName, type: b.addressBookType })) };
    },
  },
  {
    name: 'create_address_book',
    description: 'Create a Standard address book, optionally seeding entries (first and last name required per entry; phone/mobile/email/company optional). Assign it to skills, teams, agents, or everyone with assign_address_book.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              first_name: { type: 'string' }, last_name: { type: 'string' },
              phone: { type: 'string' }, mobile: { type: 'string' }, email: { type: 'string' }, company: { type: 'string' },
            },
            required: ['first_name', 'last_name'],
            additionalProperties: false,
          },
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const res = await cx.api('POST', 'address-books', { query: { addressBookName: a.name, addressBookType: 'Standard' } });
      const addressBookId = res.addressBookId ?? res.resultSet?.addressBookId ?? res.addressBooks?.[0]?.addressBookId;
      let added = 0;
      if (a.entries?.length && addressBookId) {
        await cx.post(`address-books/${addressBookId}/entries`, {
          addressBookEntries: a.entries.map((e) => ({
            firstName: e.first_name, lastName: e.last_name, phone: e.phone, mobile: e.mobile, email: e.email, company: e.company,
          })),
        });
        added = a.entries.length;
      }
      return { created: true, addressBookId, name: a.name, entriesAdded: added };
    },
  },
  {
    name: 'assign_address_book',
    description: 'Assign an address book to skills, teams, agents, or everyone, so the right people see the directory.',
    inputSchema: {
      type: 'object',
      properties: {
        address_book: { type: 'string', description: 'Address book name or id' },
        entity_type: { type: 'string', enum: ['Skill', 'Team', 'Agent', 'Everyone'] },
        entities: { type: 'array', items: { type: 'string' }, description: 'Skill/team/agent names or ids (omit for Everyone)' },
      },
      required: ['address_book', 'entity_type'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const r = await cx.get('address-books');
      const rows = r.resultSet?.addressBooks || r.addressBooks || [];
      const book = rows.find((b) => String(b.addressBookId) === String(a.address_book) || b.addressBookName?.toLowerCase() === String(a.address_book).toLowerCase());
      if (!book) throw new CxoneError(`No address book found matching "${a.address_book}"`, 404);
      let ids;
      if (a.entity_type === 'Everyone') {
        ids = ['All'];
      } else {
        if (!a.entities?.length) throw new CxoneError(`entity_type ${a.entity_type} needs entities`, 400);
        ids = [];
        for (const e of a.entities) {
          if (a.entity_type === 'Skill') ids.push(String((await resolveSkill(cx, e)).skillId));
          else if (a.entity_type === 'Team') ids.push(String((await resolveTeam(cx, e)).teamId));
          else ids.push(String((await resolveAgent(cx, e)).agentId));
        }
      }
      await cx.api('POST', `address-books/${book.addressBookId}/assignment`, {
        query: { entityType: a.entity_type },
        body: { addressBookAssignments: ids.map((entityId) => ({ entityId })) },
      });
      return { assigned: true, addressBook: book.addressBookName, entityType: a.entity_type, entities: ids };
    },
  },

  // ----- DNC & call lists (outbound compliance + records) -----
  {
    name: 'list_dnc_groups',
    description: 'List Do-Not-Call groups (name, id, description). Use get_dnc_group for one group\'s records and skill wiring.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const r = await cx.get('dnc-groups');
      const rows = r.resultSet?.dncGroups || r.dncGroups || [];
      return { total: rows.length, dncGroups: rows.map((g) => ({ dncGroupId: Number(g.dncGroupId), name: g.dncGroupName, description: g.dncGroupDescription, validRecords: Number(g.validRecords) || 0 })) };
    },
  },
  {
    name: 'get_dnc_group',
    description: 'Get one DNC group: a sample of its records (capped at 100), the skills contributing numbers into it, and the skills scrubbed against it.',
    inputSchema: {
      type: 'object',
      properties: { dnc_group: { type: 'string', description: 'DNC group name or id' } },
      required: ['dnc_group'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const r = await cx.get('dnc-groups');
      const rows = r.resultSet?.dncGroups || r.dncGroups || [];
      const g = rows.find((x) => String(x.dncGroupId) === String(a.dnc_group) || x.dncGroupName?.toLowerCase() === String(a.dnc_group).toLowerCase());
      if (!g) throw new CxoneError(`No DNC group found matching "${a.dnc_group}"`, 404);
      const [records, contributing, scrubbed] = await Promise.all([
        cx.get(`dnc-groups/${g.dncGroupId}/records`, { top: 100 }).catch(() => ({})),
        cx.get(`dnc-groups/${g.dncGroupId}/contributing-skills`).catch(() => ({})),
        cx.get(`dnc-groups/${g.dncGroupId}/scrubbed-skills`).catch(() => ({})),
      ]);
      const pick = (o, k) => o.resultSet?.[k] || o[k] || [];
      return {
        dncGroupId: Number(g.dncGroupId), name: g.dncGroupName,
        records: pick(records, 'dncGroupRecords').slice(0, 100),
        contributingSkills: pick(contributing, 'contributingSkills'),
        scrubbedSkills: pick(scrubbed, 'scrubbedSkills'),
      };
    },
  },
  {
    name: 'create_dnc_group',
    description: 'Create an internal Do-Not-Call group, optionally seeding phone numbers (max 100 here; add more in later calls) and scrubbing outbound skills against it so those skills never dial the listed numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        numbers: { type: 'array', items: { type: 'string' }, description: 'Initial DNC phone numbers' },
        scrub_skills: { type: 'array', items: { type: 'string' }, description: 'Outbound skills (names or ids) to scrub against this group' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const res = await cx.post('dnc-groups', { dncGroupName: a.name, ...(a.description ? { dncGroupDescription: a.description } : {}) });
      const dncGroupId = res.dncGroups?.[0]?.dncGroupId ?? res.dncGroupId;
      let numbersAdded = 0;
      const scrubbed = [];
      if (a.numbers?.length) {
        if (a.numbers.length > 100) throw new CxoneError('Max 100 numbers per call - send the rest in another call', 400);
        await cx.post(`dnc-groups/${dncGroupId}/records`, { dncGroupRecords: a.numbers.map((n) => ({ phoneNumber: Number(String(n).replace(/\D/g, '')) })) });
        numbersAdded = a.numbers.length;
      }
      for (const s of a.scrub_skills || []) {
        const { skillId, skillName } = await resolveSkill(cx, s);
        await cx.post(`dnc-groups/${dncGroupId}/scrubbed-skills/${skillId}`);
        scrubbed.push(skillName || skillId);
      }
      return { created: true, dncGroupId: Number(dncGroupId), name: a.name, numbersAdded, scrubbedSkills: scrubbed };
    },
  },
  {
    name: 'list_call_lists',
    description: 'List calling lists (the record sets outbound skills dial from) and their status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const r = await cx.get('lists/call-lists');
      const rows = r.resultSet?.callingLists || r.callingLists || r.lists || [];
      return { total: rows.length, callLists: rows };
    },
  },
  {
    name: 'get_call_list',
    description: 'Get one calling list\'s detail and its per-record dial attempts (capped).',
    inputSchema: {
      type: 'object',
      properties: { list_id: { type: 'string', description: 'The listId' } },
      required: ['list_id'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const [detail, attempts] = await Promise.all([
        cx.get(`lists/call-lists/${a.list_id}`),
        cx.get(`lists/call-lists/${a.list_id}/attempts`, { top: 100 }).catch(() => ({})),
      ]);
      return { list: detail.resultSet ?? detail, attempts: attempts.resultSet ?? attempts };
    },
  },
  {
    name: 'upload_call_list',
    description: 'Create a calling list and upload records to it for an outbound skill (max 200 records per call; phone as E.164 or 10-digit; every record gets an external_id, auto-derived when missing; optional first_name/last_name/time_zone/zip columns map automatically). The upload ALWAYS lands with startSkill false (hard-coded) - records sit staged and a human starts the skill. CAUTION: records uploaded to a skill that is ALREADY RUNNING will be dialed - check list_skills isRunning and confirm the target skill with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'List/file name' },
        skill: { type: 'string', description: 'Outbound skill (name or id) the records dial on' },
        records: {
          type: 'array',
          description: 'Rows: { phone, first_name?, last_name?, external_id?, time_zone?, zip?, ...custom }',
          items: { type: 'object', additionalProperties: true },
        },
        expiration_days: { type: 'number', description: 'Days until records expire (default 30)' },
      },
      required: ['name', 'skill', 'records'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      if (!Array.isArray(a.records) || !a.records.length) throw new CxoneError('records must be a non-empty array', 400);
      if (a.records.length > 200) throw new CxoneError('Max 200 records per call - send the rest in another call', 400);
      const { skillId, skillName } = await resolveSkill(cx, a.skill);
      // Every record needs an external id; derive one when missing.
      const records = a.records.map((r, i) => ({ external_id: r.external_id ?? `rec${i + 1}`, ...r }));
      const cols = [...new Set(records.flatMap((r) => Object.keys(r)))];
      if (!cols.includes('phone')) throw new CxoneError('records need a "phone" column', 400);
      const csvEsc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const csv = [cols.join(','), ...records.map((r) => cols.map((c) => csvEsc(r[c])).join(','))].join('\r\n');
      // listName and the column mappings ride as QUERY params; the phone
      // column maps through destinationMappings fieldName "PhoneNumber".
      const query = { listName: a.name, externalIdColumn: 'external_id' };
      if (cols.includes('first_name')) query.firstNameColumn = 'first_name';
      if (cols.includes('last_name')) query.lastNameColumn = 'last_name';
      if (cols.includes('time_zone')) query.timeZoneColumn = 'time_zone';
      if (cols.includes('zip')) query.zipColumn = 'zip';
      const listRes = await cx.api('POST', 'lists/call-lists', {
        query,
        body: { destinationMappings: [{ fieldName: 'PhoneNumber', fieldValue: 'phone' }] },
      });
      const listId = listRes.listId ?? listRes.resultSet?.listId ?? listRes.callingLists?.[0]?.listId;
      const exp = new Date(Date.now() + (a.expiration_days ?? 30) * 86400000).toISOString().slice(0, 10);
      await cx.post(`lists/call-lists/${listId}/upload`, {
        listFile: btoa(unescape(encodeURIComponent(csv))),
        fileName: `${a.name.replace(/[^\w.-]+/g, '_')}.csv`,
        skillId,
        forceOverwrite: true,
        expirationDate: exp,
        startSkill: false, // hard-coded by design: a human presses go
        sendEmail: false,
      });
      return {
        created: true, listId, records: records.length, skill: skillName || skillId, expires: exp,
        note: 'Uploaded with startSkill FALSE by design - the records are staged and a human starts the skill in CXone.',
      };
    },
  },
  {
    name: 'outbound_overview',
    description: 'One-call inventory of the outbound stack: every outbound skill with its running state, retry settings, dialing schedule, DNC groups, and calling lists. Run this before building or changing anything outbound, and reuse what already exists.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const [skills, dnc, lists] = await Promise.all([
        cx.listAll('skills', 'skills', {}, { max: 1000 }),
        cx.get('dnc-groups').catch(() => ({})),
        cx.get('lists/call-lists').catch(() => ({})),
      ]);
      const outbound = skills.entities.filter((s) => s.isOutbound);
      const detail = await Promise.all(outbound.slice(0, 20).map(async (s) => {
        const [retry, schedule] = await Promise.all([
          cx.get(`skills/${s.skillId}/parameters/retry-settings`).catch(() => null),
          cx.get(`skills/${s.skillId}/parameters/schedule-settings`).catch(() => null),
        ]);
        return {
          skillId: s.skillId, name: s.skillName, strategy: s.outboundStrategy,
          isRunning: Boolean(s.isRunning),
          retry: retry ? { maximumAttempts: retry.maximumAttempts, minimumRetryMinutes: retry.minimumRetryMinutes } : undefined,
          schedule: schedule?.isScheduled
            ? DAYS_LOWER.filter((d) => schedule[`${d}IsActive`]).map((d) => `${d} ${schedule[`${d}StartTime`]}-${schedule[`${d}EndTime`]}`)
            : 'always (no schedule)',
        };
      }));
      return {
        outboundSkills: detail,
        dncGroups: (dnc.resultSet?.dncGroups || dnc.dncGroups || []).map((g) => ({ dncGroupId: Number(g.dncGroupId), name: g.dncGroupName })),
        callLists: (lists.resultSet?.callingLists || lists.callingLists || []).slice(0, 25),
      };
    },
  },

  // ----- scripts (Studio) -----
  {
    name: 'list_scripts',
    description: 'List Studio scripts (name, id, media type, last modified, the action types inside). CXone mints a new masterID on every save; this lists the CURRENT version of each script. include_inactive adds historical versions.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Substring of the script name' },
        include_inactive: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const res = await cx.get('scripts/search', a.include_inactive ? { includeInactive: true } : {});
      let rows = res.scriptSearchDetails || [];
      if (!a.include_inactive) rows = rows.filter((s) => s.status === 'CURR');
      if (a.search) rows = rows.filter((s) => s.scriptName?.toLowerCase().includes(a.search.toLowerCase()));
      return {
        total: rows.length,
        scripts: rows.map((s) => ({
          scriptId: s.masterID, name: s.scriptName, status: s.status, mediaType: s.mediaType,
          modified: s.modifyDate, by: s.mUser, actions: (s.actions || []).map((x) => x.name),
        })),
      };
    },
  },
  {
    name: 'get_script',
    description: 'Get a script\'s full content by name or id. Web-Studio scripts return editable JSON (header, actions, properties, branches - the same shape deploy_script accepts as script_content, so read-modify-deploy works). Desktop-Studio-only scripts fall back to their XML export. Large output - use render_script when you just need the shape.',
    inputSchema: {
      type: 'object',
      properties: { script: { type: 'string', description: 'Script name or id' } },
      required: ['script'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const s = await resolveScript(cx, a.script);
      try {
        const json = await cx.get('scripts', { scriptPath: s.scriptName });
        if (json.header) return { format: 'json', script: json };
      } catch { /* Desktop-only scripts 500 on the JSON path */ }
      const raw = await cx.get(`scripts/${s.masterID}`);
      const xml = raw.body ? decodeURIComponent(escape(atob(raw.body))) : '';
      return { format: 'xml', name: raw.name, scriptId: raw.ScriptId, xml: xml.length > 40000 ? xml.slice(0, 40000) + '\n<!-- truncated -->' : xml };
    },
  },
  {
    name: 'render_script',
    description: 'Render an existing script as a Mermaid diagram - instant documentation of any IVR in the tenant. Web-Studio scripts render faithfully from JSON; Desktop-Studio-only scripts render best-effort from XML. Show the user the diagram.',
    inputSchema: {
      type: 'object',
      properties: { script: { type: 'string', description: 'Script name or id' } },
      required: ['script'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const s = await resolveScript(cx, a.script);
      try {
        const json = await cx.get('scripts', { scriptPath: s.scriptName });
        if (json.header) return { script: s.scriptName, source: 'web Studio JSON', mermaid: scriptJsonToMermaid(json), note: 'Render the mermaid diagram for the user.' };
      } catch { /* fall through */ }
      const raw = await cx.get(`scripts/${s.masterID}`);
      const xml = raw.body ? decodeURIComponent(escape(atob(raw.body))) : '';
      return { script: s.scriptName, source: 'Desktop Studio XML (best effort)', mermaid: scriptXmlToMermaid(xml), note: 'Render the mermaid diagram for the user.' };
    },
  },
  {
    name: 'build_ivr',
    description: 'Compose an inbound phone IVR from a spec WITHOUT deploying: validates it and returns a Mermaid diagram to show the user. Spec: { name, greeting? (TTS), menu: { prompt (TTS), timeout_seconds?, no_input? (repeat|hangup), choices: [{ digit: 0-9|*|#, action: transfer_to_skill|play_message|submenu|hangup|previous_menu, name?, skill? (name or id), pre_transfer_message? (TTS), hold_music_seconds?, message? (TTS), then? (return_to_menu|hangup), menu? (nested menu, same shape, max 3 levels) }] } }. transfer_to_skill queues on a skill (optional pre-transfer TTS, then hold music); submenu nests another menu; previous_menu (submenus only) returns to the parent. Referenced skills must exist (create_skill first). Show the diagram, get ONE approval, then call deploy_script with the same spec.',
    inputSchema: {
      type: 'object',
      properties: { spec: { type: 'object', description: 'The IVR spec (see tool description)', additionalProperties: true } },
      required: ['spec'],
      additionalProperties: false,
    },
    cxone: false,
    handler: (_cx, a) => {
      const v = validateIvrSpec(a.spec);
      if (!v.ok) return { valid: false, errors: v.errors };
      return { valid: true, mermaid: specToMermaid(a.spec), note: 'Render the mermaid for the user and confirm before deploy_script.' };
    },
  },
  {
    name: 'deploy_script',
    description: 'Compose AND save an IVR script to the tenant from a build_ivr spec (or raw scriptContent JSON from get_script, for read-modify-deploy edits). CXone runs its own server-side SYNTAX_CHECK before saving; the report comes back verbatim (saved clean, saved with warnings, or REJECTED with nothing saved). CAUTION: saving a name that matches an existing script OVERWRITES it (a new version is minted; history survives - see script_history), and anything already wired to that name (a point of contact, a skill) runs the new version on the next call. The script is saved, not wired to a number: use create_point_of_contact to put it on a DNIS.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: 'IVR spec (as for build_ivr)', additionalProperties: true },
        script_content: { type: 'object', description: 'Raw web-Studio JSON {header, actions, properties, branches} (alternative to spec)', additionalProperties: true },
      },
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      let content = a.script_content;
      if (!content) {
        if (!a.spec) throw new CxoneError('Provide spec or script_content', 400);
        const session = await cx.session();
        // Resolve skill refs (recursively - submenus too) so REQAGENT gets
        // the exact Studio skill name.
        const skillNames = {};
        const collect = async (menu) => {
          for (const c of menu?.choices || []) {
            if (c.action === 'transfer_to_skill' && c.skill && !(c.skill in skillNames)) {
              skillNames[c.skill] = (await resolveSkill(cx, c.skill)).skillName || c.skill;
            }
            if (c.action === 'submenu') await collect(c.menu);
          }
        };
        await collect(a.spec.menu);
        content = specToScript(a.spec, session.busNo, (s) => skillNames[s] || s);
      }
      const res = await cx.post('scripts', { scriptContent: content });
      const report = formatSaveReport(res);
      return { ...report, script: content.header?.scriptName };
    },
  },
  {
    name: 'script_history',
    description: 'Get a script\'s version history by name (who saved each version and when; every save mints a new masterID, and the name is the stable identity).',
    inputSchema: {
      type: 'object',
      properties: { script: { type: 'string', description: 'Script name' } },
      required: ['script'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const s = await resolveScript(cx, a.script);
      const res = await cx.get('scripts/historyByName', { scriptPath: s.scriptName });
      const rows = res.scriptHistory || res.resultSet?.scriptHistory || res;
      return { script: s.scriptName, history: rows };
    },
  },

  // ----- power tool -----
  {
    name: 'cxone_api_call',
    description: 'Call any CXone ACD Admin API endpoint directly (for endpoints without a typed tool). GET/POST/PUT/PATCH only - DELETE is refused by design, and so is anything that starts dialing or spawns calls (skills/{id}/start, scripts/start, startSkill:true anywhere) and live-contact control (contacts/*, interactions/*). Treat any non-GET call as a write: describe the method, path, and body and confirm with the user first. Prefer the typed tools when one exists - they encode the quirks (batch results, version pinning, query-vs-body params) this raw tool does not.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH'] },
        path: { type: 'string', description: 'Path relative to /inContactAPI/services/v30.0/, e.g. "skills" or "agents/123/skills"' },
        query: { type: 'object', description: 'Query string parameters', additionalProperties: true },
        body: { type: 'object', description: 'JSON body for POST/PUT/PATCH', additionalProperties: true },
        version: { type: 'string', description: 'API version override, e.g. v33.0 (campaign create needs it)' },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const p = String(a.path).replace(/^\/+/, '').toLowerCase();
      if (a.method !== 'GET') {
        if (/skills\/[^/]+\/start\b/.test(p) || /^scripts\/start\b/.test(p)) {
          throw new CxoneError('Refused: this server never starts outbound dialing or spawns script runs. A human presses go in CXone.', 403);
        }
        if (/^contacts\//.test(p) || /^interactions\//.test(p)) {
          throw new CxoneError('Refused: live-contact control (barge, end, record) is out of scope for this server by design.', 403);
        }
        if (JSON.stringify(a.body || {}).match(/"startSkill"\s*:\s*true/)) {
          throw new CxoneError('Refused: startSkill must stay false - a human starts skills in CXone.', 403);
        }
      }
      return cx.api(a.method, a.path, { body: a.body, query: a.query, version: a.version });
    },
  },
];

// ---------- registry plumbing ----------

export function toolDefs() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool(cfg, name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (tool.cxone === false) return tool.handler(null, args, cfg);
  if (!cfg.configured) {
    throw new CxoneError('This server is not connected to CXone yet - open /setup, or set the CXONE_ACCESS_KEY_ID / CXONE_ACCESS_KEY_SECRET secrets.', 503);
  }
  const cx = new CxoneClient(cfg);
  return tool.handler(cx, args, cfg);
}

// UI metadata - which tools are writes, and how they group on the landing page.
export const WRITE_TOOLS = new Set([
  'create_skill', 'configure_outbound_skill', 'assign_skill_agents', 'assign_agent_skills',
  'create_campaign', 'create_team', 'create_dispositions',
  'create_hours_of_operation', 'create_point_of_contact', 'repoint_point_of_contact',
  'create_unavailable_code', 'create_address_book', 'assign_address_book',
  'create_dnc_group', 'upload_call_list',
  'deploy_script', 'cxone_api_call',
]);

export const TOOL_GROUPS = [
  { name: 'Tenant & Connection', icon: '🔌', tools: ['about', 'check_connection', 'get_business_unit'] },
  { name: 'Skills (Routing & Dialer)', icon: '🎯', tools: ['list_skills', 'get_skill', 'create_skill', 'configure_outbound_skill', 'assign_skill_agents', 'assign_agent_skills'] },
  { name: 'Agents & Teams', icon: '👥', tools: ['list_agents', 'get_agent', 'list_teams', 'create_team'] },
  { name: 'Campaigns & Dispositions', icon: '🗂️', tools: ['list_campaigns', 'create_campaign', 'list_dispositions', 'create_dispositions'] },
  { name: 'Hours & Codes', icon: '🕐', tools: ['list_hours_of_operation', 'create_hours_of_operation', 'list_unavailable_codes', 'create_unavailable_code'] },
  { name: 'Numbers & Entry Points', icon: '📇', tools: ['list_points_of_contact', 'create_point_of_contact', 'repoint_point_of_contact', 'list_dnis', 'list_address_books', 'create_address_book', 'assign_address_book'] },
  { name: 'Outbound Compliance & Records', icon: '📤', tools: ['outbound_overview', 'list_dnc_groups', 'get_dnc_group', 'create_dnc_group', 'list_call_lists', 'get_call_list', 'upload_call_list'] },
  { name: 'Studio Scripts (IVR Builder)', icon: '🏗️', tools: ['list_scripts', 'get_script', 'render_script', 'build_ivr', 'deploy_script', 'script_history'] },
  { name: 'Power', icon: '⚡', tools: ['cxone_api_call'] },
];

export { ACTION_LIBRARY };
