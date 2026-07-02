const MD_RENDERER_JS = [
  "function markdownToHtml(md) {",
  "  let s = String(md).replace(/[&<>\"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]});",
  "  var lines = s.split('\\n');",
  "  var result = []; var inList = false;",
  "  for (var i=0; i<lines.length; i++) {",
  "    var line = lines[i];",
  "    if (/^###### (.+)/.test(line)) { if(inList){result.push('</ul>');inList=false;} result.push('<h6>'+line.replace(/^###### /,'')+'</h6>'); }",
  "    else if (/^##### (.+)/.test(line)) { if(inList){result.push('</ul>');inList=false;} result.push('<h5>'+line.replace(/^##### /,'')+'</h5>'); }",
  "    else if (/^#### (.+)/.test(line)) { if(inList){result.push('</ul>');inList=false;} result.push('<h4>'+line.replace(/^#### /,'')+'</h4>'); }",
  "    else if (/^### (.+)/.test(line)) { if(inList){result.push('</ul>');inList=false;} result.push('<h3>'+line.replace(/^### /,'')+'</h3>'); }",
  "    else if (/^## (.+)/.test(line)) { if(inList){result.push('</ul>');inList=false;} result.push('<h2>'+line.replace(/^## /,'')+'</h2>'); }",
  "    else if (/^# (.+)/.test(line)) { if(inList){result.push('</ul>');inList=false;} result.push('<h1>'+line.replace(/^# /,'')+'</h1>'); }",
  "    else if (/^[\\-*] (.+)/.test(line)) { if(!inList){result.push('<ul>');inList=true;} result.push('<li>'+line.replace(/^[\\-*] /,'')+'</li>'); }",
  "    else if (line.trim()==='') { if(inList){result.push('</ul>');inList=false;} result.push(''); }",
  "    else { if(inList){result.push('</ul>');inList=false;} result.push('<p style=\"margin:4px 0\">'+line+'</p>'); }",
  "  }",
  "  if(inList) result.push('</ul>');",
  "  var html = result.join('\\n');",
  "  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');",
  "  html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');",
  "  var bt = String.fromCharCode(96);",
  "  var codeRe = new RegExp(bt+'([^'+bt+']+)'+bt, 'g');",
  "  html = html.replace(codeRe, '<code style=\"background:#1e293b;padding:1px 4px;border-radius:3px;font-size:12px\">$1</code>');",
  "  return html;",
  "}",
].join("\n");

export function renderHomePage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Verana</title>
  <style>
    :root { --bg:#060d1a; --panel:#0b1222; --border:#293a57; --text:#dbeafe; --muted:#64748b; --accent:#3b82f6; --ok:#22c55e; --warn:#f59e0b; --bad:#ef4444; }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); }
    header { display:flex; justify-content:space-between; align-items:center; padding:14px 18px; background:#0a1424; border-bottom:1px solid var(--border); }
    header h1 { font-size:17px; font-weight:700; }
    main { display:grid; grid-template-columns: 300px 1fr; gap:0; height: calc(100vh - 53px); }
    .section-title { padding:12px 14px; background:#0f172a; border-bottom:1px solid var(--border); color:#fff; font-weight:700; font-size:13px; }
    .body { padding:12px; overflow-y:auto; }
    .stack { display:flex; flex-direction:column; gap:10px; }
    .row { display:flex; gap:8px; align-items:center; }
    input, textarea, button { font:inherit; border-radius:8px; border:1px solid var(--border); background:var(--panel); color:var(--text); }
    textarea { width:100%; min-height:60px; padding:9px; resize:vertical; }
    input { width:100%; padding:8px 10px; }
    button { padding:8px 14px; background:#1d4ed8; border-color:#3b82f6; cursor:pointer; font-weight:600; transition: background .15s; }
    button:hover { background:#2563eb; }
    button.secondary { background:#14213a; border-color:var(--border); }
    button.secondary:hover { background:#1a2c4a; }
    button.good { background:#166534; border-color:var(--ok); }
    button.bad { background:#7f1d1d; border-color:var(--bad); }
    button:disabled { opacity:.35; cursor:not-allowed; }
    .project { padding:10px; border:1px solid var(--border); border-radius:8px; margin-bottom:6px; background:var(--panel); cursor:pointer; transition: border-color .15s; }
    .project:hover { border-color:#3b5278; }
    .project.active { border-color:var(--accent); background:#10203a; }
    .muted { color:var(--muted); font-size:12px; }
    .pill { display:inline-flex; padding:2px 8px; border-radius:999px; background:#1e293b; border:1px solid #334155; color:#cbd5e1; font-size:11px; }
    .pill.ok { background:#052e16; border-color:var(--ok); color:var(--ok); }
    .pill.warn { background:#422006; border-color:var(--warn); color:var(--warn); }
    .pill.run { background:#0c4a6e; border-color:var(--accent); color:var(--accent); }
    .steps { display:flex; gap:0; margin-bottom:12px; overflow-x:auto; }
    .step { flex:1; min-width:80px; padding:8px 6px; text-align:center; font-size:11px; color:var(--muted); border-bottom:3px solid #26344f; }
    .step.done { color:var(--ok); border-bottom-color:var(--ok); }
    .step.active { color:var(--accent); border-bottom-color:var(--accent); font-weight:700; }
    .step-num { display:inline-block; width:18px; height:18px; line-height:18px; border-radius:50%; background:#1e293b; border:1px solid #334155; margin-right:3px; font-size:10px; }
    .step.done .step-num { background:#052e16; border-color:var(--ok); }
    .step.active .step-num { background:#0c4a6e; border-color:var(--accent); }
    .guide { padding:14px; border:1px solid #1e3a5f; border-radius:10px; background:#0c1629; margin-bottom:12px; }
    .guide-title { font-size:15px; font-weight:700; margin-bottom:6px; color:var(--accent); }
    .guide-desc { font-size:14px; color:var(--text); margin-bottom:10px; line-height:1.5; }
    .risk-box { padding:8px 10px; border-radius:6px; background:#422006; border:1px solid var(--warn); color:var(--warn); font-size:13px; margin:6px 0; }
    .qa-item { padding:8px 0; border-bottom:1px solid #1e293b; }
    .qa-q { font-weight:600; color:var(--accent); font-size:13px; }
    .qa-a { color:var(--text); font-size:14px; margin-top:2px; }
    pre { white-space:pre-wrap; word-break:break-word; background:#050b17; border:1px solid #1f2d46; border-radius:8px; padding:12px; margin:0; color:#dbeafe; font-size:13px; overflow:auto; }
    .task-card { padding:10px; border:1px solid var(--border); border-radius:8px; margin-bottom:8px; cursor:pointer; transition: border-color .15s; }
    .task-card:hover { border-color:#3b5278; }
    .task-card.selected { border-color:var(--accent); background:#10203a; }
    .task-row { display:flex; justify-content:space-between; align-items:center; }
    .task-desc { margin:6px 0; font-size:13px; }
    .task-meta { font-size:11px; color:var(--muted); }
    .exec-layout { display:grid; grid-template-columns: 280px 1fr; gap:12px; height:100%; }
    .exec-left { overflow-y:auto; }
    .exec-right { overflow-y:auto; }
    .stream-box { background:#050b17; border:1px solid #1f2d46; border-radius:8px; padding:12px; font-size:13px; white-space:pre-wrap; word-break:break-word; min-height:200px; max-height:calc(100vh - 280px); overflow:auto; }
    .stream-status { font-size:12px; color:var(--muted); margin-bottom:6px; }
  </style>
</head>
<body>
  <header><h1>Verana</h1><div class="muted" id="connection">SSE: idle</div></header>
  <main>
    <section style="border-right:1px solid var(--border); display:flex; flex-direction:column;">
      <div class="section-title">Projects</div>
      <div class="body stack" style="flex:1;">
        <textarea id="goal" placeholder="输入目标,例如: 调研海外红人监控系统" style="min-height:48px;"></textarea>
        <button id="createBtn">创建项目</button>
        <div id="projects"></div>
      </div>
    </section>
    <section style="display:flex; flex-direction:column;">
      <div id="empty" class="body muted">选择或创建一个项目。</div>
      <div id="detail" style="display:none; flex:1; overflow-y:auto; padding:14px;">
        <div class="steps" id="steps"></div>
        <div id="mainArea"></div>
        <details style="margin-top:14px;"><summary class="muted" style="cursor:pointer;padding:6px;">原始状态 JSON</summary><pre id="statusBox"></pre></details>
      </div>
    </section>
  </main>
<script>
let selectedId = null;
let state = null;
let source = null;
let busy = false;
let workflowSpec = null;
let activeRunId = null;
let selectedTaskId = null;
let streamContent = '';
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
  $('projects').innerHTML = projects.map(p => '<div class="project '+(p.id===selectedId?'active':'')+'"><div class="row" style="justify-content:space-between"><div data-id="'+escapeHtml(p.id)+'"><b>'+escapeHtml(p.id)+'</b></div><button class="bad del-btn" data-id="'+escapeHtml(p.id)+'" style="padding:2px 8px;font-size:11px">删除</button></div><div class="muted" data-id="'+escapeHtml(p.id)+'">'+escapeHtml(p.status)+'</div><div class="muted" data-id="'+escapeHtml(p.id)+'" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escapeHtml(p.goal)+'</div></div>').join('');
  document.querySelectorAll('.project [data-id]').forEach(el => el.addEventListener('click', () => selectProject(el.dataset.id)));
  document.querySelectorAll('.del-btn').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); doDelete(el.dataset.id); }));
}

async function selectProject(id) {
  selectedId = id;
  workflowSpec = null;
  selectedTaskId = null;
  streamContent = '';
  $('empty').style.display='none';
  $('detail').style.display='block';
  await refresh();
  connectEvents();
  await maybeAutoStartClarify();
}

async function refresh() {
  if (!selectedId) return;
  state = await api('/projects/'+selectedId);
  const phase = getPhase();
  if (phase && !['created','clarifying'].includes(phase) && !workflowSpec) {
    try { workflowSpec = await api('/projects/'+selectedId+'/workflow'); } catch(e) { workflowSpec = null; }
  }
  render();
  await loadProjects();
}

function getPhase() {
  if (!state) return 'created';
  const clarifier = state.status.clarifier;
  if (clarifier && !state.status.workflows.solution) return 'clarifying';
  const wf = state.status.workflows.solution;
  if (!wf) return state.project.status;
  return wf.status;
}

function render() {
  $('statusBox').textContent = JSON.stringify({ project: state.project, status: state.status }, null, 2);
  renderSteps();
  renderMain();
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

function renderMain() {
  const phase = getPhase();
  const el = $('mainArea');

  // --- Clarifying ---
  if (phase === 'created' || phase === 'clarifying') {
    const cq = state.status.clarifier?.current_question;
    const qText = cq ? cq.question : '';
    const rText = cq ? cq.risk : '';
    const entries = state.status.clarifier?.clarifications ?? [];
    el.innerHTML = '<div class="guide"><div class="guide-title">澄清目标</div>'+
      (qText ? '<div class="guide-desc">'+escapeHtml(qText)+'</div>' : '<div class="guide-desc muted">目标已足够清晰,可直接生成 Plan。</div>')+
      (rText ? '<div class="risk-box">'+escapeHtml(rText)+'</div>' : '')+
      '<input id="answer" placeholder="输入你的回答" />'+
      '<div class="row" style="margin-top:8px"><button id="answerBtn">'+(cq?'提交回答':'直接生成 Plan')+'</button><button class="secondary" id="finishClarifyBtn">跳过,直接生成 Plan</button></div></div>'+
      (entries.length ? '<div class="section-title" style="margin-top:12px">已澄清记录</div><div class="body">'+entries.map(e => '<div class="qa-item"><div class="qa-q">Q: '+escapeHtml(e.q)+'</div><div class="qa-a">A: '+escapeHtml(e.a)+'</div><div class="muted">⚠ '+escapeHtml(e.risk)+'</div></div>').join('')+'</div>' : '');
    const answerBtn = $('answerBtn'); if (answerBtn) answerBtn.onclick = () => cq ? doAnswer() : doPlan();
    const finishBtn = $('finishClarifyBtn'); if (finishBtn) finishBtn.onclick = () => doPlan();
    return;
  }

  // --- Composing ---
  if (phase === 'composing') {
    el.innerHTML = '<div class="guide"><div class="guide-title">合成 Workflow</div><div class="guide-desc">系统正在根据澄清结果合成方案 workflow...</div></div>';
    return;
  }

  // --- Plan review ---
  if (phase === 'plan_review') {
    el.innerHTML = '<div class="guide"><div class="guide-title">审核任务拆解</div><div class="guide-desc">系统已生成方案 workflow,包含任务 DAG。请审核以下任务拆解,确认合理后通过。</div><div class="row"><button class="good" id="approvePlanBtn">通过,开始执行</button><button class="bad" id="showRejectPlanBtn">打回重做</button></div><div id="rejectPlanPanel" style="display:none;margin-top:8px"><textarea id="rejectPlanNote" placeholder="具体打回要求:哪些 task 拆得不对、缺什么、要怎么调整"></textarea><button class="bad" id="rejectPlanBtn" style="margin-top:6px">确认打回</button></div></div>'+
      '<div id="taskCards"></div>';
    $('approvePlanBtn').onclick = () => doApprove('plan_review');
    $('showRejectPlanBtn').onclick = () => { $('rejectPlanPanel').style.display='block'; $('rejectPlanNote').focus(); };
    $('rejectPlanBtn').onclick = () => doReject('plan_review');
    renderTaskCards('taskCards', false);
    return;
  }

  // --- Executing ---
  if (phase === 'executing') {
    const tasks = state.status.workflows.solution?.tasks || {};
    const taskList = workflowSpec?.tasks || Object.values(tasks);
    // Find active/running task
    const runningTask = Object.values(tasks).find(t => t.status === 'running' || t.status === 'verifying');
    if (runningTask && !selectedTaskId) selectedTaskId = runningTask.id;

    el.innerHTML = '<div class="guide"><div class="guide-title">执行中</div><div class="guide-desc">系统正在按 DAG 逐个执行 task,每个 task 完成后独立验证。右侧实时显示当前 task 的 LLM 输出。</div><div class="row"><button class="secondary" id="runContinueBtn">继续执行</button></div></div>'+
      '<div class="exec-layout"><div class="exec-left" id="execTaskList"></div><div class="exec-right" id="execStreamArea"></div></div>';
    $('runContinueBtn').onclick = () => doRun();
    renderExecTaskList('execTaskList');
    renderExecStream('execStreamArea');
    return;
  }

  // --- Final review ---
  if (phase === 'final_review') {
    el.innerHTML = '<div class="guide"><div class="guide-title">审核最终方案</div><div class="guide-desc">所有 task 已完成并通过验证。下方是交付物,请审核后确认闭环。</div><div class="row"><button class="good" id="approveFinalBtn">通过,方案闭环</button><button class="bad" id="showRejectFinalBtn">打回重做</button></div><div id="rejectFinalPanel" style="display:none;margin-top:8px"><textarea id="rejectFinalNote" placeholder="具体打回要求:哪里不对、要怎么改、期望什么结果"></textarea><button class="bad" id="rejectFinalBtn" style="margin-top:6px">确认打回</button></div></div><div id="deliverablesBox">正在加载交付物...</div>';
    $('approveFinalBtn').onclick = () => doApprove('final_review');
    $('showRejectFinalBtn').onclick = () => { $('rejectFinalPanel').style.display='block'; $('rejectFinalNote').focus(); };
    $('rejectFinalBtn').onclick = () => doReject('final_review');
    loadDeliverables();
    return;
  }

  // --- Approved ---
  if (phase === 'approved') {
    el.innerHTML = '<div class="guide"><div class="guide-title" style="color:var(--ok)">方案闭环完成</div><div class="guide-desc">方案阶段已结束。最终交付物如下:</div></div><div id="deliverablesBox">正在加载交付物...</div>';
    loadDeliverables();
    return;
  }

  // --- Blocked / Failed ---
  if (phase === 'blocked' || phase === 'failed') {
    el.innerHTML = '<div class="guide"><div class="guide-title" style="color:var(--bad)">状态: '+escapeHtml(phase)+'</div><div class="guide-desc">'+escapeHtml(state.status.blocked_reason || '遇到问题。')+'</div><button class="secondary" id="retryBtn">重试</button></div>';
    $('retryBtn').onclick = () => doRun();
    return;
  }

  el.innerHTML = '<div class="guide"><div class="guide-desc muted">未知状态: '+escapeHtml(String(phase))+'</div></div>';
}

function renderTaskCards(containerId, canRerun) {
  const el = $(containerId);
  if (!el) return;
  const tasks = state.status.workflows.solution?.tasks || {};
  if (!workflowSpec?.tasks?.length) { el.innerHTML = '<div class="muted">暂无 task。</div>'; return; }
  el.innerHTML = workflowSpec.tasks.map(task => {
    const rt = tasks[task.id];
    const status = rt?.status || 'pending';
    const cls = status === 'delivered' ? 'ok' : (status === 'failed' ? 'warn' : (status === 'running' ? 'run' : ''));
    const outputs = (task.outputs||[]).map(o => '<div class="task-meta">产出: '+escapeHtml(o.path)+' — '+escapeHtml(o.desc)+'</div>').join('');
    const checks = (task.checks||[]).map(c => '<div class="task-meta">验收: ['+escapeHtml(c.method)+'] '+escapeHtml(c.desc)+'</div>').join('');
    const deps = (task.depends_on||[]).length ? '<div class="task-meta">依赖: '+escapeHtml((task.depends_on||[]).join(', '))+'</div>' : '';
    return '<div class="task-card"><div class="task-row"><b>'+escapeHtml(task.id)+' — '+escapeHtml(task.agent)+'</b><span class="pill '+cls+'">'+escapeHtml(status)+'</span></div><div class="task-desc">'+escapeHtml(task.desc)+'</div>'+outputs+checks+deps+'</div>';
  }).join('');
}

function renderExecTaskList(containerId) {
  const el = $(containerId);
  if (!el) return;
  const tasks = state.status.workflows.solution?.tasks || {};
  const specTasks = workflowSpec?.tasks || Object.values(tasks);
  if (!specTasks.length) { el.innerHTML = '<div class="muted">暂无 task。</div>'; return; }
  el.innerHTML = specTasks.map(task => {
    const rt = tasks[task.id] || { status: 'pending' };
    const status = rt.status;
    const cls = status === 'delivered' ? 'ok' : (status === 'failed' ? 'warn' : (status === 'running' || status === 'verifying' ? 'run' : ''));
    const selected = task.id === selectedTaskId ? 'selected' : '';
    const runs = (rt.runs || []).map(r => '<button class="secondary run-log" data-run="'+escapeHtml(r)+'" data-task="'+escapeHtml(task.id)+'" style="padding:1px 6px;font-size:10px;margin:1px">'+escapeHtml(r)+'</button>').join(' ');
    const rerunBtn = status !== 'running' ? '<button class="secondary rerun-btn" data-task="'+escapeHtml(task.id)+'" style="padding:2px 8px;font-size:11px;margin-top:4px">重跑</button>' : '';
    return '<div class="task-card '+selected+'" data-task="'+escapeHtml(task.id)+'"><div class="task-row"><b>'+escapeHtml(task.id)+'</b><span class="pill '+cls+'">'+escapeHtml(status)+'</span></div>'+(runs?'<div style="margin-top:3px">'+runs+'</div>':'')+rerunBtn+'</div>';
  }).join('');
  // Bind click to select task
  el.querySelectorAll('.task-card[data-task]').forEach(card => card.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    selectedTaskId = card.dataset.task;
    streamContent = '';
    renderExecTaskList(containerId);
    renderExecStream('execStreamArea');
  }));
  el.querySelectorAll('.run-log').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); selectedTaskId = btn.dataset.task; streamContent=''; loadRunLog(btn.dataset.run); }));
  el.querySelectorAll('.rerun-btn').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); doRerun(btn.dataset.task); }));
}

function renderExecStream(containerId) {
  const el = $(containerId);
  if (!el) return;
  const tasks = state.status.workflows.solution?.tasks || {};
  const task = selectedTaskId ? tasks[selectedTaskId] : null;
  const taskSpec = workflowSpec?.tasks?.find(t => t.id === selectedTaskId);
  let title = selectedTaskId ? selectedTaskId : '未选择 task';
  if (taskSpec) title += ' — ' + taskSpec.agent;
  let statusText = task ? task.status : 'pending';
  // Find latest run for this task
  const runs = task?.runs || [];
  const latestRun = runs.length ? runs[runs.length - 1] : null;
  if (latestRun && !activeRunId) activeRunId = latestRun;

  el.innerHTML = '<div class="stream-status">Task: '+escapeHtml(title)+' | 状态: '+escapeHtml(statusText)+(latestRun?' | Run: '+escapeHtml(latestRun):'')+'</div><div class="stream-box" id="streamBox">'+(streamContent ? markdownToHtml(streamContent) : escapeHtml(latestRun ? '点击 task 查看输出,或等待 LLM 实时输出...' : '暂无 run 记录。'))+'</div>';
}

async function loadRunLog(runId) {
  try {
    const log = await api('/projects/'+selectedId+'/runs/'+runId);
    const parts = [];
    if (log.stream) parts.push(log.stream);
    else if (log.claim) parts.push('=== Claim ===' + String.fromCharCode(10) + log.claim);
    if (log.verdict) parts.push('=== Verdict ===' + String.fromCharCode(10) + JSON.stringify(log.verdict, null, 2));
    streamContent = parts.join(String.fromCharCode(10) + String.fromCharCode(10));
    renderExecStream('execStreamArea');
  } catch(e) { streamContent = '加载失败: ' + e.message; renderExecStream('execStreamArea'); }
}

async function loadActiveStream() {
  if (!activeRunId) {
    const tasks = state?.status?.workflows?.solution?.tasks || {};
    const allRuns = Object.values(tasks).flatMap(t => t.runs || []);
    if (allRuns.length) activeRunId = allRuns[allRuns.length - 1];
  }
  if (!activeRunId) { streamContent = '暂无正在执行的 run。'; renderExecStream('execStreamArea'); return; }
  const res = await fetch('/projects/'+selectedId+'/runs/'+activeRunId+'/stream');
  streamContent = await res.text();
  renderExecStream('execStreamArea');
}

async function loadDeliverables() {
  const el = $('deliverablesBox');
  if (!el) return;
  try {
    const files = await api('/projects/'+selectedId+'/deliverables');
    if (!files.length) { el.innerHTML = '<div class="muted">暂无交付物。</div>'; return; }
    el.innerHTML = files.map(f => '<div style="margin-bottom:12px"><div class="qa-q">'+escapeHtml(f.path)+'</div><div class="md-content" style="background:#050b17;border:1px solid #1f2d46;border-radius:8px;padding:12px;max-height:400px;overflow:auto">'+markdownToHtml(f.content)+'</div></div>').join('');
  } catch(e) { el.innerHTML = '<div class="muted">加载失败: '+escapeHtml(e.message)+'</div>'; }
}

async function maybeAutoStartClarify() {
  const phase = getPhase();
  if (phase === 'created' && !state.status.clarifier?.current_question) { await doClarify(); }
}

async function doClarify() {
  setBusy(true);
  try { await post('/projects/'+selectedId+'/clarify'); await refresh(); }
  catch(e) { alert(e.message); }
  setBusy(false);
}

async function doAnswer() {
  const answer = $('answer')?.value.trim();
  if (!answer) return;
  setBusy(true);
  try {
    const r = await post('/projects/'+selectedId+'/input', { answer });
    state = r.state;
    render();
    await loadProjects();
    if (r.next_question) {
      const qEl = $('answer'); if (qEl) qEl.value = '';
    }
  } catch(e) { alert(e.message); }
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
  const noteEl = gate === 'plan_review' ? $('rejectPlanNote') : $('rejectFinalNote');
  const note = noteEl?.value.trim();
  if (!note) { alert('请填写具体打回要求'); return; }
  setBusy(true);
  try { await post('/projects/'+selectedId+'/reject', { gate, note }); await refresh(); }
  catch(e) { alert(e.message); }
  setBusy(false);
}

async function doRun() {
  setBusy(true);
  try {
    await post('/projects/'+selectedId+'/run');
    setBusy(false);
    await refresh();
  } catch(e) { alert(e.message); setBusy(false); }
}

async function doRerun(taskId) {
  setBusy(true);
  try {
    selectedTaskId = taskId;
    streamContent = '';
    await post('/projects/'+selectedId+'/rerun/'+taskId);
    setBusy(false);
    await refresh();
  } catch(e) { alert(e.message); setBusy(false); }
}

async function doDelete(projectId) {
  if (!confirm('确定删除项目 '+projectId+' ?此操作不可撤销。')) return;
  try {
    const res = await fetch('/projects/'+projectId, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    if (selectedId === projectId) { selectedId = null; state = null; workflowSpec = null; $('detail').style.display = 'none'; $('empty').style.display = 'block'; }
    await loadProjects();
  } catch(e) { alert(e.message); }
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
  ['snapshot','project_created','plan_composed','gate_approved','gate_rejected','run_completed','run_failed','input_recorded','task_updated','status_changed'].forEach(type => source.addEventListener(type, () => { refresh(); }));
  source.addEventListener('llm_stream', (event) => {
    const data = JSON.parse(event.data);
    const payload = data.payload || {};
    if (payload.runId) activeRunId = payload.runId;
    if (payload.taskId) selectedTaskId = payload.taskId;
    // Auto-load stream on first event or when content arrives
    if (payload.content) {
      streamContent = payload.content;
    } else if (payload.message) {
      streamContent = payload.message;
    }
    // Update stream box if in executing phase
    const box = $('streamBox');
    if (box) {
      box.innerHTML = streamContent ? markdownToHtml(streamContent) : escapeHtml('等待 LLM 响应...');
    }
    // Also refresh task list to show status changes
    const phase = getPhase();
    if (phase === 'executing') {
      renderExecTaskList('execTaskList');
      renderExecStream('execStreamArea');
    }
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

${MD_RENDERER_JS}

$('createBtn').onclick = async () => { const goal = $('goal').value.trim(); if (!goal) return; setBusy(true); try { const created = await post('/projects', { goal }); selectedId = created.project.id; $('goal').value=''; await loadProjects(); await selectProject(selectedId); } catch(e) { alert(e.message); } setBusy(false); };
loadProjects();
</script>
</body>
</html>`;
}
