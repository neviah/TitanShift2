# TitanShift OpenCode Bridge

Compatibility shim that preserves TitanShift UI-facing API behavior while delegating execution to OpenCode.

## Current slice

- Phase 1 foundation bootstrapped.
- Chat + Task create/status/cancel endpoints implemented.
- Chat streaming endpoint implemented with TitanShift-style SSE events.
- Workspace root switching implemented and enforced on adapter calls.
- Scheduler create/list/run/delete and tick endpoints implemented.
- TitanShift-compatible scheduler template-jobs and task-stacks endpoints implemented.
- Settings flow for model/provider defaults implemented.
- Reliability guardrails added at adapter execution boundary.

## Run

1. Install dependencies:
   npm install
2. Start service:
   npm run dev
3. Run tests:
   npm test

## Environment

- OPENCODE_BASE_URL: OpenCode server base URL. Default: http://127.0.0.1:4096
- PORT: Bridge API port. Default: 8000

## API (implemented now)

- GET /health
- POST /chat
- POST /chat/stream
- GET /tasks
- GET /tasks/:task_id
- POST /tasks/:task_id/cancel
- POST /runs
- GET /runs
- GET /runs/:run_id
- GET /workspace/info
- POST /workspace/set-root
- GET /config
- GET /config/providers
- POST /config
- GET /scheduler/jobs
- POST /scheduler/jobs
- DELETE /scheduler/jobs/:job_id
- POST /scheduler/jobs/:job_id/enabled
- POST /scheduler/jobs/:job_id/run
- GET /scheduler/template-jobs
- POST /scheduler/template-jobs
- DELETE /scheduler/template-jobs/:job_id
- GET /scheduler/task-stacks
- POST /scheduler/task-stacks
- DELETE /scheduler/task-stacks/:job_id
- POST /scheduler/tick

## Reliability controls

- Rejects invalid/empty chat payloads.
- Validates tool-call argument shape when present.
- Blocks successful file-mutation runs when no side-effect evidence exists.
- Assigns task_id and run_id for every chat execution.
- Tracks workspace_root per task and uses it in OpenCode calls.
- Enforces optional timeout for chat flows via `budget.max_duration_ms`.
- Exposes run status introspection through `/runs` endpoints.

## Deterministic smoke checks

- `test/reliability-filewrite.test.ts` validates file-write reliability guards:
   - fails if mutation tools are reported but no paths are provided
   - fails if paths are reported but files do not exist
   - passes only when filesystem side effects are verifiably present

## Streaming events

`/chat/stream` emits `data: {json}\n\n` SSE frames with event types:

- `start`
- `text_delta`
- `done`
- `error`
- `eof`
