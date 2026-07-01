import { EventEmitter } from "node:events";

export interface ProjectEvent {
  type: string;
  project_id: string;
  at: string;
  payload?: unknown;
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  publish(event: ProjectEvent): void {
    this.emitter.emit(event.project_id, event);
    this.emitter.emit("*", event);
  }

  subscribe(projectId: string, listener: (event: ProjectEvent) => void): () => void {
    this.emitter.on(projectId, listener);
    return () => this.emitter.off(projectId, listener);
  }
}

export function projectEvent(type: string, projectId: string, payload?: unknown): ProjectEvent {
  return { type, project_id: projectId, at: new Date().toISOString(), payload };
}
