# nice-mcp

**Your CXone tenant, in your AI's hands.** An open-source MCP server for NiCE CXone on Cloudflare Workers. Zero dependencies, no terminal required, and its whole purpose is to **build**: skills (routing AND the outbound dialer config), agents, teams, campaigns, dispositions, hours of operation, points of contact, DNC groups, calling lists - and **Studio scripts**: real IVRs composed from plain english, diagrammed in chat before deploy, and validated by CXone's own server-side syntax check on save.

> It builds, not just reads.

Prompt Claude (or any MCP client):

- *"create an outbound skill called Fall Reactivation with Personal Connection, 3 attempts max, retry no-answers after 4 hours"*
- *"build an IVR: greet callers, press 1 for sales, 2 for support, 3 to hear our hours. show me the diagram first"*
- *"draw my Main Inbound script as a diagram"*
- *"stage 200 test records on the reactivation skill - do not start anything"*
- *"create a DNC group seeded with these numbers and scrub the reactivation skill against it"*
- *"repoint our main number to the new script"*

The IVR builder composes the real web-Studio script JSON, shows you the flow as a Mermaid diagram in chat, then saves through CXone's scripts API - CXone runs its own **syntax check server-side** before anything lands, and the report comes back verbatim.

## What it deliberately does NOT do

- **No analytics or KPI tools.** This is the build side of the house, on purpose.
- **No dialing ignition.** Outbound skills are created **not running**, calling lists always upload with `startSkill: false` (hard-coded), and no tool can start a skill. The raw API tool refuses the start endpoints at the code level. The AI builds the dialer; a human presses go.
- **No live-contact control.** No barge, no end-call, no recording toggles - the raw API tool refuses the contacts endpoints.
- **No deletes.** There are no delete tools, and the raw API tool refuses `DELETE`. Create-first by design.

## Deploy your own in 3 steps

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/outboundani/nice-mcp)

1. **Deploy**: click the button (free Cloudflare account), or `git clone` + `npx wrangler deploy`. The CONFIG KV namespace is auto-provisioned.
2. **Create a CXone access key**: Admin → Employees → (a dedicated least-privilege admin user) → Security tab → **Add Access Key**. Copy the ID and Secret (the secret is shown once).
3. **Configure**: open `/setup` on your new Worker and paste the Access Key ID and Secret. That's it - the wizard validates them live against CXone, discovers your tenant and regional API host automatically (no cluster names, no API URLs), then hands you your access key for MCP clients (shown once).

Prefer terminal-managed config? Set Wrangler secrets instead; they override the wizard: `CXONE_ACCESS_KEY_ID`, `CXONE_ACCESS_KEY_SECRET`, `MCP_AUTH_TOKEN` (and optionally `CXONE_API_BASE` for private clusters).

## Connect your AI

The MCP endpoint is `https://<your-worker>/mcp`.

- **Claude (web/desktop)**: Settings → Connectors → Add custom connector → paste the URL. When the authorization screen appears, paste your access key.
- **Claude Code**: `claude mcp add --transport http cxone https://<your-worker>/mcp` and authenticate when prompted.
- **ChatGPT**: Settings → Connectors → Advanced → Developer mode → add the MCP server URL.
- **Anything else**: standard streamable HTTP MCP with OAuth 2.1 (or send the access key as a Bearer token).

Then try: *"check the connection and list my skills."*

## The toolbox (37 tools)

| Group | Tools |
|---|---|
| 🔌 Tenant & Connection | `about`, `check_connection`, `get_business_unit` |
| 🎯 Skills (Routing & Dialer) | `list_skills`, `get_skill`, `create_skill` ✏️, `configure_outbound_skill` ✏️, `assign_skill_agents` ✏️ |
| 👥 Agents & Teams | `list_agents`, `get_agent`, `list_teams`, `create_team` ✏️ |
| 🗂️ Campaigns & Dispositions | `list_campaigns`, `create_campaign` ✏️, `list_dispositions`, `create_dispositions` ✏️ |
| 🕐 Hours & Codes | `list_hours_of_operation`, `create_hours_of_operation` ✏️, `list_unavailable_codes`, `create_unavailable_code` ✏️ |
| 📇 Numbers & Entry Points | `list_points_of_contact`, `create_point_of_contact` ✏️, `repoint_point_of_contact` ✏️, `list_dnis`, `list_address_books`, `create_address_book` ✏️ |
| 📤 Outbound Compliance & Records | `list_dnc_groups`, `create_dnc_group` ✏️, `list_call_lists`, `upload_call_list` ✏️ |
| 🏗️ Studio Scripts (IVR Builder) | `list_scripts`, `get_script`, `render_script`, `build_ivr`, `deploy_script` ✏️, `script_history` |
| ⚡ Power | `cxone_api_call` ✏️ (any ACD Admin API endpoint; GET/POST/PUT/PATCH only, refuses DELETE and everything that dials) |

✏️ = writes to your tenant. Reads are always safe; connected AIs are instructed to confirm before every write.

## CXone vocabulary (worth 30 seconds)

CXone names things differently than Five9 or Genesys, and the server teaches your AI the mapping:

- A **skill** is the workhorse: the queue AND the dialing campaign. Outbound skills carry the dialer config (Personal Connection, retry settings, schedules, CPA).
- A **campaign** is a reporting rollup of skills. It does not dial.
- A **point of contact** wires a phone number (DNIS) to the script it runs. Repointing is the fast cutover.
- A **script** is the Studio IVR. Every save mints a new version; the name is the identity, and history survives.

## For the nerds

- **Zero dependencies.** Not one npm package. The Worker is plain JS on `fetch` and Web Crypto.
- **Two-field setup.** Auth is CXone's User Hub access-key flow; the token's own claims name the tenant, and the public `.well-known/cxone-configuration` endpoint maps it to the regional API host. Paste two keys, everything else is discovered.
- **The IVR builder writes the real web-Studio JSON** (`header`, `actions`, `properties`, `branches`) against CXone's global action library (BEGIN, MENU, PLAY, REQAGENT, MUSIC, HANGUP), and saves through `POST /scripts` - the same endpoint web Studio itself saves through. CXone's server-side SYNTAX_CHECK validates every save and its errors/warnings are relayed verbatim.
- **Any script diagrams.** Web-Studio scripts render from their JSON; Desktop-Studio-only scripts fall back to a best-effort render of their XML export. Instant documentation either way.
- **OAuth 2.1 built in** (dynamic client registration, PKCE, stateless HMAC-signed tokens), so it plugs straight into Claude and ChatGPT as a connector.
- **Rate limits are undocumented by design** on CXone; the client retries once on 401 and backs off exponentially on 429.
- Tested against a live CXone tenant: 12 unit tests plus a 40-step live smoke suite (`npm test`, `npm run smoke` - read-only by default, `-- --writes` exercises the write tools in a sandbox).

## Scoping the access key

The access key inherits the CXone role of the employee it belongs to. Make a dedicated user with a role scoped to what you want the AI to touch (ACD read + the create permissions you actually need), and generate the key on that user. CXone enforces the role server-side no matter what this Worker asks for.

## License

MIT. Built by [Ryan Shatzkamer](https://www.linkedin.com/in/ryanshatzkamer) (Director, Technical Services @ [outboundIQ](https://outboundiq.com)) - creator of [five9-mcp](https://github.com/outboundani/five9-mcp) and [genesys-mcp](https://github.com/outboundani/genesys-mcp). This is platform number three.
