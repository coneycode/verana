import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

export interface CapabilityDecl {
  name: string;
  capabilities: string[];
}

export interface ProbeResult {
  available: boolean;
  command: string;
  reason?: string;
}

export interface AgentRun {
  claim: string;        // agent 的产出内容(stdout 正文)
  sessionId?: string;   // hermes session id(可用于 resume)
  exitCode: number;
  raw: string;          // 完整 stdout(调试用)
  hitMaxTurns?: boolean; // executor 是否因 max-turns 限制退出
}

export interface ExecutorAdapter {
  name: string;
  capabilities: CapabilityDecl;
  probe(): Promise<ProbeResult>;
  /** 在 workdir 启动 executor 跑一个重节点。prompt 是完整指令(含上下文)。返回 agent 产出 */
  execute(prompt: string, workdir: string, opts?: { maxTurns?: number; toolsets?: string[]; timeoutMs?: number; maxReruns?: number; onOutputLine?: (line: string) => void }): Promise<AgentRun>;
  /** 续接上次执行(resume)。用 session_id 恢复同一会话,给新的 max-turns */
  resume?(sessionId: string, workdir: string, opts: { maxTurns?: number; toolsets?: string[]; timeoutMs?: number; onOutputLine?: (line: string) => void }): Promise<AgentRun>;
}

export class HermesAdapter implements ExecutorAdapter {
  readonly name = "hermes";
  readonly capabilities: CapabilityDecl = {
    name: "hermes",
    capabilities: ["web", "browser", "long_running", "skills", "terminal", "file"],
  };

  constructor(private readonly command = "hermes") {}

  async probe(): Promise<ProbeResult> {
    if (this.command.includes("/")) {
      try {
        await access(this.command);
        return { available: true, command: this.command };
      } catch {
        return { available: false, command: this.command, reason: "command not found" };
      }
    }
    return { available: true, command: this.command, reason: "PATH lookup deferred to process spawn" };
  }

  async execute(prompt: string, workdir: string, opts: { maxTurns?: number; toolsets?: string[]; timeoutMs?: number; maxReruns?: number; onOutputLine?: (line: string) => void } = {}): Promise<AgentRun> {
    const maxReruns = opts.maxReruns ?? 3;
    let lastResult: AgentRun | null = null;

    for (let attempt = 0; attempt < maxReruns; attempt++) {
      lastResult = await this._executeOnce(prompt, workdir, opts);

      // 检测 429 限流:hermes 内部重试3次后放弃,raw 里有 RateLimitError / 429
      const hit429 = lastResult.raw.includes("RateLimitError")
        || lastResult.raw.includes("Rate limited after")
        || lastResult.raw.includes("HTTP 429");

      if (!hit429) return lastResult;

      // 429 命中:等 60s 再重跑整个 executor
      const isLast = attempt === maxReruns - 1;
      if (isLast) break;

      opts.onOutputLine?.(`⚠️ 429 限流,等待 60 秒后重试 executor (attempt ${attempt + 1}/${maxReruns})...`);
      await new Promise(r => setTimeout(r, 60_000));
    }

    return lastResult!;
  }

  private async _executeOnce(prompt: string, workdir: string, opts: { maxTurns?: number; toolsets?: string[]; timeoutMs?: number; maxReruns?: number; onOutputLine?: (line: string) => void }): Promise<AgentRun> {
    const maxTurns = opts.maxTurns ?? 90;
    const timeoutMs = opts.timeoutMs ?? 600_000;
    const toolsets = opts.toolsets ?? ["web"];
    const onOutputLine = opts.onOutputLine;

    const args = [
      "chat",
      "-q", prompt,
      "--max-turns", String(maxTurns),
      "-t", toolsets.join(","),
      "--yolo",  // 无人值守:跳过命令审批,避免 curl 等命令被拦截超时
      // 不加 -Q:保留工具调用过程输出(web_search/browser 预览),实时推给前端
    ];

    return this._spawnHermes(args, workdir, timeoutMs, onOutputLine);
  }

  /** 续接上次执行:用 hermes --resume <session_id> 恢复同一会话 */
  async resume(sessionId: string, workdir: string, opts: { maxTurns?: number; toolsets?: string[]; timeoutMs?: number; onOutputLine?: (line: string) => void }): Promise<AgentRun> {
    const maxTurns = opts.maxTurns ?? 90;
    const timeoutMs = opts.timeoutMs ?? 600_000;
    const toolsets = opts.toolsets ?? ["web"];
    const onOutputLine = opts.onOutputLine;

    const args = [
      "--resume", sessionId,
      "-q", "继续执行。完成上次未完成的工作,把产出写入指定文件。",
      "--max-turns", String(maxTurns),
      "-t", toolsets.join(","),
      "--yolo",
    ];

    return this._spawnHermes(args, workdir, timeoutMs, onOutputLine);
  }

  /** 共用的 spawn + stdout 解析逻辑 */
  private async _spawnHermes(args: string[], workdir: string, timeoutMs: number, onOutputLine?: (line: string) => void): Promise<AgentRun> {
    return new Promise<AgentRun>((resolve) => {
      const child = spawn(this.command, args, {
        cwd: workdir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HERMES_NO_COLOR: "1", HERMES_QUIET: "0" },
      });

      let stdout = "";
      let stderr = "";
      let remainingTimeout = timeoutMs;
      let timer: NodeJS.Timeout;

      // 检测到 429 sleep 时延长 timeout
      const scheduleTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const elapsed = Math.round((timeoutMs - remainingTimeout) / 1000);
          console.error(`[executor] timeout after ${elapsed}s (remaining ${Math.round(remainingTimeout / 1000)}s), killing PID ${child.pid}`);
          child.kill("SIGTERM");
          setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 100);
        }, remainingTimeout);
      };
      scheduleTimeout();

      // 实时推送 stdout 的每一行(hermes 工具调用过程 + 最终输出)
      let stdoutBuffer = "";
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";  // 最后一段留在 buffer
        for (const line of lines) {
          stdout += line + "\n";
          // 实时推给前端(通过 callback,由 graph-engine 接 bus.publish)
          onOutputLine?.(line);
          // 检测 429 限流:hermes 自己 sleep 60 等待,延长 timeout
          if (line.includes("429") || line.includes("RateLimit") || line.includes("Rate limited") || line.includes("sleep 60")) {
            remainingTimeout += 90_000;  // 给 90 秒余量(60s sleep + 30s 恢复)
            scheduleTimeout();
            onOutputLine?.(`⏱️ 检测到 429 限流,timeout 已延长至 ${Math.round(remainingTimeout / 1000)}s`);
          }
        }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

      child.on("close", (code) => {
        clearTimeout(timer);
        console.error(`[executor] close: code=${code}, stdout=${stdout.length} bytes, pid=${child.pid}`);
        if (stdoutBuffer) { stdout += stdoutBuffer; onOutputLine?.(stdoutBuffer); }
        // 解析:第一行通常是 "session_id: xxx",其余是正文
        const lines = stdout.split("\n");
        let sessionId: string | undefined;
        let claimStart = 0;
        if (lines[0]?.startsWith("session_id:")) {
          sessionId = lines[0].slice("session_id:".length).trim();
          claimStart = 1;
          while (claimStart < lines.length && lines[claimStart].trim() === "") claimStart++;
        }

        // 从 stdout 里提取 session_id(Resume this session with: hermes --resume <id>)
        if (!sessionId) {
          const resumeMatch = stdout.match(/hermes --resume (\S+)/);
          if (resumeMatch) sessionId = resumeMatch[1];
        }

        // 检测 max-turns hit:hermes 输出里有 "max.*turn" 或 "turn.*limit" 或 "Max turns"
        const hitMaxTurns = /max.*turn|turn.*limit|Max turns|reached.*turn/i.test(stdout)
          || stdout.includes("Messages:") && stdout.includes("tool calls")  // 退化检测:有消息和工具调用但没有 hermes 块
          || code === null;  // 被 signal kill(timeout 或其他原因)——也视为未正常完成

        // 从 stdout 提取 hermes 的最终文字输出(╭─ ⚕ Hermes ─ 块)
        // 工具调用日志(┊ 开头)不进 claim,留在 raw/stdream 里
        const hermesBlocks: string[] = [];
        let inBlock = false;
        let blockContent: string[] = [];
        for (const line of lines.slice(claimStart)) {
          // 进入 hermes 输出块
          if (line.includes("⚕ Hermes")) {
            inBlock = true;
            blockContent = [];
            continue;
          }
          if (inBlock) {
            // 块结束标记(╰ 开头)
            if (line.startsWith("╰") || (line.startsWith("─") && line.length > 10)) {
              hermesBlocks.push(blockContent.join("\n").trim());
              inBlock = false;
              continue;
            }
            blockContent.push(line);
          }
        }

        // claim = hermes 的最终文字输出;如果没有 hermes 块(非交互模式/异常),降级用全部 stdout
        let claim: string;
        if (hermesBlocks.length > 0) {
          claim = hermesBlocks.join("\n\n").trim();
        } else {
          // 降级:去掉工具日志行(┊ 开头),保留其余
          claim = lines.slice(claimStart)
            .filter(l => !l.trim().startsWith("┊") && !l.includes("BLOCKED:") && !l.includes("Timeout — denying"))
            .join("\n")
            .trim();
        }

        resolve({
          claim,
          sessionId,
          exitCode: code ?? 0,
          raw: stdout,
          hitMaxTurns,
        } as AgentRun & { hitMaxTurns: boolean });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          claim: "",
          exitCode: -1,
          raw: stderr + "\nspawn error: " + err.message,
        });
      });
    });
  }
}

export function selectExecutor(required: string[], adapters: ExecutorAdapter[]): ExecutorAdapter | null {
  return adapters.find((adapter) => required.every((capability) => adapter.capabilities.capabilities.includes(capability))) ?? null;
}
