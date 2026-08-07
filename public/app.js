
let selectedId = null;
let state = null;
let source = null;
let busy = false;
let workflowSpec = null;
let activeRunId = null;

// Mermaid 初始化
if (typeof mermaid !== 'undefined') { mermaid.initialize({ startOnLoad: false, theme: 'default', flowchart: { curve: 'basis' } }); }

// 从 spec 查 capability 的中文短名(优先 name,fallback desc 前12字,再 fallback id)
function nodeLabel(nodeId) {
  if (!workflowSpec?.capabilities) return nodeId;
  const cap = workflowSpec.capabilities.find(c => c.id === nodeId);
  if (!cap) return nodeId;
  if (cap.name) return cap.name;
  if (cap.desc) return cap.desc.slice(0, 12);
  return cap.id;
}

// 从 spec 查 capability 的完整描述(timeline 展开用)
function nodeFullDesc(nodeId) {
  if (!workflowSpec?.capabilities) return nodeId;
  const cap = workflowSpec.capabilities.find(c => c.id === nodeId);
  return cap?.desc || nodeId;
}

// 生成执行图:展示节点 + 执行次数 + instances + 顺序路径 + retry/回退边
// 注意:图工作流不预设完整图,这里画的是"能力清单 + 可能路径",实线=顺序,虚线=条件
function buildCapabilityGraph(spec) {
  if (!spec || !spec.capabilities) return '';
  const caps = spec.capabilities;
  let lines = ['flowchart TD'];
  lines.push('  classDef agent fill:#eef0ff,stroke:#7c6cf0,color:#7c6cf0');
  lines.push('  classDef light fill:#f0fdf4,stroke:#16a34a,color:#16a34a');
  lines.push('  classDef entry fill:#fffbeb,stroke:#d97706,color:#d97706,stroke-width:2px');
  lines.push('  classDef instance fill:#f3f1ef,stroke:#a1a1aa,color:#71717a');

  // 画节点 + 实例子节点
  for (const c of caps) {
    const instCount = (c.instances && c.instances.length > 0) ? c.instances.length : 1;
    const label = nodeLabel(c.id) + ' ×' + instCount;
    const shape = c.kind === 'agent' ? '["' + label + '"]' : '(("' + label + '"))';
    // mermaid 节点 id 用英文短名(c.id),标签用中文短名
    lines.push('  ' + c.id + shape);
    lines.push('  class ' + c.id + ' ' + (c.kind === 'agent' ? 'agent' : 'light'));
    // 有 instances 的节点:展开实例
    if (c.instances && c.instances.length > 0) {
      for (let i = 0; i < c.instances.length; i++) {
        const inst = c.instances[i];
        const instId = c.id + '_i' + i;
        lines.push('  ' + instId + '("' + escapeHtml(inst) + '")');
        lines.push('  class ' + instId + ' instance');
        lines.push('  ' + c.id + ' --> ' + instId);
      }
    }
  }

  // 顺序路径(实线):能力清单顺序 = 可能的执行顺序
  for (let i = 0; i < caps.length - 1; i++) {
    const cur = caps[i];
    const next = caps[i + 1];
    if (cur.instances && cur.instances.length > 0) {
      const lastInstId = cur.id + '_i' + (cur.instances.length - 1);
      lines.push('  ' + lastInstId + ' --> ' + next.id);
    } else {
      lines.push('  ' + cur.id + ' --> ' + next.id);
    }
  }

  // retry 自环(虚线):每个节点都可能被 scheduler 重试
  for (const c of caps) {
    lines.push('  ' + c.id + ' -.retry.-> ' + c.id);
  }

  // 回退边(虚线):最后一个节点(通常是 review)fail → 回退到 deliverable 产出节点
  if (caps.length >= 2) {
    const lastNode = caps[caps.length - 1];
    const prodNode = caps.find(c => c.outputs?.some(o => o.role === 'deliverable'));
    if (prodNode && prodNode.id !== lastNode.id) {
      lines.push('  ' + lastNode.id + ' -.fail回退.-> ' + prodNode.id);
    }
  }

  if (spec.entry_node) lines.push('  class ' + spec.entry_node + ' entry');
  return lines.join('\n');
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
  lines.push('  classDef passed fill:#f0fdf4,stroke:#16a34a,color:#16a34a');
  lines.push('  classDef failed fill:#fef2f2,stroke:#dc2626,color:#dc2626');
  lines.push('  classDef running fill:#fffbeb,stroke:#d97706,color:#d97706,stroke-width:3px');
  for (const c of caps) {
    const nodeRuns = runs[c.id] ?? [];
    const runCount = nodeRuns.length;
    const failCount = retries[c.id] ?? 0;
    const isRunning = curNode === c.id && wf?.awaiting === 'none_midstep';
    // 只画已经执行过或正在执行的节点
    if (runCount === 0 && !isRunning) continue;
    let label = nodeLabel(c.id);
    if (runCount > 0) label += '\n✓' + runCount + '次';
    if (failCount > 0) label += ' \n✗' + failCount + '次失败';
    if (isRunning) label += '\n⟳ 执行中';
    lines.push('  ' + c.id + '["' + label + '"]');
    if (isRunning) lines.push('  class ' + c.id + ' running');
    else if (failCount > 0 && runCount === 0) lines.push('  class ' + c.id + ' failed');
    else lines.push('  class ' + c.id + ' passed');
  }
  return lines.join('\n');
}
let selectedTaskId = null;
let streamContent = '';
let liveFeed = [];
let currentStreamRunId = null;

// 时间线 blocks:每条 = 一个节点执行 {nodeId, desc, runId, status, reason, llmOutput, verdict, diagnosis, ts}
let timelineBlocks = [];

const $ = (id) => document.getElementById(id);

// 当前查看的阶段(null=跟随实际 phase,非null=回顾指定阶段)
let viewMode = null;
let planBlocks = [];
let planProgress = '';

function setPlanProgress(msg) { planProgress = msg; const el = document.getElementById('planProgressMsg'); if (el) el.textContent = msg; console.log('[plan_progress]', msg); }

const STEPS = [
  { key: 'created', label: '创建', n: 1 },
  { key: 'clarifying', label: '澄清', n: 2 },
  { key: 'composing', label: '规划', n: 3 },
  { key: 'plan_review', label: '', n: 3 },
  { key: 'executing', label: '执行', n: 4 },
  { key: 'final_review', label: '审方案', n: 5 },
  { key: 'approved', label: '完成', n: 6 },
];

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'content-type':'application/json' }, ...options });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function post(path, body = {}) { return api(path, { method:'POST', body: JSON.stringify(body) }); }

async function loadProjects() {
  const projects = await api('/projects');
  $('projects').innerHTML = projects.map(p => '<div class="project '+(p.id===selectedId?'active':'')+'"><div class="row" style="justify-content:space-between"><div data-id="'+escapeHtml(p.id)+'" style="flex:1;min-width:0"><b>'+escapeHtml(p.name||p.id)+'</b></div><button class="bad del-btn" data-id="'+escapeHtml(p.id)+'" style="padding:2px 8px;font-size:11px;flex-shrink:0">删除</button></div><div class="muted" data-id="'+escapeHtml(p.id)+'" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escapeHtml(p.goal||'')+'</div></div>').join('');
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
  planBlocks = [];
  viewMode = null;
  currentStreamRunId = null;
  $('empty').style.display='none';
  $('detail').style.display='block';
  await refresh();
  connectEvents();
  await maybeAutoStartClarify();
}

async function refresh() {
  if (!selectedId) return;
  try {
    state = await api('/projects/'+selectedId);
  } catch(e) {
    // 项目不存在(被删/损坏),回首页
    selectedId = null;
    state = null;
    workflowSpec = null;
    timelineBlocks = [];
    history.replaceState(null, '', '#');
    $('detail').style.display = 'none';
    $('empty').style.display = 'block';
    await loadProjects();
    return;
  }
  const phase = getPhase();
  if (phase && !['created','clarifying','composing'].includes(phase) && !workflowSpec) {
    try { workflowSpec = await api('/projects/'+selectedId+'/workflow'); } catch(e) { workflowSpec = null; }
  }
  // 执行阶段:如果 timelineBlocks 空,从后端 events.log 重建(刷新后恢复历史)
  if (phase === 'executing' && timelineBlocks.length === 0) {
    try {
      const events = await api('/projects/'+selectedId+'/timeline');
      rebuildTimelineFromEvents(events);
    } catch(e) {}
  }
  render();
  await loadProjects();
}

function getPhase() {
  if (!state) return 'created';
  const clarifier = state.status.clarifier;
  if (clarifier && clarifier.status !== 'goal_confirmed' && !state.status.workflows.solution) return 'clarifying';
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
  const visibleSteps = STEPS.filter(s => s.label);
  const idx = visibleSteps.findIndex(s => s.key === phase);
  $('steps').innerHTML = visibleSteps.map((s, i) => {
    let cls = '';
    let clickable = false;
    if (idx === -1) { cls = i === 0 ? 'done' : ''; clickable = i === 0; }
    else if (i < idx) { cls = 'done'; clickable = true; }
    else if (i === idx) { cls = 'active'; clickable = false; }
    // viewMode 高亮
    if (viewMode === s.key) cls = 'viewing';
    const clickAttr = clickable ? ' style="cursor:pointer" data-step-key="'+s.key+'"' : '';
    return '<div class="step '+cls+'"'+clickAttr+'><span class="step-num">'+s.n+'</span>'+s.label+'</div>';
  }).join('');
  // 绑定步骤点击
  document.querySelectorAll('.step[data-step-key]').forEach(el => {
    el.addEventListener('click', () => setViewMode(el.dataset.stepKey));
  });
}

function setViewMode(mode) {
  if (viewMode === mode) { viewMode = null; } // 再点一次取消
  else { viewMode = mode; }
  renderSteps();
  renderMain();
}

// 回顾模式:展示之前阶段的内容(只读)+ 从此阶段重跑按钮
function renderViewMode(el, mode) {
  const phase = getPhase();
  let html = '<div class="guide"><div class="guide-title">回顾: ' + escapeHtml(STEPS.find(s => s.key === mode)?.label || mode) + '</div>';
  // 从此阶段重跑(只在非当前阶段时显示)
  html += '<div class="row" style="margin:8px 0"><button class="secondary" id="rerunFromBtn">从此阶段重跑</button> <button class="bad" id="returnCurrentBtn">返回当前</button></div>';

  if (mode === 'created' || mode === 'clarifying') {
    const entries = state.status.clarifier?.clarifications ?? [];
    const goal = state.project?.goal || '';
    html += '<div class="guide-desc">目标: '+escapeHtml(goal)+'</div>';
    if (entries.length > 0) {
      html += '<div class="section-title" style="margin-top:8px">已澄清记录</div>';
      for (const e of entries) {
        html += '<div class="qa-item"><div class="qa-q">Q: '+escapeHtml(e.q)+'</div><div class="qa-a">A: '+escapeHtml(e.a)+'</div></div>';
      }
    } else { html += '<div class="muted">无澄清记录</div>'; }
  } else if (mode === 'composing' || mode === 'plan_review') { // 合并:规划阶段
    // 展示 spec(能力清单+硬约束+软引导)
    if (workflowSpec) {
      html += '<div class="section-title">能力清单</div>';
      for (const c of workflowSpec.capabilities || []) {
        html += '<div class="qa-item"><div class="qa-q">['+c.kind+'] '+escapeHtml(c.desc)+'</div>';
        if (c.checks?.length) html += '<div class="qa-a">验收: '+c.checks.map(ch => escapeHtml(ch.desc)).join('; ')+'</div>';
        html += '</div>';
      }
      if (workflowSpec.hard_constraints?.length) { html += '<div class="section-title" style="margin-top:8px">硬约束</div>'; for (const h of workflowSpec.hard_constraints) html += '<div>- '+escapeHtml(h)+'</div>'; }
      if (workflowSpec.soft_guidance?.length) { html += '<div class="section-title" style="margin-top:8px">软引导</div>'; for (const s of workflowSpec.soft_guidance) html += '<div>- '+escapeHtml(s)+'</div>'; }
      // 能力关系图
      html += '<div id="capGraph" style="margin-top:12px"></div>';
      let legendHtml = '<div style="margin-top:8px;font-size:12px;color:var(--text-muted);line-height:1.6">';
      legendHtml += '<b>图例:</b> ';
      legendHtml += '实线 → 顺序路径(可能执行顺序) · ';
      legendHtml += '虚线 -.retry.-> 节点可被 scheduler 重试 · ';
      legendHtml += '虚线 -.fail回退.-> 审核失败回退到产出节点 · ';
      legendHtml += '×N = 预期执行次数(=instances 数量,无 instances = ×1 一次性)';
      legendHtml += '</div>';
      html += legendHtml;
    } else { html += '<div class="muted">无 spec 数据</div>'; }
  } else if (mode === 'executing') {
    // 展示时间线(只读)
    html += '<div id="timelineBox"></div>';
    html += '<div id="blackboardPanel" style="margin-top:12px"></div>';
    el.innerHTML = html + '</div>';
    bindViewModeButtons(mode);
    renderTimelineBlocks('timelineBox');
    renderBlackboard('blackboardPanel');
    return;
  } else if (mode === 'final_review') {
    html += '<div class="guide-desc">最终方案审查</div>';
    html += '<div id="deliverablesBox"></div>';
    el.innerHTML = html + '</div>';
    bindViewModeButtons(mode);
    loadDeliverables();
    return;
  }

  html += '</div>';
  el.innerHTML = html;
  // 渲染 mermaid 图(规划阶段回顾)
  if ((mode === 'composing' || mode === 'plan_review') && workflowSpec) {
    const graphDef = buildCapabilityGraph(workflowSpec);
    renderMermaidGraph('capGraph', graphDef);
  }
  bindViewModeButtons(mode);
}

function bindViewModeButtons(mode) {
  const rerunBtn = $('rerunFromBtn');
  if (rerunBtn) rerunBtn.onclick = () => doRerunFrom(mode);
  const returnBtn = $('returnCurrentBtn');
  if (returnBtn) returnBtn.onclick = () => setViewMode(mode);
}

// 从指定阶段重跑
async function doRerunFrom(mode) {
  if (!selectedId) return;
  if (!confirm('确认从「'+(STEPS.find(s=>s.key===mode)?.label||mode)+'」阶段重跑?后续阶段的数据将被重置。')) return;
  setBusy(true);
  try {
    await post('/projects/'+selectedId+'/rerun-from', { phase: mode });
    viewMode = null;
    await refresh();
  } catch(e) { alert(e.message); }
  setBusy(false);
}

function renderMain() {
  const phase = getPhase();
  const el = $('mainArea');

  // 回顾模式:展示之前阶段的内容(只读)
  if (viewMode && viewMode !== phase) {
    renderViewMode(el, viewMode);
    return;
  }

  // --- Clarifying ---
  if (phase === 'created' || phase === 'clarifying') {
    const batch = state.status.clarifier?.pending_batch;
    const entries = state.status.clarifier?.clarifications ?? [];
    if (batch && batch.length > 0) {
      // 有待回答的问题,展示批量问答表单
      let html = '<div class="guide"><div class="guide-title">澄清目标</div><div class="guide-desc">请回答以下问题,帮助系统更好地规划方案:</div>';
      for (let i = 0; i < batch.length; i++) {
        const q = batch[i];
        html += '<div class="qa-item" style="margin:8px 0"><div class="qa-q">Q'+(i+1)+': '+escapeHtml(q.question)+'</div>';
        html += '<div class="muted" style="font-size:12px;margin:2px 0">'+escapeHtml(q.risk)+'</div>';
        html += '<input id="answer_'+i+'" data-q="'+escapeHtml(q.question)+'" placeholder="输入回答" style="width:100%;margin-top:4px" /></div>';
      }
      html += '<div class="row" style="margin-top:8px"><button id="submitBatchBtn">提交全部回答</button><button class="secondary" id="skipClarifyBtn">跳过,直接生成</button></div></div>';
      if (entries.length > 0) {
        html += '<div class="section-title" style="margin-top:12px">已回答</div>';
        for (const e of entries) { html += '<div class="qa-item"><div class="qa-q">Q: '+escapeHtml(e.q)+'</div><div class="qa-a">A: '+escapeHtml(e.a)+'</div></div>'; }
      }
      el.innerHTML = html;
      $('submitBatchBtn').onclick = () => doClarifyAnswer(batch.length);
      $('skipClarifyBtn').onclick = () => doPlan();
    } else {
      // 没有待回答的问题
      el.innerHTML = '<div class="guide"><div class="guide-title">澄清目标</div><div class="guide-desc muted">正在生成澄清问题...</div></div>';
    }
    return;
  }

  // --- Composing ---
  if (phase === 'composing') {
    let html = '<div class="guide"><div class="guide-title">规划中</div><div class="guide-desc" id="planProgressMsg">正在启动...</div></div>';
    if (planBlocks.length > 0) {
      html += '<div style="margin-top:12px">';
      for (const b of planBlocks) {
        const isInput = b.step === 'llm_input';
        const isOutput = b.step === 'llm_output';
        const isResult = b.step === 'sufficiency_result';
        const color = isInput ? 'var(--accent)' : isOutput ? 'var(--ok)' : isResult ? 'var(--accent-hover)' : 'var(--text-muted)';
        const label = b.step === 'composing' ? 'Composer 生成' :
                      b.step === 'llm_input' ? 'LLM 输入' :
                      b.step === 'llm_output' ? 'LLM 输出' :
                      b.step === 'sufficiency_check' ? '充分性检查' :
                      b.step === 'sufficiency_result' ? '检查结果' :
                      b.step === 'sufficiency_failed' ? '检查未通过' :
                      b.step === 'hard_check_failed' ? '硬校验未通过' :
                      b.step === 'done' ? '规划完成' : b.step;
        html += '<div style="border:1px solid ' + color + ';border-radius:6px;margin-bottom:6px;overflow:hidden">';
        html += '<div style="padding:6px 10px;background:var(--surface-hover);cursor:pointer;color:' + color + ';font-size:13px;font-weight:bold" onclick="this.parentElement.querySelector(\'.pb-body\').style.display = this.parentElement.querySelector(\'.pb-body\').style.display === \'none\' ? \'block\' : \'none\'">' + escapeHtml(label) + '</div>';
        if (b.content) {
          html += '<div class="pb-body" style="padding:8px 10px;border-top:1px solid var(--border);font-size:13px;white-space:pre-wrap;word-break:break-word;color:var(--text-secondary);max-height:400px;overflow:auto;background:var(--bg)">' + escapeHtml(b.content) + '</div>';
        } else if (b.message) {
          html += '<div class="pb-body" style="padding:8px 10px;border-top:1px solid var(--border);font-size:13px;color:var(--text-secondary)">' + escapeHtml(b.message) + '</div>';
        } else {
          html += '<div class="pb-body" style="display:none;padding:8px 10px;border-top:1px solid var(--border);font-size:13px;color:var(--text-muted)">(无内容)</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    el.innerHTML = html;
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
    // 能力关系图 + 图例
    const graphDef = buildCapabilityGraph(workflowSpec);
    let legendHtml = '<div style="margin-top:8px;font-size:12px;color:var(--text-muted);line-height:1.6">';
    legendHtml += '<b>图例:</b> ';
    legendHtml += '实线 → 顺序路径(可能执行顺序) · ';
    legendHtml += '虚线 -.retry.-> 节点可被 scheduler 重试 · ';
    legendHtml += '虚线 -.fail回退.-> 审核失败回退到产出节点 · ';
    legendHtml += '×N = 预期执行次数(=instances 数量,无 instances = ×1 一次性)';
    legendHtml += '</div>';
    $('capGraph').insertAdjacentHTML('beforebegin', legendHtml);
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
      '<div class="row"><button class="good" id="humanContinueBtn">继续执行</button><button class="secondary" id="humanRetryBtn">重试 '+escapeHtml(nodeLabel(wf?.current_node)||'')+'</button><button class="bad" id="humanAbortBtn">放弃</button></div>'+
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
    const instList = cap.instances?.length ? '<div class="task-meta">实例 ×'+cap.instances.length+': '+escapeHtml(cap.instances.join(' / '))+'</div>' : '<div class="task-meta">执行次数: 1次(一次性)</div>';
    html += '<div class="task-card"><div class="task-row"><b>'+escapeHtml(nodeLabel(cap.id))+'</b><span class="pill '+kindCls+'">'+escapeHtml(cap.kind)+'</span></div><div class="task-desc">'+escapeHtml(cap.desc)+'</div>'+instList+outputs+checks+updates+'</div>';
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
    const borderColor = isRunning ? 'var(--warn)' : isFailed ? 'var(--bad)' : isPassed ? 'var(--ok)' : 'var(--text-muted)';
    const statusIcon = isRunning ? '⟳' : isFailed ? '✗' : isPassed ? '✓' : '○';
    const statusText = isRunning ? '执行中' : isFailed ? '失败' : isPassed ? '通过' : '等待';
    // 正在执行和失败的块默认展开,通过的默认折叠
    const expanded = isRunning || isFailed || b._expanded;

    html += '<div class="tl-block">';
    // 头部
    html += '<div class="tl-head" onclick="toggleBlock('+i+')">';
    html += '<span style="color:'+borderColor+';font-weight:600;font-size:14px">'+statusIcon+'</span> ';
    html += '<span style="color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escapeHtml(nodeFullDesc(b.nodeId) || b.desc || b.nodeId)+'</span>';
    if (b.instance) html += ' <span style="color:var(--warn);font-size:12px;font-weight:500">['+escapeHtml(b.instance)+']</span>';
    html += ' <span style="color:'+borderColor+';font-size:12px;font-weight:500">'+statusText+'</span>';
    if (b.runId) html += ' <span class="muted" style="font-size:11px">'+escapeHtml(b.runId)+'</span>';
    html += '</div>';
    // 内容(展开时显示)
    if (expanded) {
      html += '<div class="tl-body">';
      if (b.reason) html += '<div class="tl-reason">调度理由: '+escapeHtml(b.reason)+'</div>';
      if (b.llmOutput) {
        html += '<div class="tl-llm">'+escapeHtml(b.llmOutput)+'</div>';
      }
      if (b.artifactCollected) {
        html += '<div style="color:var(--text-muted);font-size:13px;margin-bottom:4px">📦 产物收集完成</div>';
      }
      if (b.artifactValidated === false) {
        const codes = b.artifactFailures?.length ? ' ('+b.artifactFailures.join(', ')+')' : '';
        html += '<div style="color:var(--bad);font-size:13px;margin-bottom:4px">⚠️ 产物契约失败'+escapeHtml(codes)+'</div>';
      } else if (b.artifactValidated === true) {
        html += '<div style="color:var(--ok);font-size:13px;margin-bottom:4px">✅ 产物契约通过</div>';
      }
      if (b.materialized) {
        const paths = b.materializedPaths?.length ? ' — '+escapeHtml(b.materializedPaths.join(', ')) : '';
        html += '<div style="color:var(--warn);font-size:13px;margin-bottom:4px">🔧 兜底修复: materializer 已生成正式产物'+paths+'</div>';
      }
      if (b.materializationFailed) {
        const reason = b.materializationReason ? ' — '+escapeHtml(b.materializationReason) : '';
        html += '<div style="color:var(--bad);font-size:13px;margin-bottom:4px">🔧 兜底修复失败'+reason+'</div>';
      }
      if (b.verdict) {
        const pass = b.verdict.passed;
        html += '<div style="color:'+(pass?'var(--ok)':'var(--bad)')+';font-size:13px;margin-bottom:4px">'+(pass?'✅':'❌')+' 验证: '+(pass?'通过':'未通过')+(b.verdict.reasons?.length?' — '+escapeHtml(b.verdict.reasons[0].slice(0,80)):'')+'</div>';
      }
      if (b.diagnosis) {
        html += '<div style="color:var(--accent-hover);font-size:13px;margin-bottom:4px">🔬 归因: '+escapeHtml(b.diagnosis.root_cause)+' — '+escapeHtml((b.diagnosis.explanation||'').slice(0,80))+'</div>';
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

/** 从后端 events.log 重建 timelineBlocks(刷新后恢复历史) */
function rebuildTimelineFromEvents(events) {
  timelineBlocks = [];
  for (const e of events) {
    if (e.type === 'node_selected') {
      // node_selected 事件:创建/更新 block
      const nodeId = e.node || '';
      const desc = workflowSpec?.capabilities?.find(c => c.id === nodeId)?.desc || nodeId;
      const runId = e.run_id || '';
      const existing = timelineBlocks.find(b => b.nodeId === nodeId && b.status === 'running');
      if (existing) { existing.status = 'failed'; }
      timelineBlocks.push({ nodeId, desc, runId, status: 'running', reason: e.reason || '', instance: e.instance || '', llmOutput: '', _expanded: false });
    } else if (e.type === 'run_created') {
      // 只更新已有 block 的 runId
      const running = [...timelineBlocks].reverse().find(b => b.nodeId === e.node && b.status === 'running');
      if (running && e.run_id) running.runId = e.run_id;
    } else if (e.type === 'artifact_collected') {
      const running = [...timelineBlocks].reverse().find(b => b.nodeId === e.node && b.status === 'running');
      if (running) running.artifactCollected = true;
    } else if (e.type === 'artifact_validated') {
      const running = [...timelineBlocks].reverse().find(b => b.nodeId === e.node && b.status === 'running');
      if (running) running.artifactValidated = e.data?.passed ?? true;
    } else if (e.type === 'artifact_failed') {
      const running = [...timelineBlocks].reverse().find(b => b.nodeId === e.node && b.status === 'running');
      if (running) { running.artifactValidated = false; running.artifactFailures = e.data?.failure_codes || []; }
    } else if (e.type === 'artifact_materialized') {
      const target = [...timelineBlocks].reverse().find(b => b.nodeId === e.node && (b.status === 'running' || b.status === 'failed'));
      if (target) { target.materialized = true; target.materializedPaths = e.data?.written || []; }
    } else if (e.type === 'artifact_materialization_failed') {
      const target = [...timelineBlocks].reverse().find(b => b.nodeId === e.node && (b.status === 'running' || b.status === 'failed'));
      if (target) { target.materializationFailed = true; target.materializationReason = e.reason || ''; }
    } else if (e.type === 'verdict') {
      const running = [...timelineBlocks].reverse().find(b => b.status === 'running');
      if (running) {
        running.verdict = e.data;
        running.status = e.data?.passed ? 'passed' : 'failed';
      }
    } else if (e.type === 'diagnosis') {
      const lastFailed = [...timelineBlocks].reverse().find(b => b.status === 'failed');
      if (lastFailed) lastFailed.diagnosis = e.data;
    } else if (e.type === 'human_required') {
      const running = timelineBlocks.find(b => b.status === 'running');
      if (running) running.status = 'failed';
    }
  }
  // 最后一个 running 的可能是当前正在执行的
}

/** SSE 事件 → 更新 timelineBlocks */
function updateBlockFromSSE(eventType, payload) {
  const running = timelineBlocks.find(b => b.status === 'running');
  if (eventType === 'node_selected') {
    // 新节点开始或重试
    const nodeId = payload.node || '';
    const desc = workflowSpec?.capabilities?.find(c => c.id === nodeId)?.desc || nodeId;
    const runId = payload.runId || '';
    // 如果是同一节点同一 run 已存在(timeline 重建 + SSE 实时冲突),不重复创建
    const dup = timelineBlocks.find(b => b.nodeId === nodeId && b.runId === runId);
    if (dup) return; // 已存在,跳过
    // 如果是同一节点重试(不同 runId),之前的变 failed
    const existing = timelineBlocks.find(b => b.nodeId === nodeId && b.status === 'running');
    if (existing) {
      existing.status = 'failed';
    }
    timelineBlocks.push({ nodeId, desc, runId, status: 'running', reason: payload.reason || '', instance: payload.instance || '', llmOutput: '', _expanded: false });
  } else if (eventType === 'llm_stream') {
    // LLM 输出追加到正在执行的 block
    const r = running || timelineBlocks[timelineBlocks.length - 1];
    if (r) {
      if (payload.delta) r.llmOutput += payload.delta;
      else if (payload.message) r.llmOutput += (r.llmOutput ? String.fromCharCode(10) : '') + payload.message;
    }
  } else if (eventType === 'artifact_collected') {
    if (running) running.artifactCollected = true;
  } else if (eventType === 'artifact_validated') {
    if (running) running.artifactValidated = payload.passed ?? true;
  } else if (eventType === 'artifact_failed') {
    if (running) { running.artifactValidated = false; running.artifactFailures = payload.failure_codes || []; }
  } else if (eventType === 'artifact_materialized') {
    const target = running || [...timelineBlocks].reverse().find(b => b.status === 'failed');
    if (target) { target.materialized = true; target.materializedPaths = payload.written || []; }
  } else if (eventType === 'artifact_materialization_failed') {
    const target = running || [...timelineBlocks].reverse().find(b => b.status === 'failed');
    if (target) { target.materializationFailed = true; target.materializationReason = payload.reason || ''; }
  } else if (eventType === 'verdict') {
    if (running) {
      running.verdict = payload.verdict;
      running.status = payload.verdict?.passed ? 'passed' : 'failed';
    }
  } else if (eventType === 'diagnosis') {
    const lastFailed = [...timelineBlocks].reverse().find(b => b.status === 'failed');
    if (lastFailed) lastFailed.diagnosis = payload.diagnosis;
  } else if (eventType === 'human_required') {
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
    // tab 切换布局:左侧 tab 栏 + 右侧内容区
    let html = '<div style="display:flex;gap:0;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">';
    // 左侧 tab
    html += '<div style="flex-shrink:0;border-right:1px solid var(--border);background:var(--bg-elevated);min-width:140px">';
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const tabName = f.path.split('/').pop();
      const isActive = i === 0;
      html += '<div class="del-tab" data-idx="'+i+'" style="padding:8px 12px;cursor:pointer;font-size:13px;font-weight:'+(isActive?'600':'400')+';color:'+(isActive?'var(--accent)':'var(--text-secondary)')+';background:'+(isActive?'var(--surface)':'transparent')+';border-left:'+(isActive?'3px solid var(--accent)':'3px solid transparent')+';transition:all 0.15s ease;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escapeHtml(tabName)+'</div>';
    }
    html += '</div>';
    // 右侧内容
    html += '<div style="flex:1;min-width:0">';
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const isActive = i === 0;
      html += '<div class="del-panel" data-idx="'+i+'" style="display:'+(isActive?'block':'none')+';padding:16px;max-height:500px;overflow:auto">'+markdownToHtml(f.content)+'</div>';
    }
    html += '</div></div>';
    el.innerHTML = html;
    // tab 切换事件
    el.querySelectorAll('.del-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const idx = tab.dataset.idx;
        el.querySelectorAll('.del-tab').forEach(t => {
          t.style.fontWeight = '400';
          t.style.color = 'var(--text-secondary)';
          t.style.background = 'transparent';
          t.style.borderLeftColor = 'transparent';
        });
        tab.style.fontWeight = '600';
        tab.style.color = 'var(--accent)';
        tab.style.background = 'var(--surface)';
        tab.style.borderLeftColor = 'var(--accent)';
        el.querySelectorAll('.del-panel').forEach(p => {
          p.style.display = p.dataset.idx === idx ? 'block' : 'none';
        });
      });
    });
  } catch(e) { el.innerHTML = '<div class="muted">加载失败: '+escapeHtml(e.message)+'</div>'; }
}

async function maybeAutoStartClarify() {
  const phase = getPhase();
  if (phase === 'created' && !state.status.clarifier?.pending_batch) { await doClarify(); }
}

async function doClarify() {
  setBusy(true);
  try { await post('/projects/'+selectedId+'/clarify-batch'); await refresh(); }
  catch(e) { alert(e.message); }
  setBusy(false);
}

async function doClarifyAnswer(count) {
  const answers = [];
  for (let i = 0; i < count; i++) {
    const el = $('answer_'+i);
    if (el) answers.push({ q: el.dataset.q, a: el.value.trim() });
  }
  if (answers.some(a => !a.a)) { alert('请回答所有问题'); return; }
  setBusy(true);
  try {
    const res = await post('/projects/'+selectedId+'/clarify-answer', { answers });
    if (res && res.needFollowup) { await refresh(); }
    else { await doPlan(); }
  } catch(e) { alert(e.message); }
  setBusy(false);
}

async function doPlan() {
  setBusy(true);
  try {
    const res = await post('/projects/'+selectedId+'/plan', {});
    // fire-and-forget: 后端返回 { status: "composing" },plan 在后台跑
    // 通过 SSE plan_progress 事件看进度,plan_composed 事件触发 refresh
    if (res && res.status === 'composing') {
      // 等 SSE 事件驱动,不主动 refresh(plan 还没完成)
    } else {
      // 传 spec 模式可能直接返回
      await refresh();
    }
  } catch(e) { alert(e.message); }
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
  try {
    await post('/projects/'+selectedId+'/approve', { gate, note: 'UI approve '+gate });
    await refresh();
    // plan_review 通过后自动触发执行
    if (gate === 'plan_review') { await doRun(); }
  } catch(e) { alert(e.message); }
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
  // 统一 SSE 接收:后端发 unnamed event,所有事件走同一通道,按 data.type 分发
  source.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    const type = data.type;
    const payload = data.payload || {};
    if (type === 'snapshot') return;
    if (type === 'llm_status') {
      const s = payload || {};
      const el = document.getElementById('llmStatusBar');
      if (s.phase === 'calling') {
        if (el) { el.style.display = 'flex'; el.querySelector('.llm-status-text').textContent = s.description; }
      } else if (s.phase === 'done' || s.phase === 'error') {
        if (el) { el.style.display = 'none'; }
      }
      return;
    }
    if (type === 'project_deleted') {
      const deletedId = payload.projectId || data.project_id;
      if (deletedId === selectedId) {
        selectedId = null; state = null; workflowSpec = null; timelineBlocks = [];
        history.replaceState(null, '', '#');
        $('detail').style.display = 'none';
        $('empty').style.display = 'block';
      }
      loadProjects();
      return;
    }
    if (type === 'plan_progress') {
      if (payload.message) setPlanProgress(payload.message);
      if (payload.step) {
        const key = payload.step + '\0' + (payload.message || '') + '\0' + (payload.content || '');
        if (!planBlocks.some(b => (b.step+'\0'+b.message+'\0'+b.content) === key)) {
          planBlocks.push({ step: payload.step, message: payload.message || '', content: payload.content || '' });
        }
      }
      const phase = typeof getPhase === 'function' ? getPhase() : '';
      if (phase === 'composing') {
        const el = document.getElementById('mainArea');
        if (el) {
          let html = '<div class="guide"><div class="guide-title">规划中</div><div class="guide-desc" id="planProgressMsg">' + escapeHtml(planProgress) + '</div></div>';
          if (planBlocks.length > 0) {
            html += '<div style="margin-top:12px">';
            for (const b of planBlocks) {
              const isInput = b.step === 'llm_input';
              const isOutput = b.step === 'llm_output';
              const isResult = b.step === 'sufficiency_result';
              const color = isInput ? 'var(--accent)' : isOutput ? 'var(--ok)' : isResult ? 'var(--accent-hover)' : 'var(--text-muted)';
              const label = b.step === 'composing' ? 'Composer 生成' :
                            b.step === 'llm_input' ? 'LLM 输入' :
                            b.step === 'llm_output' ? 'LLM 输出' :
                            b.step === 'sufficiency_check' ? '充分性检查' :
                            b.step === 'sufficiency_result' ? '检查结果' :
                            b.step === 'sufficiency_failed' ? '检查未通过' :
                            b.step === 'hard_check_failed' ? '硬校验未通过' :
                            b.step === 'done' ? '规划完成' : b.step;
              html += '<div style="border:1px solid ' + color + ';border-radius:6px;margin-bottom:6px;overflow:hidden">';
              html += '<div style="padding:6px 10px;background:var(--surface-hover);cursor:pointer;color:' + color + ';font-size:13px;font-weight:bold" onclick="var body=this.parentElement.querySelector(\'.pb-body\');body.style.display=body.style.display===\'none\'?\'block\':\'none\'">' + escapeHtml(label) + '</div>';
              if (b.content) {
                html += '<div class="pb-body" style="padding:8px 10px;border-top:1px solid var(--border);font-size:13px;white-space:pre-wrap;word-break:break-word;color:var(--text-secondary);max-height:400px;overflow:auto;background:var(--bg)">' + escapeHtml(b.content) + '</div>';
              } else if (b.message) {
                html += '<div class="pb-body" style="padding:8px 10px;border-top:1px solid var(--border);font-size:13px;color:var(--text-secondary)">' + escapeHtml(b.message) + '</div>';
              } else {
                html += '<div class="pb-body" style="display:none;padding:8px 10px;border-top:1px solid var(--border);font-size:13px;color:var(--text-muted)">(无内容)</div>';
              }
              html += '</div>';
            }
            html += '</div>';
          }
          el.innerHTML = html;
        }
      }
      return;
    }
    if (type === 'llm_stream') {
      if (payload.delta || payload.message) {
        updateBlockFromSSE('llm_stream', payload);
      }
      return;
    }
    // 执行阶段事件:更新 timeline block + refresh
    updateBlockFromSSE(type, payload);
    refresh();
  };
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function stripDim(s) { return String(s).replace(/^[.+?]s*/, ''); }

function markdownToHtml(md) {
  var s = String(md).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  var BT = String.fromCharCode(96);
  // Code blocks (triple backtick)
  var blocks = [];
  var codeRe = new RegExp(BT+BT+BT+'(\\w*)\\n?([\\s\\S]*?)'+BT+BT+BT, 'g');
  s = s.replace(codeRe, function(m, lang, code) {
    blocks.push('<pre style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;overflow:auto;font-size:12px">'+code.trim()+'</pre>');
    return '\u0000CODEBLOCK'+(blocks.length-1)+'\u0000';
  });
  // Tables: consecutive lines starting with |
  s = s.replace(/(^[\|].+\|\n?)+/gm, function(block) {
    var lines = block.trim().split('\n').filter(function(l){return l.trim();});
    if (lines.length < 2) return block;
    var rows = lines.map(function(l){return l.split('|').filter(function(c){return c.trim()!=='';}).map(function(c){return c.trim();});});
    var isSep = rows.length > 1 && rows[1].every(function(c){return /^[-:]+$/.test(c);});
    var html = '<table style="width:100%;border-collapse:collapse;font-size:13px;margin:8px 0">';
    if (isSep) {
      html += '<tr>' + rows[0].map(function(c){return '<th style="border:1px solid var(--border);padding:6px 8px;text-align:left;background:var(--surface-hover)">'+c+'</th>';}).join('') + '</tr>';
      for (var i=2; i<rows.length; i++) { html += '<tr>' + rows[i].map(function(c){return '<td style="border:1px solid var(--border);padding:6px 8px">'+c+'</td>';}).join('') + '</tr>'; }
    } else {
      for (var r=0; r<rows.length; r++) { html += '<tr>' + rows[r].map(function(c,idx){return '<td style="border:1px solid var(--border);padding:6px 8px;'+(idx===0?'font-weight:600':'')+'">'+c+'</td>';}).join('') + '</tr>'; }
    }
    return html + '</table>';
  });
  // Split into lines for block-level processing
  var lines = s.split('\n');
  var result = []; var inUl = false; var inOl = false; var inBq = false;
  function closeLists() { if(inUl){result.push('</ul>');inUl=false;} if(inOl){result.push('</ol>');inOl=false;} }
  function closeBq() { if(inBq){result.push('</blockquote>');inBq=false;} }
  for (var i=0; i<lines.length; i++) {
    var line = lines[i];
    // Headings
    if (/^###### (.+)/.test(line)) { closeLists(); closeBq(); result.push('<h6>'+line.replace(/^###### /,'')+'</h6>'); }
    else if (/^##### (.+)/.test(line)) { closeLists(); closeBq(); result.push('<h5>'+line.replace(/^##### /,'')+'</h5>'); }
    else if (/^#### (.+)/.test(line)) { closeLists(); closeBq(); result.push('<h4>'+line.replace(/^#### /,'')+'</h4>'); }
    else if (/^### (.+)/.test(line)) { closeLists(); closeBq(); result.push('<h3>'+line.replace(/^### /,'')+'</h3>'); }
    else if (/^## (.+)/.test(line)) { closeLists(); closeBq(); result.push('<h2>'+line.replace(/^## /,'')+'</h2>'); }
    else if (/^# (.+)/.test(line)) { closeLists(); closeBq(); result.push('<h1>'+line.replace(/^# /,'')+'</h1>'); }
    // Horizontal rule
    else if (/^---+$/.test(line.trim())) { closeLists(); closeBq(); result.push('<hr style="border:none;border-top:1px solid var(--border);margin:10px 0"/>'); }
    // Blockquote (escaped > becomes &gt;)
    else if (/^[&]gt; (.+)/.test(line)) { closeLists(); if(!inBq){result.push('<blockquote style="border-left:3px solid var(--accent);padding-left:12px;margin:8px 0;color:var(--text-secondary)">');inBq=true;} result.push('<p style="margin:2px 0">'+line.replace(/^[&]gt; /,'')+'</p>'); }
    // Unordered list
    else if (/^[\-*] (.+)/.test(line)) { closeBq(); if(inOl){result.push('</ol>');inOl=false;} if(!inUl){result.push('<ul>');inUl=true;} result.push('<li>'+line.replace(/^[\-*] /,'')+'</li>'); }
    // Ordered list
    else if (/^\d+\. (.+)/.test(line)) { closeBq(); if(inUl){result.push('</ul>');inUl=false;} if(!inOl){result.push('<ol>');inOl=true;} result.push('<li>'+line.replace(/^\d+\. /,'')+'</li>'); }
    // Empty line
    else if (line.trim()==='') { closeLists(); closeBq(); result.push(''); }
    // Already-processed HTML (code block placeholder, table, hr)
    else if (/^\u0000CODEBLOCK/.test(line) || /^<table/.test(line) || /^<hr/.test(line)) { closeLists(); closeBq(); result.push(line); }
    // Normal paragraph
    else { closeLists(); closeBq(); result.push('<p style="margin:4px 0">'+line+'</p>'); }
  }
  closeLists(); closeBq();
  var html = result.join('\n');
  // Inline formatting: bold, italic, inline code
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  var inlineCodeRe = new RegExp(BT+'([^'+BT+']+)'+BT, 'g');
  html = html.replace(inlineCodeRe, '<code style="background:var(--accent-bg);padding:1px 4px;border-radius:3px;font-size:12px">$1</code>');
  // Restore code blocks
  html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, function(m, idx) { return blocks[parseInt(idx)]; });
  return html;
}

$('createBtn').onclick = async () => { const name = $('projectName').value.trim(); const goal = $('goal').value.trim(); if (!name || !goal) { alert('请填写项目名称和目标'); return; } setBusy(true); try { const created = await post('/projects', { name, goal }); selectedId = created.project.id; $('projectName').value=''; $('goal').value=''; await loadProjects(); await selectProject(selectedId); } catch(e) { alert(e.message); } setBusy(false); };
const sidebar = document.getElementById('sidebar');
let sidebarCollapsed = false;
document.getElementById('newProjectBtn').onclick = () => { selectedId = null; history.replaceState(null, '', '#'); location.reload(); };
document.getElementById('sidebarToggle').onclick = () => { sidebarCollapsed = !sidebarCollapsed; if (sidebar) { sidebar.style.width = sidebarCollapsed ? '0px' : '240px'; } };
loadProjects().then(() => {
  // 从 URL hash 恢复选中的项目(刷新后保持原界面)
  const hashId = decodeURIComponent(location.hash.slice(1));
  if (hashId) selectProject(hashId);
});
