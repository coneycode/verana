const MD_RENDERER_JS = [
  "function markdownToHtml(md) {",
  "  var s = String(md).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');",
  "  var BT = String.fromCharCode(96);",
  "  // Code blocks (triple backtick)",
  "  var blocks = [];",
  "  var codeRe = new RegExp(BT+BT+BT+'(\\\\w*)\\\\n?([\\\\s\\\\S]*?)'+BT+BT+BT, 'g');",
  "  s = s.replace(codeRe, function(m, lang, code) {",
  "    blocks.push('<pre style=\"background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px;overflow:auto;font-size:12px\">'+code.trim()+'</pre>');",
  "    return '\\u0000CODEBLOCK'+(blocks.length-1)+'\\u0000';",
  "  });",
  "  // Tables: consecutive lines starting with |",
  "  s = s.replace(/(^[\\|].+\\|\\n?)+/gm, function(block) {",
  "    var lines = block.trim().split('\\n').filter(function(l){return l.trim();});",
  "    if (lines.length < 2) return block;",
  "    var rows = lines.map(function(l){return l.split('|').filter(function(c){return c.trim()!=='';}).map(function(c){return c.trim();});});",
  "    var isSep = rows.length > 1 && rows[1].every(function(c){return /^[-:]+$/.test(c);});",
  "    var html = '<table style=\"width:100%;border-collapse:collapse;font-size:13px;margin:8px 0\">';",
  "    if (isSep) {",
  "      html += '<tr>' + rows[0].map(function(c){return '<th style=\"border:1px solid #30363d;padding:6px 8px;text-align:left;background:#161b22\">'+c+'</th>';}).join('') + '</tr>';",
  "      for (var i=2; i<rows.length; i++) { html += '<tr>' + rows[i].map(function(c){return '<td style=\"border:1px solid #30363d;padding:6px 8px\">'+c+'</td>';}).join('') + '</tr>'; }",
  "    } else {",
  "      for (var r=0; r<rows.length; r++) { html += '<tr>' + rows[r].map(function(c,idx){return '<td style=\"border:1px solid #30363d;padding:6px 8px;'+(idx===0?'font-weight:600':'')+'\">'+c+'</td>';}).join('') + '</tr>'; }",
  "    }",
  "    return html + '</table>';",
  "  });",
  "  // Split into lines for block-level processing",
  "  var lines = s.split('\\n');",
  "  var result = []; var inUl = false; var inOl = false; var inBq = false;",
  "  function closeLists() { if(inUl){result.push('</ul>');inUl=false;} if(inOl){result.push('</ol>');inOl=false;} }",
  "  function closeBq() { if(inBq){result.push('</blockquote>');inBq=false;} }",
  "  for (var i=0; i<lines.length; i++) {",
  "    var line = lines[i];",
  "    // Headings",
  "    if (/^###### (.+)/.test(line)) { closeLists(); closeBq(); result.push('<h6>'+line.replace(/^###### /,'')+'</h6>'); }",
  "    else if (/^##### (.+)/.test(line)) { closeLists(); closeBq(); result.push('<h5>'+line.replace(/^##### /,'')+'</h5>'); }",
  "    else if (/^#### (.+)/.test(line)) { closeLists(); closeBq(); result.push('<h4>'+line.replace(/^#### /,'')+'</h4>'); }",
  "    else if (/^### (.+)/.test(line)) { closeLists(); closeBq(); result.push('<h3>'+line.replace(/^### /,'')+'</h3>'); }",
  "    else if (/^## (.+)/.test(line)) { closeLists(); closeBq(); result.push('<h2>'+line.replace(/^## /,'')+'</h2>'); }",
  "    else if (/^# (.+)/.test(line)) { closeLists(); closeBq(); result.push('<h1>'+line.replace(/^# /,'')+'</h1>'); }",
  "    // Horizontal rule",
  "    else if (/^---+$/.test(line.trim())) { closeLists(); closeBq(); result.push('<hr style=\"border:none;border-top:1px solid #30363d;margin:10px 0\"/>'); }",
  "    // Blockquote (escaped > becomes &gt;)",
  "    else if (/^[&]gt; (.+)/.test(line)) { closeLists(); if(!inBq){result.push('<blockquote style=\"border-left:3px solid #3b82f6;padding-left:12px;margin:8px 0;color:#94a3b8\">');inBq=true;} result.push('<p style=\"margin:2px 0\">'+line.replace(/^[&]gt; /,'')+'</p>'); }",
  "    // Unordered list",
  "    else if (/^[\\-*] (.+)/.test(line)) { closeBq(); if(inOl){result.push('</ol>');inOl=false;} if(!inUl){result.push('<ul>');inUl=true;} result.push('<li>'+line.replace(/^[\\-*] /,'')+'</li>'); }",
  "    // Ordered list",
  "    else if (/^\\d+\\. (.+)/.test(line)) { closeBq(); if(inUl){result.push('</ul>');inUl=false;} if(!inOl){result.push('<ol>');inOl=true;} result.push('<li>'+line.replace(/^\\d+\\. /,'')+'</li>'); }",
  "    // Empty line",
  "    else if (line.trim()==='') { closeLists(); closeBq(); result.push(''); }",
  "    // Already-processed HTML (code block placeholder, table, hr)",
  "    else if (/^\\u0000CODEBLOCK/.test(line) || /^<table/.test(line) || /^<hr/.test(line)) { closeLists(); closeBq(); result.push(line); }",
  "    // Normal paragraph",
  "    else { closeLists(); closeBq(); result.push('<p style=\"margin:4px 0\">'+line+'</p>'); }",
  "  }",
  "  closeLists(); closeBq();",
  "  var html = result.join('\\n');",
  "  // Inline formatting: bold, italic, inline code",
  "  html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');",
  "  html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');",
  "  var inlineCodeRe = new RegExp(BT+'([^'+BT+']+)'+BT, 'g');",
  "  html = html.replace(inlineCodeRe, '<code style=\"background:#1e293b;padding:1px 4px;border-radius:3px;font-size:12px\">$1</code>');",
  "  // Restore code blocks",
  "  html = html.replace(/\\u0000CODEBLOCK(\\d+)\\u0000/g, function(m, idx) { return blocks[parseInt(idx)]; });",
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
    .live-feed { background:#050b17; border:1px solid #1f2d46; border-radius:8px; padding:10px; font-size:13px; min-height:200px; max-height:calc(100vh - 280px); overflow:auto; font-family: ui-monospace,"SF Mono",Menlo,monospace; }
    .live-feed .step-line { color:#93c5fd; padding:3px 0; border-bottom:1px solid #0d1626; }
    .live-feed .llm-line { color:#dbeafe; padding:0; white-space:pre-wrap; word-break:break-word; }
    .live-feed .meta-line { color:var(--muted); padding:2px 0; }
    .live-feed .feed-ts { color:#475569; font-size:11px; margin-right:6px; }
    .mermaid { background:#0a1428; border-radius:8px; padding:12px; }
    .mermaid .node.passed { fill:#142a1a !important; stroke:#22c55e !important; }
    .mermaid .node.failed { fill:#2a1414 !important; stroke:#ef4444 !important; }
    .mermaid .node.running { fill:#1a1f2e !important; stroke:#f59e0b !important; stroke-width:2px !important; }
    .mermaid .node.entry { stroke:#3b82f6 !important; stroke-width:2px !important; }
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
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
let selectedId = null;
let state = null;
let source = null;
let busy = false;
let workflowSpec = null;
let activeRunId = null;

// Mermaid 初始化
if (typeof mermaid !== 'undefined') { mermaid.initialize({ startOnLoad: false, theme: 'dark', flowchart: { curve: 'basis' } }); }

// 生成能力关系图(只画节点,不推测边)
function buildCapabilityGraph(spec) {
  if (!spec || !spec.capabilities) return '';
  const caps = spec.capabilities;
  let lines = ['flowchart TD'];
  lines.push('  classDef agent fill:#1a2744,stroke:#3b82f6,color:#93c5fd');
  lines.push('  classDef light fill:#1a2a1a,stroke:#22c55e,color:#86efac');
  lines.push('  classDef entry fill:#1a1f2e,stroke:#f59e0b,color:#fcd34d,stroke-width:2px');
  for (const c of caps) {
    const desc = c.desc.slice(0, 40);
    const shape = c.kind === 'agent' ? '["' + desc + '"]' : '(("' + desc + '"))';
    lines.push('  ' + c.id + shape);
    lines.push('  class ' + c.id + ' ' + (c.kind === 'agent' ? 'agent' : 'light'));
  }
  if (spec.entry_node) lines.push('  class ' + spec.entry_node + ' entry');
  return lines.join('\\n');
}

// 渲染 Mermaid 图到容器
async function renderMermaidGraph(containerId, graphDef) {
  const el = $(containerId);
  if (!el || !graphDef) { if (el) el.innerHTML = '<div class="muted">无图数据</div>'; return; }
  try {
    const { svg } = await mermaid.render('g' + containerId, graphDef);
    el.innerHTML = svg;
  } catch(e) {
    el.innerHTML = '<div class="muted">图渲染失败: ' + escapeHtml(e.message) + '</div><pre>' + escapeHtml(graphDef) + '</pre>';
  }
}

// 生成执行轨迹图(只画已执行和正在执行的节点,不画没跑的,不推测边)
function buildExecutionGraph(spec, wf) {
  if (!spec || !spec.capabilities) return '';
  const caps = spec.capabilities;
  const runs = wf?.runs ?? {};
  const retries = wf?.node_retries ?? {};
  const curNode = wf?.current_node;
  // 从事件日志的实际执行顺序推断边:如果 A 执行完后 B 接着执行,A→B 画一条边
  // 但我们这里没有事件日志的顺序信息(只有 runs),所以只画节点不画边
  let lines = ['flowchart TD'];
  lines.push('  classDef passed fill:#142a1a,stroke:#22c55e,color:#86efac');
  lines.push('  classDef failed fill:#2a1414,stroke:#ef4444,color:#fca5a5');
  lines.push('  classDef running fill:#1a1f2e,stroke:#f59e0b,color:#fcd34d,stroke-width:3px');
  for (const c of caps) {
    const nodeRuns = runs[c.id] ?? [];
    const runCount = nodeRuns.length;
    const failCount = retries[c.id] ?? 0;
    const isRunning = curNode === c.id && wf?.awaiting === 'none_midstep';
    // 只画已经执行过或正在执行的节点
    if (runCount === 0 && !isRunning) continue;
    let label = c.desc.slice(0, 35);
    if (runCount > 0) label += '\\n✓' + runCount + '次';
    if (failCount > 0) label += ' \\n✗' + failCount + '次失败';
    if (isRunning) label += '\\n⟳ 执行中';
    lines.push('  ' + c.id + '["' + label + '"]');
    if (isRunning) lines.push('  class ' + c.id + ' running');
    else if (failCount > 0 && runCount === 0) lines.push('  class ' + c.id + ' failed');
    else lines.push('  class ' + c.id + ' passed');
  }
  return lines.join('\\n');
}
let selectedTaskId = null;
let streamContent = '';
let liveFeed = [];
let currentStreamRunId = null;

// 时间线 blocks:每条 = 一个节点执行 {nodeId, desc, runId, status, reason, llmOutput, verdict, diagnosis, ts}
let timelineBlocks = [];

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
  if (id) location.hash = id; else history.replaceState(null, '', '#');
  workflowSpec = null;
  selectedTaskId = null;
  streamContent = '';
  liveFeed = [];
  timelineBlocks = [];
  currentStreamRunId = null;
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
  return wf.workflow_status;
}

function render() {
  $('statusBox').textContent = JSON.stringify({ project: state.project, status: state.status }, null, 2);
  renderSteps();
  const phase = getPhase();
  // executing 阶段 preserve(不重绘整个 mainArea,保留时间线)
  const preserve = phase === 'executing' && $('timelineBox');
  if (!preserve) {
    renderMain();
  }
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
      (rText ? '<div class="risk-box">'+escapeHtml(stripDim(rText))+'</div>' : '')+
      '<input id="answer" placeholder="输入你的回答" />'+
      '<div class="row" style="margin-top:8px"><button id="answerBtn">'+(cq?'提交回答':'直接生成 Plan')+'</button><button class="secondary" id="finishClarifyBtn">跳过,直接生成 Plan</button></div></div>'+
      (entries.length ? '<div class="section-title" style="margin-top:12px">已澄清记录</div><div class="body">'+entries.map(e => '<div class="qa-item"><div class="qa-q">Q: '+escapeHtml(e.q)+'</div><div class="qa-a">A: '+escapeHtml(e.a)+'</div><div class="muted">⚠ '+escapeHtml(stripDim(e.risk))+'</div></div>').join('')+'</div>' : '');
    const answerBtn = $('answerBtn'); if (answerBtn) answerBtn.onclick = () => cq ? doAnswer() : doPlan();
    const finishBtn = $('finishClarifyBtn'); if (finishBtn) finishBtn.onclick = () => doPlan();
    return;
  }

  // --- Composing ---
  if (phase === 'composing') {
    el.innerHTML = '<div class="guide"><div class="guide-title">合成 Workflow</div><div class="guide-desc">系统正在根据澄清结果合成方案 workflow...</div></div>';
    return;
  }

  // --- Plan review (图模型:展示能力清单+护栏+blackboard schema) ---
  if (phase === 'plan_review') {
    el.innerHTML = '<div class="guide"><div class="guide-title">审核能力与护栏</div><div class="guide-desc">系统已规划图工作流。预定义的是能力清单(节点)+护栏+记忆结构,执行路径由调度大脑运行时动态决定。可编辑 spec 后通过。</div><div class="row"><button class="good" id="approvePlanBtn">通过,开始执行</button><button class="secondary" id="editSpecBtn">编辑 Spec</button><button class="bad" id="showRejectPlanBtn">打回重规划</button></div><div id="rejectPlanPanel" style="display:none;margin-top:8px"><textarea id="rejectPlanNote" placeholder="具体打回要求:哪些能力缺失/多余、护栏不合理、记忆结构有问题"></textarea><button class="bad" id="rejectPlanBtn" style="margin-top:6px">确认打回</button></div><div id="specEditPanel" style="display:none;margin-top:8px"><div class="muted" style="margin-bottom:4px">编辑 spec(JSON 格式,保存前会校验):</div><textarea id="specEditArea" style="min-height:300px;font-family:monospace;font-size:12px"></textarea><div class="row" style="margin-top:6px"><button class="good" id="saveSpecBtn">保存</button><button class="bad" id="cancelSpecBtn">取消</button></div></div></div>'+
      '<div id="planOverview"></div><div id="capGraph" style="margin-top:12px"></div>';
    $('approvePlanBtn').onclick = () => doApprove('plan_review');
    $('showRejectPlanBtn').onclick = () => { $('rejectPlanPanel').style.display='block'; $('rejectPlanNote').focus(); };
    $('rejectPlanBtn').onclick = () => doReject('plan_review');
    $('editSpecBtn').onclick = () => loadSpecForEdit();
    $('saveSpecBtn').onclick = () => doSaveSpec();
    $('cancelSpecBtn').onclick = () => { $('specEditPanel').style.display='none'; };
    renderPlanOverview('planOverview');
    // 能力关系图
    const graphDef = buildCapabilityGraph(workflowSpec);
    renderMermaidGraph('capGraph', graphDef);
    return;
  }

  // --- Executing (单列时间线 + 侧边blackboard) ---
  if (phase === 'executing') {
    const wf = state.status.workflows.solution;
    const iter = wf?.iteration ?? 0;
    el.innerHTML =
      '<div class="guide"><div class="guide-title">执行中</div><div class="guide-desc">轮次: '+iter+'</div></div>'+
      '<details style="margin-bottom:12px"><summary class="muted" style="cursor:pointer">规划概览</summary><div id="planOverview2" style="margin-top:8px"></div></details>'+
      '<div id="timelineBox"></div>'+
      '<div id="blackboardPanel" style="margin-top:12px"></div>';
    renderTimelineBlocks('timelineBox');
    renderPlanOverview('planOverview2');
    renderBlackboard('blackboardPanel');
    return;
  }

  // --- Awaiting human (图模型:四场景人审卡) ---
  if (phase === 'awaiting_human') {
    const wf = state.status.workflows.solution;
    const scene = wf?.awaiting_scene ?? 'checkpoint';
    const reason = wf?.awaiting_reason ?? '需要人审';
    const sceneLabels = { failure: '失败/异常', guardrail: '碰护栏', capability_gap: '能力缺口', checkpoint: '阶段检查点', anomaly: '状态异常' };
    el.innerHTML = '<div class="guide"><div class="guide-title" style="color:var(--warn)">需要人审: '+escapeHtml(sceneLabels[scene] || scene)+'</div><div class="guide-desc">'+escapeHtml(reason)+'</div>'+
      '<div class="row"><button class="good" id="humanContinueBtn">继续执行</button><button class="secondary" id="humanRetryBtn">重试 '+escapeHtml(wf?.current_node||'')+'</button><button class="bad" id="humanAbortBtn">放弃</button></div>'+
      '<div style="margin-top:10px"><div class="muted" style="margin-bottom:4px">给调度大脑的方向指令(可选,持续影响后续调度):</div><textarea id="humanDirection" placeholder="例如:产出要纯净正文不要混入汇报文字,或者:第3章节奏太慢要加快"></textarea></div>'+
      '<div style="margin-top:8px"><div class="muted" style="margin-bottom:4px">手动编辑 blackboard(可选,JSON 格式):</div><textarea id="humanBbEdit" placeholder="例如: {&quot;summary&quot;:&quot;修改后的摘要&quot;}" style="min-height:50px"></textarea></div>'+
      '</div><div id="lastRunPanel" style="margin-top:12px"></div><div id="blackboardPanel" style="margin-top:12px"></div>';
    $('humanContinueBtn').onclick = () => doHumanVerdict('continue');
    $('humanRetryBtn').onclick = () => doHumanVerdict('retry');
    $('humanAbortBtn').onclick = () => doHumanVerdict('abort');
    renderBlackboard('blackboardPanel');
    loadLastRunForHuman('lastRunPanel', wf?.current_node);
    return;
  }

  // --- Final review ---
  if (phase === 'final_review') {
    el.innerHTML = '<div class="guide"><div class="guide-title">审核最终方案</div><div class="guide-desc">所有 task 已完成并通过验证。下方是交付物,请审核后确认闭环。</div><div class="row"><button class="good" id="approveFinalBtn">通过,方案闭环</button><button class="bad" id="showRejectFinalBtn">打回重做</button><button class="secondary" id="exportMdBtn">导出 Markdown</button></div><div id="rejectFinalPanel" style="display:none;margin-top:8px"><textarea id="rejectFinalNote" placeholder="具体打回要求:哪里不对、要怎么改、期望什么结果"></textarea><button class="bad" id="rejectFinalBtn" style="margin-top:6px">确认打回</button></div></div><div id="deliverablesBox">正在加载交付物...</div>';
    $('approveFinalBtn').onclick = () => doApprove('final_review');
    $('showRejectFinalBtn').onclick = () => { $('rejectFinalPanel').style.display='block'; $('rejectFinalNote').focus(); };
    $('rejectFinalBtn').onclick = () => doReject('final_review');
    const exportBtn = $('exportMdBtn'); if (exportBtn) exportBtn.onclick = () => doExportMd();
    loadDeliverables();
    return;
  }

  // --- Approved ---
  if (phase === 'approved') {
    el.innerHTML = '<div class="guide"><div class="guide-title" style="color:var(--ok)">方案闭环完成</div><div class="guide-desc">方案阶段已结束。最终交付物如下:</div><div class="row"><button class="secondary" id="exportMdBtn">导出 Markdown</button></div></div><div id="deliverablesBox">正在加载交付物...</div>';
    const exportBtn2 = $('exportMdBtn'); if (exportBtn2) exportBtn2.onclick = () => doExportMd();
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

function renderPlanOverview(containerId) {
  const el = $(containerId);
  if (!el) return;
  const spec = workflowSpec;
  if (!spec || !spec.capabilities) { el.innerHTML = '<div class="muted">暂无 workflow 规划。</div>'; return; }
  let html = '<div class="section-title">能力清单 ('+spec.capabilities.length+' 个节点)</div><div class="body">';
  for (const cap of spec.capabilities) {
    const kindCls = cap.kind === 'agent' ? 'run' : 'ok';
    const outputs = (cap.outputs||[]).map(o => '<div class="task-meta">产出: '+escapeHtml(o.path)+' — '+escapeHtml(o.desc)+'</div>').join('');
    const checks = (cap.checks||[]).map(c => '<div class="task-meta">验收: ['+escapeHtml(c.method)+'] '+escapeHtml(c.desc)+'</div>').join('');
    const updates = cap.updates?.length ? '<div class="task-meta">更新记忆: '+escapeHtml(cap.updates.join(', '))+'</div>' : '';
    html += '<div class="task-card"><div class="task-row"><b>'+escapeHtml(cap.id)+'</b><span class="pill '+kindCls+'">'+escapeHtml(cap.kind)+'</span></div><div class="task-desc">'+escapeHtml(cap.desc)+'</div>'+outputs+checks+updates+'</div>';
  }
  html += '</div>';
  // 护栏
  html += '<div class="section-title" style="margin-top:12px">护栏</div><div class="body">';
  html += '<div class="task-meta">硬上限: max_iterations='+escapeHtml(String(spec.guardrails?.hard?.max_iterations ?? '-'))+(spec.guardrails?.hard?.max_retries_per_node? ' / max_retries='+escapeHtml(String(spec.guardrails.hard.max_retries_per_node)):'')+'</div>';
  if (spec.guardrails?.soft?.length) {
    for (const s of spec.guardrails.soft) html += '<div class="task-meta">软红线: '+escapeHtml(s.id)+' — '+escapeHtml(s.desc)+' ['+escapeHtml(s.action)+']</div>';
  }
  if (spec.guardrails?.human_checkpoint_every) html += '<div class="task-meta">阶段人审: 每 '+escapeHtml(String(spec.guardrails.human_checkpoint_every))+' 轮</div>';
  html += '</div>';
  // blackboard schema
  html += '<div class="section-title" style="margin-top:12px">Blackboard 记忆结构</div><div class="body">';
  for (const f of spec.blackboard_schema?.fields ?? []) {
    html += '<div class="task-meta">'+escapeHtml(f.key)+(f.bounded?' (有界,需压缩)':'')+' — '+escapeHtml(f.desc)+'</div>';
  }
  html += '</div>';
  // 完成标准
  html += '<div class="section-title" style="margin-top:12px">完成标准</div><div class="body">';
  for (const c of spec.completion_criteria ?? []) html += '<div class="task-meta">- '+escapeHtml(c)+'</div>';
  html += '</div>';
  el.innerHTML = html;
}

/** 时间线:单列 blocks,每块=一个节点执行 */
function renderTimelineBlocks(containerId) {
  const el = $(containerId);
  if (!el) return;
  if (timelineBlocks.length === 0) {
    el.innerHTML = '<div class="muted" style="padding:12px">等待开始...</div>';
    return;
  }
  let html = '';
  for (let i = 0; i < timelineBlocks.length; i++) {
    const b = timelineBlocks[i];
    const isRunning = b.status === 'running';
    const isFailed = b.status === 'failed';
    const isPassed = b.status === 'passed';
    const borderColor = isRunning ? '#f59e0b' : isFailed ? '#ef4444' : isPassed ? '#22c55e' : '#475569';
    const statusIcon = isRunning ? '⟳' : isFailed ? '✗' : isPassed ? '✓' : '○';
    const statusText = isRunning ? '执行中' : isFailed ? '失败' : isPassed ? '通过' : '等待';
    // 正在执行和失败的块默认展开,通过的默认折叠
    const expanded = isRunning || isFailed || b._expanded;

    html += '<div class="tl-block" style="border:1px solid '+borderColor+';border-radius:8px;margin-bottom:8px;padding:0;overflow:hidden">';
    // 头部
    html += '<div class="tl-head" style="padding:10px 12px;cursor:pointer;background:#0d1626" onclick="toggleBlock('+i+')">';
    html += '<span style="color:'+borderColor+';font-weight:bold">'+statusIcon+'</span> ';
    html += '<span style="color:#e2e8f0">'+escapeHtml(b.desc || b.nodeId)+'</span>';
    html += ' <span style="color:#475569;font-size:12px">'+statusText+'</span>';
    if (b.runId) html += ' <span style="color:#334155;font-size:11px">'+escapeHtml(b.runId)+'</span>';
    html += '</div>';
    // 内容(展开时显示)
    if (expanded) {
      html += '<div class="tl-body" style="padding:8px 12px;border-top:1px solid #1f2d46">';
      if (b.reason) html += '<div class="tl-reason" style="color:#64748b;font-size:13px;margin-bottom:6px">调度理由: '+escapeHtml(b.reason)+'</div>';
      if (b.llmOutput) {
        html += '<div class="tl-llm" style="background:#050b17;border-radius:6px;padding:8px;margin-bottom:6px;max-height:300px;overflow:auto;font-size:13px;white-space:pre-wrap;word-break:break-word;color:#dbeafe">'+escapeHtml(b.llmOutput)+'</div>';
      }
      if (b.verdict) {
        const pass = b.verdict.passed;
        html += '<div style="color:'+(pass?'#22c55e':'#ef4444')+';font-size:13px;margin-bottom:4px">'+(pass?'✅':'❌')+' 验证: '+(pass?'通过':'未通过')+(b.verdict.reasons?.length?' — '+escapeHtml(b.verdict.reasons[0].slice(0,80)):'')+'</div>';
      }
      if (b.diagnosis) {
        html += '<div style="color:#a78bfa;font-size:13px;margin-bottom:4px">🔬 归因: '+escapeHtml(b.diagnosis.root_cause)+' — '+escapeHtml((b.diagnosis.explanation||'').slice(0,80))+'</div>';
      }
      if (b.llmOutput && isRunning) {
        // 实时输出自动滚到底(在 renderTimelineBlocks 末尾统一处理)
      }
      html += '</div>';
    }
    html += '</div>';
  }
  el.innerHTML = html;
  // 自动滚动正在执行的 LLM 输出到底
  setTimeout(() => {
    const llms = el.querySelectorAll('.tl-llm');
    if (llms.length) llms[llms.length - 1].scrollTop = llms[llms.length - 1].scrollHeight;
  }, 10);
}

function toggleBlock(i) {
  if (timelineBlocks[i]) {
    timelineBlocks[i]._expanded = !timelineBlocks[i]._expanded;
    renderTimelineBlocks('timelineBox');
  }
}

/** SSE 事件 → 更新 timelineBlocks */
function updateBlockFromSSE(eventType, payload) {
  if (eventType === 'node_selected') {
    // 新节点开始或重试
    const nodeId = payload.node || '';
    const desc = workflowSpec?.capabilities?.find(c => c.id === nodeId)?.desc || nodeId;
    const runId = payload.runId || '';
    // 如果是同一节点重试,更新现有 block;否则新建
    const existing = timelineBlocks.find(b => b.nodeId === nodeId && b.status === 'running');
    if (existing) {
      existing.status = 'failed'; // 之前的变 failed
    }
    timelineBlocks.push({ nodeId, desc, runId, status: 'running', reason: payload.reason || '', llmOutput: '', _expanded: false });
  } else if (eventType === 'llm_stream') {
    // LLM 输出追加到正在执行的 block
    const running = timelineBlocks.find(b => b.status === 'running');
    if (running) {
      if (payload.delta) running.llmOutput += payload.delta;
      else if (payload.message) running.llmOutput += (running.llmOutput ? '\n' : '') + payload.message;
    }
  } else if (eventType === 'verdict') {
    const running = timelineBlocks.find(b => b.status === 'running');
    if (running) {
      running.verdict = payload.verdict;
      running.status = payload.verdict?.passed ? 'passed' : 'failed';
    }
  } else if (eventType === 'diagnosis') {
    const lastFailed = [...timelineBlocks].reverse().find(b => b.status === 'failed');
    if (lastFailed) lastFailed.diagnosis = payload.diagnosis;
  } else if (eventType === 'human_required') {
    const running = timelineBlocks.find(b => b.status === 'running');
    if (running) running.status = 'failed';
  }
  // 只在 executing 阶段重绘
  if (getPhase() === 'executing') renderTimelineBlocks('timelineBox');
}

function renderTimeline(containerId) {
  const el = $(containerId);
  if (!el) return;
  const wf = state.status.workflows.solution;
  if (!wf) { el.innerHTML = '<div class="muted">无 workflow。</div>'; return; }
  const runs = wf.runs || {};
  const allRunIds = Object.values(runs).flat();
  if (!allRunIds.length) { el.innerHTML = '<div class="muted">暂无执行记录</div>'; return; }
  // 按 run 顺序展示(轮次时间线)
  let html = '';
  for (const [nodeId, nodeRuns] of Object.entries(runs)) {
    const spec = workflowSpec?.capabilities?.find(c => c.id === nodeId);
    const kindCls = spec?.kind === 'agent' ? 'run' : 'ok';
    for (const runId of nodeRuns) {
      const selected = runId === activeRunId ? 'selected' : '';
      html += '<div class="task-card '+selected+'" data-run="'+escapeHtml(runId)+'"><div class="task-row"><b>'+escapeHtml(nodeId)+'</b><span class="pill '+kindCls+'">'+escapeHtml(spec?.kind || '?')+'</span></div><div class="task-meta">'+escapeHtml(runId)+'</div></div>';
    }
  }
  el.innerHTML = html;
  el.querySelectorAll('.task-card[data-run]').forEach(card => card.addEventListener('click', () => {
    activeRunId = card.dataset.run;
    streamContent = '';
    renderTimeline(containerId);
    renderExecStream('execStreamArea');
    loadRunLog(activeRunId);
  }));
}

function renderBlackboard(containerId) {
  const el = $(containerId);
  if (!el) return;
  const wf = state.status.workflows.solution;
  const bb = wf?.blackboard || {};
  const schema = workflowSpec?.blackboard_schema;
  const keys = Object.keys(bb);
  if (!keys.length) { el.innerHTML = '<div class="section-title">Blackboard</div><div class="muted" style="padding:8px">暂无记忆(初始状态)。</div>'; return; }
  let html = '<div class="section-title">Blackboard (跨轮记忆)</div><div class="body" style="max-height:300px;overflow:auto">';
  for (const [k, v] of Object.entries(bb)) {
    const desc = schema?.fields?.find(f => f.key === k)?.desc || '';
    const valStr = typeof v === 'string' ? v : JSON.stringify(v);
    const preview = valStr.length > 200 ? valStr.slice(0, 200) + '...' : valStr;
    html += '<div class="qa-item"><div class="qa-q">'+escapeHtml(k)+(desc?' <span class="muted">— '+escapeHtml(desc)+'</span>':'')+'</div><div class="qa-a" style="white-space:pre-wrap">'+escapeHtml(preview)+'</div></div>';
  }
  html += '</div>';
  el.innerHTML = html;
}

function renderLiveStream(containerId) {
  const el = $(containerId);
  if (!el) return;
  const wf = state?.status?.workflows?.solution;
  const curNode = wf?.current_node;
  const iter = wf?.iteration ?? 0;
  // 顶部状态栏
  let html = '<div class="stream-status">节点: '+escapeHtml(curNode||'-')+' | 轮次: '+iter+(currentStreamRunId?' | '+escapeHtml(currentStreamRunId):'')+'</div>';
  // 实时事件流
  html += '<div class="live-feed" id="liveFeedBox">';
  if (liveFeed.length === 0) {
    html += '<div class="muted" style="padding:12px">等待开始...</div>';
  } else {
    for (const item of liveFeed) {
      const cls = item.type === 'llm' ? 'llm-line' : (item.type === 'step' ? 'step-line' : 'meta-line');
      html += '<div class="'+cls+'"><span class="feed-ts">'+escapeHtml(item.ts)+'</span> '+item.text+'</div>';
    }
  }
  html += '</div>';
  el.innerHTML = html;
  // 自动滚到底
  const box = $('liveFeedBox');
  if (box) box.scrollTop = box.scrollHeight;
}

function pushLiveItem(type, text) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  liveFeed.push({ type, text, ts });
  if (liveFeed.length > 500) liveFeed = liveFeed.slice(-500);
  rerenderLiveFeed();
}

/** LLM delta 连续追加:合并到 liveFeed 最后一条 llm 条目(同一 run 的连续 delta 不拆开) */
function appendLlmDelta(delta) {
  const last = liveFeed[liveFeed.length - 1];
  if (last && last.type === 'llm') {
    // 追加到上一条 llm
    last.text += escapeHtml(delta);
  } else {
    // 新建一条 llm(不带时间戳,因为是流式正文)
    liveFeed.push({ type: 'llm', text: escapeHtml(delta), ts: '' });
    if (liveFeed.length > 500) liveFeed = liveFeed.slice(-500);
  }
  // 重绘整个 feed(简单可靠,500 条上限内性能可接受)
  rerenderLiveFeed();
}

function rerenderLiveFeed() {
  const box = $('liveFeedBox');
  if (!box) return;
  let html = '';
  for (const item of liveFeed) {
    const cls = item.type === 'llm' ? 'llm-line' : (item.type === 'step' ? 'step-line' : 'meta-line');
    const ts = item.ts ? '<span class="feed-ts">'+escapeHtml(item.ts)+'</span> ' : '';
    html += '<div class="'+cls+'">'+ts+item.text+'</div>';
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

function renderExecStream(containerId) {
  const el = $(containerId);
  if (!el) return;
  const wf = state.status.workflows.solution;
  const curNode = wf?.current_node;
  const iter = wf?.iteration ?? 0;
  const spec = workflowSpec?.capabilities?.find(c => c.id === (activeRunId ? guessNodeIdFromRun(activeRunId) : curNode));
  let title = curNode || '未选择';
  if (spec) title += ' [' + spec.kind + ']';
  let statusText = 'iteration ' + iter;
  if (activeRunId) statusText += ' | ' + activeRunId;
  el.innerHTML = '<div class="stream-status">'+escapeHtml(statusText)+'</div><div class="stream-box" id="streamBox">'+(streamContent ? markdownToHtml(streamContent) : escapeHtml(activeRunId ? '等待 LLM 实时输出...' : '暂无输出'))+'</div>';
}

function guessNodeIdFromRun(runId) {
  const runs = state?.status?.workflows?.solution?.runs || {};
  for (const [nodeId, nodeRuns] of Object.entries(runs)) {
    if (nodeRuns.includes(runId)) return nodeId;
  }
  return null;
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
    const runs = state?.status?.workflows?.solution?.runs || {};
    const allRuns = Object.values(runs).flat();
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
  try { await post('/projects/'+selectedId+'/plan', {}); await refresh(); }
  catch(e) { alert(e.message); }
  setBusy(false);
}

async function loadSpecForEdit() {
  const panel = $('specEditArea');
  if (!panel) return;
  try {
    const spec = await fetch('/projects/'+selectedId+'/workflow').then(r => r.json());
    panel.value = JSON.stringify(spec, null, 2);
    $('specEditPanel').style.display = 'block';
    panel.focus();
  } catch(e) { alert('加载 spec 失败: ' + e.message); }
}

async function doSaveSpec() {
  setBusy(true);
  try {
    const spec = JSON.parse($('specEditArea').value);
    const res = await fetch('/projects/'+selectedId+'/workflow', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: 'HTTP ' + res.status }));
      throw new Error(err.message || err.error || 'HTTP ' + res.status);
    }
    $('specEditPanel').style.display = 'none';
    workflowSpec = spec;
    await refresh();
    renderPlanOverview('planOverview');
  } catch(e) {
    alert('保存失败: ' + e.message);
  }
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
    // 不需要延迟 refresh — 后端 runGraphProject 开始时发 status_changed SSE,
    // SSE handler 收到后自动 refresh,创建 liveFeedBox
  } catch(e) { alert(e.message); setBusy(false); }
}

async function doHumanVerdict(action) {
  setBusy(true);
  try {
    const body = { action };
    const dirEl = $('humanDirection');
    if (dirEl && dirEl.value.trim()) body.direction_hint = dirEl.value.trim();
    const bbEl = $('humanBbEdit');
    if (bbEl && bbEl.value.trim()) {
      try { body.blackboard_edits = JSON.parse(bbEl.value.trim()); }
      catch(e) { alert('blackboard 编辑不是合法 JSON: ' + e.message); setBusy(false); return; }
    }
    await post('/projects/'+selectedId+'/human-verdict', body);
    await refresh();
    // continue/retry 后自动触发 run(让引擎继续跑)
    if (action === 'continue' || action === 'retry') {
      await post('/projects/'+selectedId+'/run');
    }
  } catch(e) { alert(e.message); }
  setBusy(false);
}

async function loadLastRunForHuman(containerId, nodeId) {
  const el = $(containerId);
  if (!el || !selectedId || !nodeId) return;
  try {
    const wf = state?.status?.workflows?.solution;
    const runs = wf?.runs?.[nodeId] || [];
    if (runs.length === 0) { el.innerHTML = '<div class="muted">无历史 run 记录</div>'; return; }
    const lastRunId = runs[runs.length - 1];
    const res = await fetch('/projects/'+selectedId+'/runs/'+lastRunId+'/stream');
    const text = await res.text();
    el.innerHTML = '<div class="section-title">最近产出 ('+escapeHtml(lastRunId)+')</div><div class="body" style="max-height:300px;overflow:auto">'+markdownToHtml(text.slice(-3000))+'</div>';
  } catch(e) { el.innerHTML = '<div class="muted">加载失败: '+escapeHtml(e.message)+'</div>'; }
}

function doExportMd() {
  window.open('/projects/'+selectedId+'/deliverables/export', '_blank');
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
  ['snapshot','project_created','plan_composed','gate_approved','gate_rejected','run_completed','run_failed','input_recorded','status_changed','blackboard_updated','human_required','human_verdict','verdict'].forEach(type => source.addEventListener(type, () => { refresh(); }));
  // 全流程步骤事件 → liveFeed
  source.addEventListener('node_selected', (event) => {
    const data = JSON.parse(event.data);
    const p = data.payload || {};
    updateBlockFromSSE('node_selected', p);
    refresh();
  });
  source.addEventListener('verdict', (event) => {
    const data = JSON.parse(event.data);
    const p = data.payload || {};
    updateBlockFromSSE('verdict', p);
    refresh();
  });
  source.addEventListener('blackboard_updated', (event) => {
    refresh();
  });
  source.addEventListener('human_required', (event) => {
    const data = JSON.parse(event.data);
    const p = data.payload || {};
    updateBlockFromSSE('human_required', p);
    refresh();
  });
  source.addEventListener('diagnosis', (event) => {
    const data = JSON.parse(event.data);
    const p = data.payload || {};
    updateBlockFromSSE('diagnosis', p);
    refresh();
  });
  // LLM 流式 delta → 更新当前 block
  source.addEventListener('llm_stream', (event) => {
    const data = JSON.parse(event.data);
    const payload = data.payload || {};
    if (payload.delta || payload.message) {
      updateBlockFromSSE('llm_stream', payload);
    }
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function stripDim(s) { return String(s).replace(/^\[.+?\]\s*/, ''); }

${MD_RENDERER_JS}

$('createBtn').onclick = async () => { const goal = $('goal').value.trim(); if (!goal) return; setBusy(true); try { const created = await post('/projects', { goal }); selectedId = created.project.id; $('goal').value=''; await loadProjects(); await selectProject(selectedId); } catch(e) { alert(e.message); } setBusy(false); };
loadProjects().then(() => {
  // 从 URL hash 恢复选中的项目(刷新后保持原界面)
  const hashId = decodeURIComponent(location.hash.slice(1));
  if (hashId) selectProject(hashId);
});
</script>
</body>
</html>`;
}
