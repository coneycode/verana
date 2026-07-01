export function renderHomePage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Verana</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --panel:#111a2e; --panel2:#16233c; --text:#dce7ff; --muted:#8fa4c7; --accent:#7dd3fc; --ok:#86efac; --warn:#fbbf24; --bad:#fca5a5; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: radial-gradient(circle at top left,#172554,#0b1020 36rem); color:var(--text); }
    header { padding: 22px 28px; border-bottom:1px solid #26344f; display:flex; align-items:center; justify-content:space-between; }
    h1 { margin:0; font-size:20px; letter-spacing:.04em; }
    main { display:grid; grid-template-columns: 330px 1fr; gap:18px; padding:18px; min-height: calc(100vh - 74px); }
    section { background: color-mix(in srgb, var(--panel) 94%, transparent); border:1px solid #26344f; border-radius:14px; overflow:hidden; box-shadow:0 12px 38px #0005; }
    .section-title { padding:14px 16px; background:#0f172a; border-bottom:1px solid #26344f; color:#fff; font-weight:700; }
    .body { padding:14px; }
    input, textarea, button { font:inherit; border-radius:10px; border:1px solid #334766; background:#0b1222; color:var(--text); }
    textarea { width:100%; min-height:78px; padding:10px; resize:vertical; }
    input { width:100%; padding:9px 10px; }
    button { padding:9px 12px; background:#1d4ed8; border-color:#3b82f6; cursor:pointer; font-weight:650; }
    button.secondary { background:#14213a; border-color:#334766; }
    button.good { background:#166534; border-color:#22c55e; }
    button.bad { background:#7f1d1d; border-color:#ef4444; }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .row { display:flex; gap:8px; align-items:center; }
    .stack { display:flex; flex-direction:column; gap:10px; }
    .project { padding:11px; border:1px solid #293a57; border-radius:12px; margin-bottom:8px; background:#0b1222; cursor:pointer; }
    .project.active { border-color:var(--accent); background:#10203a; }
    .muted { color:var(--muted); font-size:13px; }
    .pill { display:inline-flex; padding:3px 8px; border-radius:999px; background:#1e293b; border:1px solid #334155; color:#cbd5e1; font-size:12px; }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
    pre { white-space:pre-wrap; word-break:break-word; background:#050b17; border:1px solid #1f2d46; border-radius:12px; padding:12px; margin:0; color:#dbeafe; max-height:340px; overflow:auto; }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th,td { text-align:left; border-bottom:1px solid #26344f; padding:8px; vertical-align:top; }
    th { color:#bcd2ff; background:#101827; }
    .ok { color:var(--ok); } .warn { color:var(--warn); } .badtext { color:var(--bad); }
    .actions { flex-wrap:wrap; }
  </style>
</head>
<body>
  <header><h1>Verana · Agent Workflow Delivery</h1><div class="muted" id="connection">SSE: idle</div></header>
  <main>
    <section>
      <div class="section-title">Projects</div>
      <div class="body stack">
        <textarea id="goal" placeholder="输入流程目标,例如: 调研海外红人监控系统"></textarea>
        <button id="createBtn">创建项目</button>
        <div id="projects"></div>
      </div>
    </section>
    <section>
      <div class="section-title">Workspace</div>
      <div class="body stack">
        <div id="empty" class="muted">选择或创建一个项目。</div>
        <div id="detail" style="display:none" class="stack">
          <div class="row actions">
            <button class="secondary" id="refreshBtn">刷新</button>
            <button id="clarifyBtn">澄清</button>
            <button id="planBtn">生成 Plan</button>
            <button class="good" id="approvePlanBtn">通过 plan_review</button>
            <button id="runBtn">执行 Run</button>
            <button class="good" id="approveFinalBtn">通过 final_review</button>
          </div>
          <div class="grid">
            <section><div class="section-title">Status</div><div class="body"><pre id="statusBox"></pre></div></section>
            <section><div class="section-title">Clarifier</div><div class="body stack"><pre id="clarifierBox"></pre><input id="answer" placeholder="回答当前澄清问题"/><button id="answerBtn">提交回答</button></div></section>
          </div>
          <section><div class="section-title">Tasks</div><div class="body"><div id="tasks"></div></div></section>
          <div class="grid">
            <section><div class="section-title">Claim / Verdict</div><div class="body"><pre id="logsBox">选择 run 后查看。</pre></div></section>
            <section><div class="section-title">Events</div><div class="body"><pre id="eventsBox"></pre></div></section>
          </div>
        </div>
      </div>
    </section>
  </main>
<script>
let selectedId = null;
let state = null;
let source = null;
const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'content-type':'application/json' }, ...options });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function post(path, body = {}) { return api(path, { method:'POST', body: JSON.stringify(body) }); }

async function loadProjects() {
  const projects = await api('/projects');
  $('projects').innerHTML = projects.map(p => '<div class="project '+(p.id===selectedId?'active':'')+'" data-id="'+escapeHtml(p.id)+'"><div><b>'+escapeHtml(p.id)+'</b></div><div class="muted">'+escapeHtml(p.status)+'</div><div class="muted">'+escapeHtml(p.goal)+'</div></div>').join('');
  document.querySelectorAll('.project').forEach(el => el.addEventListener('click', () => selectProject(el.dataset.id)));
}
async function selectProject(id) {
  selectedId = id;
  $('empty').style.display='none'; $('detail').style.display='flex';
  await refresh();
  connectEvents();
}
async function refresh() {
  if (!selectedId) return;
  state = await api('/projects/'+selectedId);
  render();
  await loadProjects();
}
function render() {
  $('statusBox').textContent = JSON.stringify({ project: state.project, status: state.status }, null, 2);
  const clarifier = state.status.clarifier;
  $('clarifierBox').textContent = clarifier ? JSON.stringify(clarifier, null, 2) : '尚未澄清。点击“澄清”查看下一问题。';
  const workflow = state.status.workflows.solution;
  const tasks = workflow?.tasks || {};
  $('tasks').innerHTML = Object.values(tasks).length ? '<table><tr><th>Task</th><th>Status</th><th>Runs</th><th>Action</th></tr>' + Object.values(tasks).map(t => '<tr><td>'+escapeHtml(t.id)+'</td><td><span class="pill">'+escapeHtml(t.status)+'</span></td><td>'+escapeHtml((t.runs||[]).join(', '))+'</td><td>'+((t.runs||[]).map(r => '<button class="secondary run-log" data-run="'+escapeHtml(r)+'">'+escapeHtml(r)+'</button>').join(' '))+'</td></tr>').join('') + '</table>' : '<div class="muted">暂无 task。先生成 Plan。</div>';
  document.querySelectorAll('.run-log').forEach(el => el.addEventListener('click', () => loadLog(el.dataset.run)));
}
async function loadLog(runId) {
  const log = await api('/projects/'+selectedId+'/runs/'+runId);
  $('logsBox').textContent = JSON.stringify(log, null, 2);
}
function connectEvents() {
  if (source) source.close();
  source = new EventSource('/projects/'+selectedId+'/events');
  $('connection').textContent = 'SSE: connecting';
  source.onopen = () => $('connection').textContent = 'SSE: connected';
  source.onerror = () => $('connection').textContent = 'SSE: disconnected';
  source.onmessage = (event) => appendEvent('message', event.data);
  ['snapshot','project_created','plan_composed','gate_approved','gate_rejected','run_completed','input_recorded'].forEach(type => source.addEventListener(type, event => { appendEvent(type, event.data); refresh(); }));
}
function appendEvent(type, data) { $('eventsBox').textContent = '['+new Date().toLocaleTimeString()+'] '+type+' '+data+'\\n' + $('eventsBox').textContent; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

$('createBtn').onclick = async () => { const goal = $('goal').value.trim(); if (!goal) return; const created = await post('/projects', { goal }); selectedId = created.project.id; $('goal').value=''; await loadProjects(); await selectProject(selectedId); };
$('refreshBtn').onclick = refresh;
$('clarifyBtn').onclick = async () => { const r = await api('/projects/'+selectedId+'/clarify'); $('clarifierBox').textContent = JSON.stringify(r, null, 2); };
$('answerBtn').onclick = async () => { const answer = $('answer').value.trim(); if (!answer) return; await post('/projects/'+selectedId+'/input', { answer }); $('answer').value=''; await refresh(); };
$('planBtn').onclick = async () => { await post('/projects/'+selectedId+'/plan'); await refresh(); };
$('approvePlanBtn').onclick = async () => { await post('/projects/'+selectedId+'/approve', { gate: 'plan_review', note: 'UI approve plan' }); await refresh(); };
$('runBtn').onclick = async () => { await post('/projects/'+selectedId+'/run'); await refresh(); };
$('approveFinalBtn').onclick = async () => { await post('/projects/'+selectedId+'/approve', { gate: 'final_review', note: 'UI approve final' }); await refresh(); };
loadProjects();
</script>
</body>
</html>`;
}
