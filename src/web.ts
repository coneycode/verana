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
    @keyframes spin { to { transform: rotate(360deg); } }
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
    .step.viewing { color:#c4b5fd; border-bottom-color:#a78bfa; font-weight:700; cursor:pointer; }
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
  <header><div style="display:flex;align-items:center;gap:8px"><button id="sidebarToggle" style="padding:4px 8px;font-size:14px;cursor:pointer;border:1px solid var(--border);background:var(--panel);color:var(--text);border-radius:4px">&#9776;</button><h1>Verana</h1></div><div class="muted" id="connection">SSE: idle</div><div id="llmStatusBar" style="display:none;align-items:center;gap:6px;padding:2px 8px;background:#1a1f2e;border:1px solid #3b82f6;border-radius:4px;font-size:12px;color:#93c5fd"><span style="display:inline-block;width:10px;height:10px;border:2px solid #3b82f6;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite"></span><span class="llm-status-text">LLM</span></div></header>
  <main>
    <section id="sidebar" style="width:240px; border-right:1px solid var(--border); display:flex; flex-direction:column; transition: width 0.2s; overflow:hidden;">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">Projects <button id="newProjectBtn" style="font-size:11px;padding:2px 8px;border:1px solid var(--border);background:var(--panel);color:var(--text);border-radius:4px;cursor:pointer">新建</button></div>
      <div id="projects" style="flex:1; overflow-y:auto; padding:8px;"></div>
    </section>
    <section style="display:flex; flex-direction:column;">
      <div id="empty" class="body" style="flex:1; overflow-y:auto; padding:20px; max-width:640px; margin:0 auto;">
        <div class="guide">
          <div class="guide-title">创建项目</div>
          <div class="guide-desc">输入项目名称和目标,系统会通过澄清、规划、执行帮你完成。</div>
          <div style="margin-top:12px">
            <div class="muted" style="margin-bottom:4px">项目名称</div>
            <input id="projectName" placeholder="例如:海外红人监控系统调研" style="width:100%; padding:8px; margin-bottom:10px; background:var(--panel); border:1px solid var(--border); color:var(--text); border-radius:4px;" />
            <div class="muted" style="margin-bottom:4px">项目目标</div>
            <textarea id="goal" placeholder="详细描述目标,例如:调研海外红人监控系统,了解有哪些方案、功能、价格" style="min-height:80px; width:100%; background:var(--panel); border:1px solid var(--border); color:var(--text); border-radius:4px; padding:8px;"></textarea>
            <button id="createBtn" style="margin-top:8px;">创建项目</button>
          </div>
        </div>
      </div>
      <div id="detail" style="display:none; flex:1; overflow-y:auto; padding:14px;">
        <div class="steps" id="steps"></div>
        <div id="mainArea"></div>
        <details style="margin-top:14px;"><summary class="muted" style="cursor:pointer;padding:6px;">原始状态 JSON</summary><pre id="statusBox"></pre></details>
      </div>
    </section>
  </main>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script src="/app.js"></script>
</body>
</html>`;
}
