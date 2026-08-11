export function renderHomePage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Verana</title>
  <style>
    :root {
      --bg: #f8f7f5;
      --bg-elevated: #ffffff;
      --surface: #ffffff;
      --surface-hover: #f3f1ef;
      --border: rgba(82,82,91,0.12);
      --border-strong: rgba(82,82,91,0.2);
      --text: #3f3f46;
      --text-secondary: #71717a;
      --text-muted: #a1a1aa;
      --accent: #7c6cf0;
      --accent-hover: #6d5ee8;
      --accent-bg: rgba(124,108,240,0.08);
      --ok: #16a34a;
      --ok-bg: rgba(22,163,74,0.08);
      --warn: #d97706;
      --warn-bg: rgba(217,119,6,0.08);
      --bad: #dc2626;
      --bad-bg: rgba(220,38,38,0.08);
      --radius: 10px;
      --radius-sm: 6px;
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.04);
      --shadow: 0 2px 8px rgba(0,0,0,0.06);
      --shadow-lg: 0 8px 24px rgba(0,0,0,0.08);
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
    @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    body {
      font: 14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
      background: var(--bg); color: var(--text);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    header {
      display:flex; justify-content:space-between; align-items:center;
      padding: 10px 16px;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border);
      height: 48px;
    }
    header h1 { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
    main { display:grid; grid-template-columns: 260px 1fr; gap:0; height: calc(100vh - 48px); }
    .section-title {
      padding: 10px 12px;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border);
      color: var(--text-secondary);
      font-weight: 500; font-size: 12px;
      text-transform: uppercase; letter-spacing: 0.05em;
    }
    .body { padding: 16px; overflow-y:auto; }
    .stack { display:flex; flex-direction:column; gap:8px; }
    .row { display:flex; gap:8px; align-items:center; }
    input, textarea, button {
      font: inherit; border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--surface); color: var(--text);
      transition: all 0.15s ease;
    }
    textarea { width:100%; min-height:64px; padding:10px; resize:vertical; }
    textarea:focus, input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-bg); }
    input { width:100%; padding:8px 12px; }
    button {
      padding: 7px 14px; cursor:pointer; font-weight: 500; font-size: 13px;
      background: var(--surface); border: 1px solid var(--border);
    }
    button:hover { background: var(--surface-hover); border-color: var(--border-strong); }
    button:active { transform: translateY(1px); }
    button:disabled { opacity:0.35; cursor:not-allowed; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
    button.secondary { background: transparent; }
    button.good { background: var(--ok); border-color: var(--ok); color: #fff; }
    button.bad { background: var(--bad); border-color: var(--bad); color: #fff; }
    .project {
      padding: 10px 12px; border-radius: var(--radius); margin-bottom: 4px;
      background: var(--surface); cursor:pointer;
      transition: all 0.15s ease;
      border: 1px solid transparent;
    }
    .project:hover { background: var(--surface-hover); }
    .project.active { background: var(--accent-bg); border-color: var(--accent); }
    .muted { color: var(--text-muted); font-size: 12px; }
    .pill {
      display:inline-flex; padding: 2px 8px; border-radius: 999px;
      background: var(--surface-hover); color: var(--text-secondary);
      font-size: 11px; font-weight: 500;
    }
    .pill.ok { background: var(--ok-bg); color: var(--ok); }
    .pill.warn { background: var(--warn-bg); color: var(--warn); }
    .pill.run { background: var(--accent-bg); color: var(--accent); }
    .pill.bad { background: var(--bad-bg); color: var(--bad); }
    .steps { display:flex; gap:0; margin-bottom:16px; overflow-x:auto; }
    .step {
      flex:1; min-width:80px; padding:10px 8px; text-align:center;
      font-size:12px; color: var(--text-muted);
      border-bottom: 2px solid var(--border);
      transition: all 0.2s ease;
    }
    .step.done { color: var(--ok); border-bottom-color: var(--ok); }
    .step.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
    .step.viewing { color: var(--accent-hover); border-bottom-color: var(--accent-hover); font-weight: 600; cursor:pointer; }
    .step-num {
      display:inline-flex; align-items:center; justify-content:center;
      width:20px; height:20px; border-radius:50%;
      background: var(--surface-hover); color: var(--text-muted);
      margin-right:6px; font-size:11px; font-weight: 500;
    }
    .step.done .step-num { background: var(--ok-bg); color: var(--ok); }
    .step.active .step-num { background: var(--accent-bg); color: var(--accent); }
    .guide {
      padding: 20px; border-radius: var(--radius);
      background: var(--surface); margin-bottom: 16px;
      box-shadow: var(--shadow-sm);
    }
    .guide-title { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
    .guide-desc { font-size: 14px; color: var(--text-secondary); margin-bottom: 12px; line-height: 1.6; }
    .risk-box {
      padding: 10px 12px; border-radius: var(--radius-sm);
      background: var(--warn-bg); color: var(--warn);
      font-size: 13px; margin: 8px 0;
    }
    .qa-item { padding: 10px 0; border-bottom: 1px solid var(--border); }
    .qa-q { font-weight: 500; color: var(--text); font-size: 13px; }
    .qa-a { color: var(--text-secondary); font-size: 14px; margin-top: 4px; }
    pre {
      white-space:pre-wrap; word-break:break-word;
      background: var(--bg); border-radius: var(--radius);
      padding: 14px; margin:0;
      color: var(--text); font-size: 13px; overflow:auto;
      font-family: ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
    }
    .task-card {
      padding: 12px; border-radius: var(--radius); margin-bottom: 6px;
      cursor:pointer; transition: all 0.15s ease;
      background: var(--surface);
      border: 1px solid var(--border);
    }
    .task-card:hover { background: var(--surface-hover); border-color: var(--border-strong); }
    .task-card.selected { border-color: var(--accent); background: var(--accent-bg); }
    .task-row { display:flex; justify-content:space-between; align-items:center; }
    .task-desc { margin: 6px 0; font-size: 13px; color: var(--text-secondary); }
    .task-meta { font-size: 12px; color: var(--text-muted); }
    .exec-layout { display:grid; grid-template-columns: 280px 1fr; gap:16px; height:100%; }
    .exec-left { overflow-y:auto; }
    .exec-right { overflow-y:auto; }
    .stream-box {
      background: var(--bg); border-radius: var(--radius);
      padding: 14px; font-size: 13px;
      white-space:pre-wrap; word-break:break-word;
      min-height: 200px; max-height: calc(100vh - 280px); overflow:auto;
      font-family: ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
    }
    .stream-status { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
    .live-feed {
      background: var(--bg); border-radius: var(--radius);
      padding: 12px; font-size: 13px;
      min-height: 200px; max-height: calc(100vh - 280px); overflow:auto;
      font-family: ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
    }
    .live-feed .step-line { color: var(--accent-hover); padding: 3px 0; border-bottom: 1px solid var(--border); }
    .live-feed .llm-line { color: var(--text); padding: 0; white-space:pre-wrap; word-break:break-word; }
    .live-feed .meta-line { color: var(--text-muted); padding: 2px 0; }
    .live-feed .feed-ts { color: var(--text-muted); font-size: 11px; margin-right: 6px; }
    .mermaid { background: var(--bg-elevated); border-radius: var(--radius); padding: 16px; }
    .mermaid .node.passed { fill: #f0fdf4 !important; stroke: var(--ok) !important; }
    .mermaid .node.failed { fill: #fef2f2 !important; stroke: var(--bad) !important; }
    .mermaid .node.running { fill: #fffbeb !important; stroke: var(--warn) !important; stroke-width: 2px !important; }
    .mermaid .node.entry { stroke: var(--accent) !important; stroke-width: 2px !important; }
    /* timeline blocks */
    .tl-block {
      border-radius: var(--radius); margin-bottom: 8px;
      overflow: hidden; animation: fadeIn 0.2s ease;
      background: var(--surface);
      border: 1px solid var(--border);
    }
    .tl-head {
      padding: 10px 14px; cursor: pointer;
      display: flex; align-items: center; gap: 8px;
      transition: background 0.15s ease;
    }
    .tl-head:hover { background: var(--surface-hover); }
    .tl-body {
      padding: 10px 14px;
      border-top: 1px solid var(--border);
    }
    .tl-reason { color: var(--text-muted); font-size: 13px; margin-bottom: 6px; }
    .tl-llm {
      background: var(--bg); border-radius: var(--radius-sm);
      padding: 10px; margin-bottom: 6px;
      max-height: 300px; overflow: auto;
      font-size: 13px; white-space: pre-wrap; word-break: break-word;
      color: var(--text-secondary);
      font-family: ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
    }
    /* LLM status indicator */
    .llm-indicator {
      display: flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 999px;
      background: var(--accent-bg); font-size: 12px; color: var(--accent);
    }
    .llm-dot {
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      background: var(--accent); animation: pulse 1.5s ease-in-out infinite;
    }
    /* scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(82,82,91,0.15); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(82,82,91,0.25); }
    /* chat bubbles */
    .chat-box { max-width:640px; margin:0 auto; display:flex; flex-direction:column; gap:12px; }
    .chat-msg { display:flex; gap:8px; max-width:80%; animation: fadeIn 0.2s ease; }
    .chat-msg.assistant { align-self: flex-start; }
    .chat-msg.user { align-self: flex-end; flex-direction: row-reverse; }
    .chat-bubble { padding: 10px 14px; border-radius: var(--radius); font-size: 14px; line-height: 1.6; }
    .chat-msg.assistant .chat-bubble { background: var(--surface); color: var(--text); }
    .chat-msg.user .chat-bubble { background: var(--accent-bg); color: var(--text); }
    .chat-input-row { display:flex; gap:8px; margin-top:8px; }
    .chat-input-row input { flex:1; }
    /* clarify conclusions card */
    .clarify-card { padding:20px; border-radius:var(--radius); background:var(--surface); box-shadow:var(--shadow); margin-top:12px; animation:fadeIn 0.3s ease; }
    .clarify-card-title { font-size:16px; font-weight:600; margin-bottom:12px; display:flex; align-items:center; gap:6px; }
    .clarify-item { padding:8px 0; border-bottom:1px solid var(--border); }
    .clarify-item:last-child { border-bottom:none; }
    .clarify-topic { font-weight:500; color:var(--accent); font-size:13px; margin-right:6px; }
    .clarify-conclusion { color:var(--text); font-size:14px; }
  </style>
</head>
<body>
  <header><div style="display:flex;align-items:center;gap:10px"><button id="sidebarToggle" style="padding:4px 8px;font-size:14px;cursor:pointer;background:transparent;border:none;color:var(--text-secondary)">&#9776;</button><h1>Verana</h1></div><div class="muted" id="connection">SSE: idle</div><div id="llmStatusBar" style="display:none;align-items:center;gap:6px" class="llm-indicator"><span class="llm-dot"></span><span class="llm-status-text">LLM</span></div></header>
  <main>
    <section id="sidebar" style="border-right:1px solid var(--border); display:flex; flex-direction:column; transition: width 0.2s; overflow:hidden; background:var(--bg-elevated);">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">Projects <button id="newProjectBtn" style="font-size:11px;padding:3px 8px;background:transparent;border:1px solid var(--border);color:var(--text-secondary)">新建</button></div>
      <div id="projects" style="flex:1; overflow-y:auto; padding:8px;"></div>
    </section>
    <section style="display:flex; flex-direction:column; overflow:hidden;">
      <div id="empty" class="body" style="flex:1; overflow-y:auto; padding:24px; max-width:640px; margin:0 auto;">
        <div class="guide">
          <div class="guide-title">创建项目</div>
          <div class="guide-desc">输入项目名称和目标,系统会通过澄清、规划、执行帮你完成。</div>
          <div style="margin-top:16px">
            <div class="muted" style="margin-bottom:6px">项目名称</div>
            <input id="projectName" placeholder="例如:海外红人监控系统调研" style="margin-bottom:12px" />
            <div class="muted" style="margin-bottom:6px">项目目标</div>
            <textarea id="goal" placeholder="详细描述目标,例如:调研海外红人监控系统,了解有哪些方案、功能、价格" style="min-height:80px"></textarea>
            <button id="createBtn" class="primary" style="margin-top:12px">创建项目</button>
          </div>
        </div>
      </div>
      <div id="detail" style="display:none; flex:1; overflow-y:auto; padding:16px;">
        <div class="steps" id="steps"></div>
        <div id="mainArea"></div>
        <details style="margin-top:16px;"><summary class="muted" style="cursor:pointer;padding:6px 0;">原始状态 JSON</summary><pre id="statusBox"></pre></details>
      </div>
    </section>
  </main>
<script src="https://unpkg.com/mermaid@11/dist/mermaid.min.js"></script>
<script src="/app.js"></script>
</body>
</html>`;
}
