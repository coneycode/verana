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
  execute(prompt: string, workdir: string, opts?: { maxTurns?: number; toolsets?: string[]; timeoutMs?: number }): Promise<AgentRun>;
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

  async execute(prompt: string, workdir: string, opts: { maxTurns?: number; toolsets?: string[]; timeoutMs?: number } = {}): Promise<AgentRun> {
    const maxTurns = opts.maxTurns ?? 90;  // hermes 默认 90,不压低
    const timeoutMs = opts.timeoutMs ?? 600_000;  // 10 分钟
    const toolsets = opts.toolsets ?? ["web"];

    const args = [
      "chat",
      "-q", prompt,
      "-Q",                         // 安静模式:只输出最终响应 + session info
      "--max-turns", String(maxTurns),
      "-t", toolsets.join(","),
    ];

    return new Promise<AgentRun>((resolve) => {
      const child = spawn(this.command, args, {
        cwd: workdir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HERMES_NO_COLOR: "1" },
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        try { child.kill("SIGKILL"); } catch {}
      }, timeoutMs);

      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

      child.on("close", (code) => {
        clearTimeout(timer);
        // 解析:第一行通常是 "session_id: xxx",其余是正文
        const lines = stdout.split("\n");
        let sessionId: string | undefined;
        let claimStart = 0;
        if (lines[0]?.startsWith("session_id:")) {
          sessionId = lines[0].slice("session_id:".length).trim();
          claimStart = 1;
          // 跳过空行
          while (claimStart < lines.length && lines[claimStart].trim() === "") claimStart++;
        }
        const claim = lines.slice(claimStart).join("\n").trim();
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
