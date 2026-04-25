# ADR-001: TitanShift to OpenCode Migration Architecture

## Status

Accepted

## Decision

Use OpenCode as execution core and keep TitanShift UI contracts via a compatibility shim service.

## Why

- OpenCode has stronger session/runtime model and active route/test surface.
- TitanShift UI already captures target workflows and should remain mostly unchanged.
- A shim avoids deep OpenCode forks and allows iterative migration.

## Target architecture

- UI: TitanShift UI components (ported/adapted) calling stable TitanShift-like endpoints.
- API Shim: Fastify service translating TitanShift contracts to OpenCode routes and state.
- Engine: OpenCode server process/API.
- Stores: shim state for tasks/scheduler mappings and explicit run metadata.

## Non-goals

- Re-implementing OpenCode orchestration internals.
- Forking OpenCode route internals unless no extension point exists.

## Reliability controls

- Boundary validation for tool calls and arguments.
- Side-effect evidence checks for file mutation tasks.
- Explicit run_id/task_id lifecycle and status transitions.
- Timeout/cancel behavior surfaced in API and tests.

## Phase acceptance criteria

### Phase 1

- Shim boots and health endpoint is live.
- OpenCode base is present in workspace.
- Chat and task API contracts compile and pass unit/integration tests.

### Phase 2

- POST /chat creates task and returns stable payload.
- GET /tasks and GET /tasks/:id reflect state transitions.
- POST /tasks/:id/cancel invokes OpenCode abort and records cancellation.

## Verification commands

- npm test
- npm run build
