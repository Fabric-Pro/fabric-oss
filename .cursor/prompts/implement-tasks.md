# /implement-tasks - Implementation Workflow

> **Usage**: Copy this prompt or reference it with `@.cursor/prompts/implement-tasks.md`

---

## Workflow Instructions

You are implementing tasks from a tasks.md file following the Fabric workflow.

### PRE-REQUISITE: Detect Package Manager

Before any implementation, detect the project's package manager:

| Lock File | Package Manager | Commands |
|-----------|----------------|----------|
| `bun.lockb` | bun | `bun install`, `bun run`, `bunx` |
| `pnpm-lock.yaml` | pnpm | `pnpm install`, `pnpm run`, `pnpm dlx` |
| `yarn.lock` | yarn | `yarn install`, `yarn`, `yarn dlx` |
| `package-lock.json` | npm | `npm install`, `npm run`, `npx` |

Use the detected package manager for ALL commands.

### PHASE 1: Load Context

1. **Find tasks**: Load `tasks.md` from the relevant spec folder
2. **Read spec**: Load `spec.md` for detailed requirements
3. **Load standards**: Read all files in `fabric/standards/`
4. **Check requirements**: Read `planning/requirements.md`

### PHASE 2: Choose Task Group

Ask me which task group(s) to implement:

```
📋 Found [N] task groups in tasks.md:

1. [Group 1 Name] - [N tasks] - Dependencies: None
2. [Group 2 Name] - [N tasks] - Dependencies: Group 1
3. [Group 3 Name] - [N tasks] - Dependencies: Group 1
4. [Group 4 Name] - [N tasks] - Dependencies: Groups 2, 3

Which task group(s) should I implement?
- Enter group number(s): e.g., "1" or "1, 2"
- Enter "all" to implement all groups in order
```

### PHASE 3: Implement Tasks

For each task group, follow this workflow:

#### 3.1 Understand the Tasks
- Read the parent task and all subtasks
- Review acceptance criteria
- Check the spec for detailed requirements

#### 3.2 Plan the Implementation
- Identify files to create/modify
- Consider the order of changes
- Note any edge cases from the spec

#### 3.3 Write Tests First (TDD)
Following `fabric/standards/testing/`:
- Write failing tests for the expected behavior
- Cover happy path and edge cases
- Include error scenarios

#### 3.4 Implement the Code
Following project standards:
- Write minimal code to pass tests
- Follow patterns from `fabric/standards/`
- Keep functions small and focused
- Add proper error handling

#### 3.5 Verify & Refactor
- Run tests to ensure they pass
- Refactor for clarity
- Add necessary comments
- Check standards compliance

#### 3.6 Mark Tasks Complete
Update `tasks.md`:
- Change `- [ ]` to `- [x]` for completed tasks
- Add notes if needed

### PHASE 4: Report Progress

After completing each task group:

```
✅ Task Group [N] Complete: [Group Name]

COMPLETED TASKS:
- [x] [Task 1 description]
- [x] [Task 2 description]
- [x] [Task 3 description]

FILES CHANGED:
- src/lib/[file].ts (created)
- src/components/[file].tsx (created)
- tests/[file].test.ts (created)

TESTS:
- [N] tests passing
- Coverage: [X]%

NEXT: [Next task group or verification]
```

### PHASE 5: Final Verification

When all tasks are complete:

1. Run all tests: `[package-manager] test`
2. Run linting: `[package-manager] run lint`
3. Type check: `[package-manager] run type-check`
4. Build: `[package-manager] run build`

Report:
```
✅ All task groups implemented!

📊 SUMMARY:
- Task Groups: [N] complete
- Total Tasks: [N] complete
- Tests: [N] passing
- Build: ✅ Successful

NEXT STEP 👉 Review the implementation or run /verify-implementation
```

---

## Start Now

Ask me: **"Which spec's tasks should I implement?"** and list specs with tasks.md in `fabric/specs/`

