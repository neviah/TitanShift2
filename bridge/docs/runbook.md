# Local Runbook

## Prerequisites

- Node.js 20+
- OpenCode server reachable (default http://127.0.0.1:4096)

## Start

1. Install dependencies:
   npm install
2. Start bridge:
   npm run dev

## Validate

1. Health:
   curl http://127.0.0.1:8000/health
2. Chat:
   curl -X POST http://127.0.0.1:8000/chat -H "Content-Type: application/json" -d "{\"prompt\":\"Say hello\"}"
3. Tasks:
   curl http://127.0.0.1:8000/tasks
4. Workspace switch:
   curl -X POST http://127.0.0.1:8000/workspace/set-root -H "Content-Type: application/json" -d "{\"path\":\"D:/Projects/TitanShiftV2\"}"
5. Scheduler create:
   curl -X POST http://127.0.0.1:8000/scheduler/jobs -H "Content-Type: application/json" -d "{\"description\":\"Quick run\",\"schedule_type\":\"interval\",\"interval_seconds\":60,\"task_prompt\":\"say hello\"}"
6. Scheduler tick:
   curl -X POST http://127.0.0.1:8000/scheduler/tick
7. Settings update:
   curl -X POST http://127.0.0.1:8000/config -H "Content-Type: application/json" -d "{\"key\":\"model.default_backend\",\"value\":\"anthropic/claude-sonnet-4\"}"

## Troubleshooting

- If /chat fails with session_create_failed, confirm OpenCode server is running and accessible.
- If cancel fails, confirm returned task has output.session_id populated.
- If file-mutation integrity errors occur, inspect used_tools and created_paths/updated_paths in task output.
- If provider list is empty, check OpenCode server availability and verify OPENCODE_BASE_URL.
