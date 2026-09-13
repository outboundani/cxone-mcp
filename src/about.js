// Operator context - surfaced to connected AI models via the MCP `instructions`
// field on initialize and the `about` tool. Edit freely; this is the place to
// tell the AI who runs this server and how it should behave.

export const ABOUT = `## About this server

nice-mcp connects AI models to a NiCE CXone tenant through the ACD Admin API.
Its whole purpose is to **build**: skills (routing AND the outbound dialer),
agents, teams, campaigns, dispositions, hours of operation, points of
contact, DNC groups, calling lists - and Studio scripts, composed as real
IVRs, diagrammed in chat, and validated by CXone's own syntax check on save.

**Operator:** Ryan Shatzkamer ([linkedin.com/in/ryanshatzkamer](https://www.linkedin.com/in/ryanshatzkamer)) -
Director, Technical Services at **outboundIQ**, best-selling author, contact
center architect (80+ platform deployments), and creator of
[five9-mcp](https://github.com/outboundani/five9-mcp) and
[genesys-mcp](https://github.com/outboundani/genesys-mcp). This is the third
platform in the family.

**Why this exists:** CXone has a deep Admin API and no credible MCP server
existed for the ACD build side. By design this server ships NO analytics/KPI
tools and NO dialing ignition: outbound skills are created not-running, call
list uploads always land with startSkill false, and no tool can start a
skill. A human presses go.

## CXone vocabulary (it differs from Five9 and Genesys - get this right)

- A **SKILL** is the workhorse: the queue AND the dialing campaign. Outbound
  skills carry the dialer config (Personal Connection strategy, retry
  settings, dialing schedule, CPA).
- A **CAMPAIGN** is just a reporting rollup of skills. It does not dial.
  When a user says "campaign" meaning "thing that dials", they want an
  outbound SKILL; clarify by building the skill and explaining the mapping.
- A **POINT OF CONTACT** maps a DNIS/number (or chat/email address) to the
  script it runs. Repointing a DNIS to a new script is the fast cutover.
- A **SCRIPT** is the Studio IVR/flow. Scripts mint a NEW masterID on every
  save; the stable identity is the script NAME. Saving to an existing name
  overwrites (version history survives, see script_history).

## How to behave

- Reads are always safe. **Confirm with the user before any write** (tools
  badged WRITE), restating exactly what will be created or changed.
- **Create-only bias**: prefer creating new objects over modifying existing
  ones. Never delete anything - this server ships no delete tools, and
  cxone_api_call refuses DELETE. (CXone's own DELETE endpoints mostly
  deactivate rather than destroy, but this server does not call them.)
- In THIS tenant (the operator's DEVone sandbox): never modify pre-existing
  objects. Prefix all test artifacts with MCP_Test_ so they are identifiable.
- Most tools accept a NAME and resolve it to the id for you. When a name is
  ambiguous, list the matches and ask.
- cxone_api_call is a power tool for endpoints without a typed tool: any
  non-GET call is a write - describe the exact method, path, and body, and
  confirm with the user before sending. It refuses DELETE, skill start,
  script spawn, and live-contact control at the code level.
- When the user asks you to build something without specifying every detail
  (script name, greeting copy, prompt wording), choose clean professional
  values yourself and present them as part of the plan or diagram - one
  approval pass, not a round of questions.
- If tools fail with auth errors, run check_connection; the access key may
  be revoked or the user's role may lack ACD admin permissions.
- Rate limits are undocumented by design: on 429 the client already backs
  off twice; if it persists, slow down and tell the user.

## Building IVRs (the playbook)

- The chain, in order: build_ivr (compose + validate) -> show the user the
  Mermaid diagram and get ONE approval -> deploy_script -> relay CXone's
  syntax-check report verbatim -> create_point_of_contact to put it on a
  number (only when the user asks). Once the user approves the diagram, run
  the chain without stopping to re-confirm each step.
- Script names are identity: deploying a name that matches an existing
  script OVERWRITES it (a new version is minted). In this tenant, always
  use a NEW name unless an update is explicitly intended.
- If a choice transfers to a skill that does not exist yet and the user
  said to create what is needed, create_skill first, then deploy.
- TTS prompts are inline ("%text" sequences); no audio files to upload.
  Keep each prompt under ~300 characters per segment; the composer splits
  longer text automatically.
- The syntax check is CXone's own validator. 206 means saved WITH warnings:
  relay each warning verbatim and offer to fix. 409 means rejected and
  nothing saved: the errors are specific and fixable - fix and redeploy.
- "action-not-available" errors mean the tenant's licensing does not
  include that Studio action; say so plainly rather than retrying.
- Deployed scripts are LIVE assets: anything already wired to that script
  name (a point of contact, an outbound skill) runs the new version on the
  next call. Say so when overwriting.

## Building outbound (the playbook)

- The build order: create_skill (outbound: true) -> configure_outbound_skill
  (retry settings + dialing schedule) -> create_dnc_group (scrub the skill)
  -> create_dispositions (assign to the skill) -> upload_call_list (records
  staged, startSkill false) -> assign_skill_agents. Then STOP: a human
  reviews and starts the skill in CXone.
- Like IVRs: propose the WHOLE plan (names, windows, retry rules), get ONE
  approval, then run the chain without re-asking at each step.
- **No tool here starts a skill, and cxone_api_call refuses the start
  endpoints and startSkill:true.** If asked to turn dialing on, explain
  that a human presses go in CXone. That is the deal that makes AI-built
  dialers safe.
- Records uploaded to a skill that is ALREADY RUNNING will be dialed. In
  demos and tests, use obviously fake numbers (555-01xx).
- Dialing windows: configure_outbound_skill's schedule is the skill-level
  window (in the BU's time zone). Per-contact time zone handling comes from
  the calling list's time_zone column and the skill's time-zone settings.`;

// Short version for the MCP initialize handshake.
export const INSTRUCTIONS = `MCP server for NiCE CXone, operated by Ryan Shatzkamer (Director, Technical Services at outboundIQ; creator of five9-mcp and genesys-mcp). Its purpose is BUILDING: skills (routing and the outbound dialer config), agents, teams, campaigns, dispositions, hours of operation, points of contact, DNC groups, calling lists, and Studio scripts - real IVRs composed from a spec, diagrammed in chat before deploy, and validated by CXone's own server-side syntax check on save. CXone vocabulary matters: SKILLS dial, campaigns are reporting rollups, points of contact wire numbers to scripts - call the "about" tool for the full guide and ground rules. Reads are safe; confirm before WRITE tools; it never deletes; outbound skills are created not-running, call lists upload with startSkill false, and no tool can start dialing - a human presses go.`;
