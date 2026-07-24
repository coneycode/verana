# Verana

Verana v2 is a project-based Agent Workflow delivery scaffold.

Current scope: solution-delivery loop (clarify → compose → execute → verify → gate).

Status: v2 graph workflow implementation is active. The dynamic scheduler, event-log timeline, verdict-driven progress truth, diagnostician failure attribution (A-F), artifact contract (collect/freeze/validate), materializer (scheduler-decided), plan self-check loop, Hermes executor path, and Web/SSE control plane (unnamed event, onmessage dispatch) are implemented and being refined.

## Quick Start

```sh
npm install
npm test
npm run typecheck

cp verana.config.example.yaml verana.config.yaml  # fill in your models + keys

# CLI
npm run cli -- new "调研海外红人监控系统"
npm run cli -- list
npm run cli -- clarify <project-id>
npm run cli -- input <project-id> "自研系统，覆盖数据源和合规"
npm run cli -- plan <project-id>
npm run cli -- approve <project-id> plan_review --note "通过"
npm run cli -- run <project-id>
npm run cli -- logs <project-id> run-0001
npm run cli -- approve <project-id> final_review --note "方案闭环"

# Server (Fastify + SSE + Web UI)
VERANA_ROOT=~/verana-data npm run server
# -> open http://127.0.0.1:3317
```

## Configuration

verana.config.yaml (gitignored). Two model roles, must be different models:

```yaml
composer:
  base_url: "http://your-gateway/anthropic"
  model: "ppio/pa/claude-opus-4-8"
  api_key: "sk-xxx"

evaluator:
  base_url: "http://your-gateway/anthropic"
  model: "pa/claude-sonnet-5"
  api_key: "sk-xxx"
```

LLM client uses Anthropic native Messages API (/v1/messages, x-api-key, anthropic-version).
To switch to OpenAI-compatible API, replace HttpLlmClient in llm.ts.

## REST API

- POST /projects — create project
- GET /projects — list all
- GET /projects/:id — get state
- DELETE /projects/:id — delete project
- POST /projects/:id/clarify-batch — generate clarification questions
- POST /projects/:id/clarify-answer — submit clarification answers
- POST /projects/:id/plan — compose graph workflow (SSE progress)
- GET /projects/:id/workflow — get current plan_review workflow spec
- PUT /projects/:id/workflow — edit plan_review workflow spec
- POST /projects/:id/approve — approve a gate
- POST /projects/:id/reject — reject a gate (bounce)
- POST /projects/:id/run — execute graph workflow
- POST /projects/:id/human-verdict — resolve human-review stop
- POST /projects/:id/rerun-from — reset and rerun from a phase
- GET /projects/:id/timeline — rebuild timeline from events.log
- GET /projects/:id/runs/:run — get claim, verdict, and stream log
- GET /projects/:id/runs/:run/stream — get run stream log only
- GET /projects/:id/deliverables — list markdown deliverables
- GET /projects/:id/deliverables/export — export deliverables as one markdown file
- GET /projects/:id/events — SSE event stream

## Design Source Of Truth

docs/design/v2-orchestration-design.md — see Appendix B for implementation status.

Per AGENTS.md: before changing code, inspect the design-doc git diff/log first.

## License

Verana is licensed under the PolyForm Noncommercial License 1.0.0. You may use it for free for noncommercial purposes, but commercial use is not allowed except for the limited evaluation periods described in [LICENSE](LICENSE).
