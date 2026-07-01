# Verana

Verana v2 is a project-based Agent Workflow delivery scaffold.

Current MVP scope: solution-delivery loop only.

Flow:

1. `new` creates a project directory and file-backed state.
2. `clarify` / `input` records goal clarification with risk disclosure.
3. `plan` composes a solution workflow, project agents, skills, and self-check report.
4. `approve <gate>` opens the execution gate.
5. `run` executes the local MVP solution DAG and writes claim/verdict logs.
6. `approve final_review` closes the solution workflow.

## Commands

```sh
npm install
npm test
npm run typecheck
npm run build

cp verana.config.example.yaml verana.config.yaml  # then fill in your models + keys

npm run cli -- new "调研海外红人监控系统"
npm run cli -- list
npm run cli -- status <project-id>
npm run cli -- clarify <project-id>
npm run cli -- input <project-id> "交付调研方案"
npm run cli -- plan <project-id>
npm run cli -- approve <project-id> plan_review --note "任务拆解通过"
npm run cli -- run <project-id>
npm run cli -- logs <project-id> run-0001
npm run cli -- approve <project-id> final_review --note "方案闭环"
```

## Server

```sh
npm run server
```

First copy `verana.config.example.yaml` to `verana.config.yaml` and fill in your
composer/evaluator models (OpenAI-compatible API). Then:

REST/SSE skeleton:

- `POST /projects`
- `GET /projects`
- `GET /projects/:id`
- `GET /projects/:id/events`

## Design Source Of Truth

See `docs/design/v2-orchestration-design.md`.

Per `AGENTS.md`: before changing code, inspect the design-doc git diff/log first.
