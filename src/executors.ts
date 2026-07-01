import { access } from "node:fs/promises";

export interface CapabilityDecl {
  name: string;
  capabilities: string[];
}

export interface ProbeResult {
  available: boolean;
  command: string;
  reason?: string;
}

export interface ExecutorAdapter {
  name: string;
  capabilities: CapabilityDecl;
  probe(): Promise<ProbeResult>;
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
}

export function selectExecutor(required: string[], adapters: ExecutorAdapter[]): ExecutorAdapter | null {
  return adapters.find((adapter) => required.every((capability) => adapter.capabilities.capabilities.includes(capability))) ?? null;
}
