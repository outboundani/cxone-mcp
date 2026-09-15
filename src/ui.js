// Web UI - a landing page (GET /) and setup wizard (GET /setup). Pure
// server-rendered HTML with inline CSS/JS, no assets.
import { TOOL_GROUPS as GROUPS, WRITE_TOOLS } from './tools.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortDesc(d) {
  return d.replace(/e\.g\./g, '§').split('. ')[0].replace(/§/g, 'e.g.').replace(/\.$/, '');
}

function grouped(tools) {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const seen = new Set();
  const out = GROUPS.map((g) => ({
    ...g,
    items: g.tools.filter((n) => byName[n]).map((n) => { seen.add(n); return byName[n]; }),
  })).filter((g) => g.items.length);
  const rest = tools.filter((t) => !seen.has(t.name));
  if (rest.length) out.push({ name: 'Other', icon: '🧩', items: rest });
  return out;
}

const BASE_CSS = `
  :root{--bg:#f7f8fb;--card:#ffffff;--ink:#151b26;--muted:#5b6779;--line:#e4e8ef;--accent:#2563eb;--accent2:#06b6d4;--ok:#16a34a;--warn:#d97706;--err:#dc2626;--code:#eef1f6;--shadow:0 1px 2px rgba(16,24,40,.05),0 4px 16px rgba(16,24,40,.06)}
  @media (prefers-color-scheme:dark){:root{--bg:#0d1117;--card:#161c26;--ink:#e6ebf2;--muted:#93a1b3;--line:#232b38;--accent:#60a5fa;--accent2:#22d3ee;--code:#1e2733;--shadow:0 1px 2px rgba(0,0,0,.4)}}
  *{box-sizing:border-box}
  body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink);line-height:1.6;-webkit-font-smoothing:antialiased}
  a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em}
  code{background:var(--code);padding:.12em .4em;border-radius:5px}
  pre{background:var(--code);padding:.85rem 1rem;border-radius:10px;overflow-x:auto;line-height:1.5}
  .pill{display:inline-flex;align-items:center;gap:.35em;font-size:.78rem;font-weight:600;padding:.18em .65em;border-radius:999px;border:1px solid var(--line);background:var(--card)}
  .badge{font-size:.7rem;font-weight:700;letter-spacing:.03em;padding:.1em .5em;border-radius:999px}
  .badge.read{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
  .badge.write{color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}
  .btn{display:inline-flex;align-items:center;gap:.4em;padding:.55em 1.1em;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-weight:600;font-size:.92rem;cursor:pointer;box-shadow:var(--shadow)}
  .btn:hover{border-color:var(--accent);text-decoration:none}
  .btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:0}
  .btn.primary:hover{filter:brightness(1.08)}
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${BASE_CSS}</style></head>
<body>${body}</body></html>`;
}

export function landingPage(tools, cfg = { configured: true }) {
  const groups = grouped(tools);
  const toolCards = groups.map((g) => `
    <section class="tgroup">
      <h3>${g.icon} ${esc(g.name)}</h3>
      <div class="tgrid">
        ${g.items.map((t) => `
        <div class="tcard">
          <div class="trow"><code>${esc(t.name)}</code>
          <span class="badge ${WRITE_TOOLS.has(t.name) ? 'write">WRITE' : 'read">READ'}</span></div>
          <p>${esc(shortDesc(t.description))}.</p>
        </div>`).join('')}
      </div>
    </section>`).join('');

  return page('cxone-mcp - NiCE CXone for AI, over MCP', `
  <style>
  main{max-width:1060px;margin:0 auto;padding:0 1.25rem 4rem}
  .hero{padding:4rem 0 2.5rem;text-align:center}
  .hero h1{font-size:clamp(2rem,5.5vw,3.2rem);margin:.2em 0;letter-spacing:-.03em;line-height:1.12}
  .hero h1 span{background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
  .hero p.tag{font-size:1.12rem;color:var(--muted);max-width:660px;margin:.6rem auto 1.4rem}
  .hero .pills{display:flex;gap:.5rem;justify-content:center;flex-wrap:wrap;margin-bottom:1.5rem}
  .hero .ctas{display:flex;gap:.7rem;justify-content:center;flex-wrap:wrap}
  h2{font-size:1.45rem;letter-spacing:-.02em;margin:2.8rem 0 .4rem}
  .steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem}
  .step{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.1rem 1.2rem;box-shadow:var(--shadow)}
  .step .n{display:inline-flex;width:1.7em;height:1.7em;align-items:center;justify-content:center;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-weight:700;font-size:.9rem;margin-bottom:.5rem}
  .step h3{margin:.1rem 0 .4rem;font-size:1.02rem}
  .step p{margin:.3rem 0;font-size:.92rem;color:var(--muted)}
  .tgroup h3{margin:1.6rem 0 .6rem;font-size:1.08rem}
  .tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:.7rem}
  .tcard{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.75rem .95rem;box-shadow:var(--shadow)}
  .tcard .trow{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
  .tcard p{margin:.35rem 0 0;font-size:.87rem;color:var(--muted)}
  footer{border-top:1px solid var(--line);margin-top:3rem;padding:1.6rem 0;color:var(--muted);font-size:.9rem;text-align:center}
  </style>
  <main>
  <div class="hero">
    <h1>Your CXone tenant,<br><span>in your AI's hands</span></h1>
    <p class="tag">An open-source MCP server that connects Claude, ChatGPT, or any MCP client to
    NiCE CXone, built to <strong>build</strong>: skills, agents, the outbound dialer config, and
    real Studio IVRs with nested submenus - composed from plain english, diagrammed in chat,
    validated by CXone's own syntax check on save.</p>
    <div class="pills">
      <span class="pill">🛠️ ${tools.length} tools</span>
      <span class="pill">📦 zero dependencies</span>
      <span class="pill">☁️ Cloudflare Workers</span>
      <span class="pill">🏗️ builds, not just reads</span>
    </div>
    <div class="ctas">
      ${cfg.configured
        ? '<a class="btn primary" href="#tools">🛠️ Browse the tools</a>'
        : '<a class="btn primary" href="/setup">⚙️ Finish setup - connect your CXone tenant</a>'}
      <a class="btn" href="https://github.com/outboundani/cxone-mcp">★ Star on GitHub</a>
    </div>
    ${cfg.configured ? '' : `<p style="margin-top:1rem"><span class="pill">👋 This server isn't connected to a CXone tenant yet - <a href="/setup">finish setup</a> (takes 1 minute, no terminal needed)</span></p>`}
  </div>

  <h2>Set up your own in 3 steps</h2>
  <div class="steps">
    <div class="step"><span class="n">1</span><h3>Deploy to Cloudflare</h3>
      <p>Deploy your own copy on Cloudflare's free tier - <code>git clone</code> +
      <code>npx wrangler deploy</code>, or use the Deploy button in the README.</p></div>
    <div class="step"><span class="n">2</span><h3>Create a CXone access key</h3>
      <p>In CXone: <strong>Admin → Employees → (a least-privilege admin user) → Security →
      Add Access Key</strong>. Then open <code>/setup</code> here and paste the Access Key ID and
      Secret - the tenant and region are discovered automatically.</p></div>
    <div class="step"><span class="n">3</span><h3>Connect your AI</h3>
      <p>Point Claude or ChatGPT at <code>https://&lt;your-worker&gt;/mcp</code> and paste the
      access key from setup. Then try: <em>"check the connection and list my skills."</em></p></div>
  </div>

  <h2 id="tools">Tools</h2>
  ${toolCards}
  <footer>cxone-mcp · MIT · built by <a href="https://www.linkedin.com/in/ryanshatzkamer">Ryan Shatzkamer</a> (outboundIQ) · creator of <a href="https://github.com/outboundani/five9-mcp">five9-mcp</a> and <a href="https://github.com/outboundani/genesys-mcp">genesys-mcp</a></footer>
  </main>`);
}

export function setupPage(cfg) {
  return page('Setup · cxone-mcp', `
  <style>
  main{max-width:560px;margin:0 auto;padding:3rem 1.25rem 4rem}
  h1{letter-spacing:-.02em}
  label{display:block;font-size:.88rem;font-weight:600;margin:1.1rem 0 .3rem}
  input{width:100%;padding:.6rem .7rem;border:1px solid var(--line);border-radius:9px;font-size:1rem;background:var(--card);color:var(--ink)}
  .out{margin-top:1.2rem;display:none;border-radius:10px;padding:.8rem 1rem;font-size:.95rem;white-space:pre-wrap;word-break:break-all}
  .out.ok{display:block;background:color-mix(in srgb,var(--ok) 10%,transparent);border:1px solid var(--ok)}
  .out.err{display:block;background:color-mix(in srgb,var(--err) 10%,transparent);border:1px solid var(--err)}
  .hint{color:var(--muted);font-size:.88rem}
  </style>
  <main>
  <h1>⚙️ Connect your CXone tenant</h1>
  <p class="hint">Create an access key in CXone (<strong>Admin → Employees → your API user →
  Security → Add Access Key</strong> - use a dedicated least-privilege admin account), then paste
  it here. The wizard tests the credentials live against CXone before saving, and discovers your
  tenant and region automatically - no cluster names, no API URLs.</p>
  ${cfg.source === 'env' ? '<p class="hint">⚠️ This server is configured with Wrangler secrets - the wizard is disabled. Update it with <code>npx wrangler secret put</code>.</p>' : ''}
  <form id="f">
    ${cfg.configured ? '<label>Current access key (required to change config)</label><input type="password" name="current_key" autocomplete="off">' : ''}
    <label>Access Key ID</label><input name="access_key_id" autocomplete="off" required>
    <label>Access Key Secret</label><input type="password" name="access_key_secret" autocomplete="off" required>
    <label>API base override <span style="font-weight:400;color:var(--muted)">(optional - discovered automatically)</span></label>
    <input name="api_base" autocomplete="off" placeholder="https://api-na1.niceincontact.com">
    <button class="btn primary" style="margin-top:1.3rem;width:100%" type="submit">Test &amp; save</button>
  </form>
  <div class="out" id="out"></div>
  <script>
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = document.getElementById('out');
    out.className = 'out'; out.textContent = 'Testing against CXone…'; out.style.display = 'block';
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      const res = await fetch('/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const j = await res.json();
      if (!res.ok) { out.className = 'out err'; out.textContent = j.error || 'Setup failed.'; return; }
      out.className = 'out ok';
      out.textContent = j.note + (j.accessKey ? '\\n\\nACCESS KEY: ' + j.accessKey : '');
    } catch (err) { out.className = 'out err'; out.textContent = String(err); }
  });
  </script>
  </main>`);
}
