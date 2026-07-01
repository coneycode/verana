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
    button { padding:10px 16px; background:#1d4ed8; border-color:#3b82f6; cursor:pointer; font-weight:650; transition: background .15s; }
    button:hover { background:#2563eb; }
    button.secondary { background:#14213a; border-color:#334766; }
    button.good { background:#166534; border-color:#22c55e; }
    button.good:hover { background:#15803d; }
    button.bad { background:#7f1d1d; border-color:#ef4444; }
    button:disabled { opacity:.35; cursor:not-allowed; }
    button:disabled:hover { background:#1d4ed8; }
    .row { display:flex; gap:8px; align-items:center; }
    .stack { display:flex; flex-direction:column; gap:10px; }
    .project { padding:11px; border:1px solid #293a57; border-radius:12px; margin-bottom:8px; background:#0b1222; cursor:pointer; transition: border-color .15s; }
    .project:hover { border-color:#3b5278; }
    .project.active { border-color:var(--accent); background:#10203a; }
    .muted { color:var(--muted); font-size:13px; }
    .pill { display:inline-flex; padding:3px 8px; border-radius:999px; background:#1e293b; border:1px solid #334155; color:#cbd5e1; font-size:12px; }
    .pill.ok { background:#052e16; border-color:#22c55e; color:var(--ok); }
    .pill.warn { background:#422006; border-color:#f59e0b; color:var(--warn); }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
    pre { white-space:pre-wrap; word-break:break-word; background:#050b17; border:1px solid #1f2d46; border-radius:12px; padding:12px; margin:0; color:#dbeafe; max-height:340px; overflow:auto; font-size:13px; }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th,td { text-align:left; border-bottom:1px solid #26344f; padding:8px; vertical-align:top; }
    th { color:#bcd2ff; background:#101827; }
    .ok { color:var(--ok); } .warn { color:var(--warn); } .badtext { color:var(--bad); }
    .actions { flex-wrap:wrap; }

    /* 步骤指引器 */
    .steps { display:flex; gap:0; margin-bottom:16px; overflow-x:auto; }
    .step { flex:1; min-width:90px; padding:10px 8px; text-align:center; font-size:12px; color:var(--muted); border-bottom:3px solid #26344f; position:relative; }
    .step.done { color:var(--ok); border-bottom-color:var(--ok); }
    .step.active { color:var(--accent); border-bottom-color:var(--accent); font-weight:700; }
    .step-num { display:inline-block; width:20px; height:20px; line-height:20px; border-radius:50%; background:#1e293b; border:1px solid #334155; margin-right:4px; font-size:11px; }
    .step.done .step-num { background:#052e16; border-color:#22c55e; }
    .step.active .step-num { background:#0c4a6e; border-color:var(--accent); }

    /* 引导面板 */
    .guide { padding:16px; border:1px solid #1e3a5f; border-radius:12px; background:#0c1629; margin-bottom:14px; }
    .guide-title { font-size:15px; font-weight:700; margin-bottom:6px; color:var(--accent); }
    .guide-desc { font-size:14px; color:var(--text); margin-bottom:12px; line-height:1.5; }
    .risk-box { padding:10px; border-radius:8px; background:#422006; border:1px solid #f59e0b; color:var(--warn); font-size:13px; margin:8px 0; }

    .qa-item { padding:8px 0; border-bottom:1px solid #1e293b; }
    .qa-q { font-weight:600; color:var(--accent); font-size:13px; }
    .qa-a { color:var(--text); font-size:14px; margin-top:2px; }
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
          <div class="steps" id="steps"></div>
          <div id="guidePanel"></div>
          <div class="grid">
            <section><div class="section-title">Clarifier</div><div class="body"><div id="clarifierBox"></div></div></section>
            <section><div class="section-title">Tasks</div><div class="body"><div id="tasks"></div></div></section>
          </div>
          <div class="grid">
            <section><div class="section-title">Claim / Verdict</div><div class="body"><pre id="logsBox">选择 run 查看详情。</pre></div></section>
            <section><div class="section-title">Events</div><div class="body"><pre id="eventsBox"></pre></div></section>
          </div>
          <details><summary class="muted" style="cursor:pointer;padding:6px">原始状态 JSON</summary><pre id="statusBox"></pre></details>
        </div>
      </div>
    </section>
  </main>
<script>
let selectedId = null;
let state = null;
let source = null;
let busy = false;
const $ = (id) => document.getElementById(id);

const STEPS = [
  { key: 'created', label: '创建', n: 1 },
  { key: 'clarifying', label: '澄清', n: 2 },
  { key: 'composing', label: '合成', n: 3 },
  { key: 'plan_review', label: '审 Plan', n: 4 },
  { key: 'executing', label: '执行', n: 5 },
  { key: 'final_review', label: '审方案', n: 6 },
  { key: 'approved', label: '完成', n: 7 },
];

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
  $('empty').style.display='none';
  $('detail').style.display='flex';
  await refresh();
  connectEvents();
  await maybeAutoStartClarify();
}

async function refresh() {
  if (!selectedId) return;
  state = await api('/projects/'+selectedId);
  render();
  await loadProjects();
}

function getPhase() {
  const clarifier = state.status.clarifier;
  if (clarifier && !state.status.workflows.solution) return "clarifying";
  const wf = state.status.workflows.solution;
  if (!wf) return state.project.status;
  return wf.status;
}

function render() {
  $('statusBox').textContent = JSON.stringify({ project: state.project, status: state.status }, null, 2);
  renderSteps();
  renderGuide();
  renderClarifier();
  renderTasks();
}

function renderSteps() {
  const phase = getPhase();
  const order = STEPS.map(s => s.key);
  const idx = order.indexOf(phase);
  $('steps').innerHTML = STEPS.map((s, i) => {
    let cls = '';
    if (idx === -1) cls = i === 0 ? 'done' : '';
    else if (i < idx) cls = 'done';
    else if (i === idx) cls = 'active';
    return '<div class="step '+cls+'"><span class="step-num">'+s.n+'</span>'+s.label+'</div>';
  }).join('');
}

function renderGuide() {
  const phase = getPhase();
  const el = $('guidePanel');
  const wf = state.status.workflows.solution;

  if (phase === 'created') {
    el.innerHTML = '<div class="guide"><div class="guide-title">第 1 步:开始澄清</div><div class="guide-desc">项目已创建。点击下方按钮开始澄清目标,系统会根据你的目标逐个提问。</div><button id="startClarifyBtn">开始澄清</button></div>';
    $('startClarifyBtn').onclick = () => doClarify();
    return;
  }

  if (phase === 'clarifying') {
    el.innerHTML = '<div class="guide"><div class="guide-title">第 2 步:澄清目标</div><div class="guide-desc" id="clarifyQuestion">正在获取问题...</div><div class="risk-box" id="clarifyRisk" style="display:none"></div><input id="answer" placeholder="输入你的回答" /><div class="row" style="margin-top:8px"><button id="answerBtn">提交回答</button><button class="secondary" id="finishClarifyBtn">跳过,直接生成 Plan</button></div></div>';
    $('answerBtn').onclick = () => doAnswer();
    $('finishClarifyBtn').onclick = () => doPlan();
    loadClarifyQuestion();
    return;
  }

  if (phase === 'composing') {
    el.innerHTML = '<div class="guide"><div class="guide-title">第 3 步:合成 Workflow</div><div class="guide-desc">系统正在根据澄清结果合成方案 workflow...</div></div>';
    return;
  }

  if (phase === 'plan_review') {
    el.innerHTML = '<div class="guide"><div class="guide-title">第 4 步:审核任务拆解</div><div class="guide-desc">系统已生成方案 workflow,包含任务 DAG。请审核下方的 Tasks,确认拆解合理后通过。</div><div class="row"><button class="good" id="approvePlanBtn">通过,开始执行</button><button class="bad" id="rejectPlanBtn">打回重做</button></div></div>';
    $('approvePlanBtn').onclick = () => doApprove('plan_review');
    $('rejectPlanBtn').onclick = () => doReject('plan_review');
    return;
  }

  if (phase === 'executing') {
    el.innerHTML = '<div class="guide"><div class="guide-title">第 5 步:执行中</div><div class="guide-desc">系统正在按 DAG 逐个执行 task,每个 task 完成后独立验证。请等待...</div><button class="secondary" id="runContinueBtn">继续执行</button></div>';
    $('runContinueBtn').onclick = () => doRun();
    return;
  }

  if (phase === 'final_review') {
    el.innerHTML = '<div class="guide"><div class="guide-title">第 6 步:审核最终方案</div><div class="guide-desc">所有 task 已完成并通过验证。请审核方案交付物,确认闭环。</div><div class="row"><button class="good" id="approveFinalBtn">通过,方案闭环</button><button class="bad" id="rejectFinalBtn">打回重做</button></div></div>';
    $('approveFinalBtn').onclick = () => doApprove('final_review');
    $('rejectFinalBtn').onclick = () => doReject('final_review');
    return;
  }

  if (phase === 'approved') {
    el.innerHTML = '<div class="guide"><div class="guide-title" style="color:var(--ok)">方案闭环完成</div><div class="guide-desc">方案阶段已结束,项目状态: solution_approved。后续可进入实现阶段(待开发)。</div></div>';
    return;
  }

  if (phase === 'awaiting_input') {
    el.innerHTML = '<div class="guide"><div class="guide-title" style="color:var(--warn)">需要补充信息</div><div class="guide-desc">执行过程中需要你提供信息才能继续。</div><input id="answer" placeholder="输入补充信息" /><button id="answerBtn" style="margin-top:8px">提交</button></div>';
    $('answerBtn').onclick = () => doAnswer();
    return;
  }

  if (phase === 'blocked' || phase === 'failed') {
    el.innerHTML = '<div class="guide"><div class="guide-title" style="color:var(--bad)">状态: '+escapeHtml(phase)+'</div><div class="guide-desc">'+escapeHtml(state.status.blocked_reason || '遇到问题。')+'</div><button class="secondary" id="retryBtn">重试</button></div>';
    $('retryBtn').onclick = () => doRun();
    return;
  }

  el.innerHTML = '<div class="guide"><div class="guide-desc muted">未知状态: '+escapeHtml(String(phase))+'</div></div>';
}

async function loadClarifyQuestion() {
  try {
    const r = await api('/projects/'+selectedId+'/clarify');
    if (r.question) {
      $('clarifyQuestion').textContent = 'Q: ' + r.question;
      if (r.risk) { $('clarifyRisk').textContent = '⚠ ' + r.risk; $('clarifyRisk').style.display = 'block'; }
    } else if (r.summary) {
      $('clarifyQuestion').innerHTML = '目标已足够清晰,可直接生成 Plan。<pre style="margin-top:8px">'+escapeHtml(r.summary)+'</pre>';
    } else {
      $('clarifyQuestion').textContent = '目标已足够清晰。';
    }
  } catch (e) {
    $('clarifyQuestion').textContent = '获取问题失败: ' + e.message;
  }
}

function renderClarifier() {
  const clarifier = state.status.clarifier;
  const el = $('clarifierBox');
  const entries = clarifier?.clarifications ?? [];
  if (entries.length === 0) { el.innerHTML = '<div class="muted">暂无澄清记录。</div>'; return; }
  el.innerHTML = entries.map(e => '<div class="qa-item"><div class="qa-q">Q: '+escapeHtml(e.q)+'</div><div class="qa-a">A: '+escapeHtml(e.a)+'</div><div class="muted" style="font-size:12px;margin-top:2px">⚠ '+escapeHtml(e.risk)+'</div></div>').join('');
}

function renderTasks() {
  const wf = state.status.workflows.solution;
  const tasks = wf?.tasks || {};
  const vals = Object.values(tasks);
  if (vals.length === 0) { $('tasks').innerHTML = '<div class="muted">暂无 task。</div>'; return; }
  $('tasks').innerHTML = '<table><tr><th>Task</th><th>Status</th><th>Runs</th></tr>' + vals.map(t => {
    const cls = t.status === 'delivered' ? 'ok' : (t.status === 'failed' ? 'warn' : '');
    return '<tr><td>'+escapeHtml(t.id)+'</td><td><span class="pill '+cls+'">'+escapeHtml(t.status)+'</span></td><td>'+((t.runs||[]).map(r => '<button class="secondary run-log" data-run="'+escapeHtml(r)+'" style="padding:2px 8px;font-size:12px;margin:1px">'+escapeHtml(r)+'</button>').join(' '))+'</td></tr>';
  }).join('') + '</table>';
  document.querySelectorAll('.run-log').forEach(el => el.addEventListener('click', () => loadLog(el.dataset.run)));
}

async function loadLog(runId) {
  const log = await api('/projects/'+selectedId+'/runs/'+runId);
  $('logsBox').textContent = 'Claim:\\n' + log.claim + '\\n\\nVerdict:\\n' + JSON.stringify(log.verdict, null, 2) + '\\n\\nLog:\\n' + log.log;
}

async function maybeAutoStartClarify() {
  const phase = getPhase();
  if (phase === 'created') { await doClarify(); }
}

async function doClarify() {
  setBusy(true);
  try {
    const r = await post('/projects/'+selectedId+'/clarify');
    await refresh();
    if (r.question) {
      const qEl = $('clarifyQuestion'); if (qEl) qEl.textContent = 'Q: ' + r.question;
      const rEl = $('clarifyRisk'); if (rEl && r.risk) { rEl.textContent = '⚠ ' + r.risk; rEl.style.display = 'block'; }
    }
  }
  catch(e) { alert(e.message); }
  setBusy(false);
}

async function doAnswer() {
  const answer = $('answer')?.value.trim();
  if (!answer) return;
  setBusy(true);
  try { await post('/projects/'+selectedId+'/input', { answer }); await refresh(); }
  catch(e) { alert(e.message); }
  setBusy(false);
}

async function doPlan() {
  setBusy(true);
  try { await post('/projects/'+selectedId+'/plan'); await refresh(); }
  catch(e) { alert(e.message); }
  setBusy(false);
}

async function doApprove(gate) {
  setBusy(true);
  try { await post('/projects/'+selectedId+'/approve', { gate, note: 'UI approve '+gate }); await refresh(); }
  catch(e) { alert(e.message); }
  setBusy(false);
}

async function doReject(gate) {
  const note = prompt('打回原因/反馈:');
  if (!note) return;
  setBusy(true);
  try { await post('/projects/'+selectedId+'/reject', { gate, note }); await refresh(); }
  catch(e) { alert(e.message); }
  setBusy(false);
}

async function doRun() {
  setBusy(true);
  try { await post('/projects/'+selectedId+'/run'); await refresh(); }
  catch(e) { alert(e.message); }
  setBusy(false);
}

function setBusy(b) {
  busy = b;
  document.querySelectorAll('button').forEach(btn => btn.disabled = b);
}

function connectEvents() {
  if (source) source.close();
  source = new EventSource('/projects/'+selectedId+'/events');
  $('connection').textContent = 'SSE: connecting';
  source.onopen = () => $('connection').textContent = 'SSE: connected';
  source.onerror = () => $('connection').textContent = 'SSE: disconnected';
  ['snapshot','project_created','plan_composed','gate_approved','gate_rejected','run_completed','input_recorded'].forEach(type => source.addEventListener(type, () => { appendEvent(type); refresh(); }));
}
function appendEvent(type) { $('eventsBox').textContent = '['+new Date().toLocaleTimeString()+'] '+type+'\\\\n' + $('eventsBox').textContent; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

$('createBtn').onclick = async () => { const goal = $('goal').value.trim(); if (!goal) return; setBusy(true); try { const created = await post('/projects', { goal }); selectedId = created.project.id; $('goal').value=''; await loadProjects(); await selectProject(selectedId); } catch(e) { alert(e.message); } setBusy(false); };
loadProjects();
</script>
</body>
</html>`;
}
