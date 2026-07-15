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
}

export interface ExecutorAdapter {
  name: string;
  capabilities: CapabilityDecl;
  probe(): Promise<ProbeResult>;
  /** 在 workdir 启动 executor 跑一个重节点。prompt 是完整指令(含上下文)。返回 agent 产出 */
  execute(prompt: string, workdir: string, opts?: { maxTurns?: number; toolsets?: string[]; timeoutMs?: number; onOutputLine?: (line: string) => void }): Promise<AgentRun>;
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

  async execute(prompt: string, workdir: string, opts: { maxTurns?: number; toolsets?: string[]; timeoutMs?: number; onOutputLine?: (line: string) => void } = {}): Promise<AgentRun> {
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

    return new Promise<AgentRun>((resolve) => {
      const child = spawn(this.command, args, {
        cwd: workdir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HERMES_NO_COLOR: "1", HERMES_QUIET: "0" },
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        try { child.kill("SIGKILL"); } catch {}
      }, timeoutMs);

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
        }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

      child.on("close", (code) => {
        clearTimeout(timer);
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
        });
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
