# /orchestrate-tasks - Task Orchestration Workflow

> **Usage**: Copy this prompt or reference it with `@.cursor/prompts/orchestrate-tasks.md`

---

## Workflow Instructions

You are planning the implementation strategy for a set of tasks.

### PHASE 1: Load Context

1. **Find tasks**: Load `tasks.md` from the spec folder
2. **Read spec**: Load `spec.md` for context
3. **Load standards**: Read files in `fabric/standards/`

### PHASE 2: Analyze Task Groups

For each task group, identify:
- **Specialist type**: Which agent is best suited (backend, frontend, etc.)
- **Relevant standards**: Which standards files apply
- **Dependencies**: What must be completed first

### PHASE 3: Create Orchestration Plan

Create `orchestration.yml` in the spec folder:

```yaml
# Orchestration Plan: [Feature Name]
# Generated: YYYY-MM-DD

spec_folder: fabric/specs/YYYY-MM-DD-feature-name/

task_groups:
  - name: database-setup
    description: Create database schema and migrations
    assigned_specialist: backend-specialist
    dependencies: []
    standards:
      - fabric/standards/backend/models.md
      - fabric/standards/backend/migrations.md
      - fabric/standards/global/conventions.md
    estimated_time: 2h

  - name: api-endpoints
    description: Implement REST API endpoints
    assigned_specialist: backend-specialist
    dependencies:
      - database-setup
    standards:
      - fabric/standards/backend/api.md
      - fabric/standards/global/error-handling.md
      - fabric/standards/global/validation.md
    estimated_time: 4h

  - name: frontend-ui
    description: Build UI components and pages
    assigned_specialist: frontend-specialist
    dependencies:
      - api-endpoints
    standards:
      - fabric/standards/frontend/components.md
      - fabric/standards/frontend/css.md
      - fabric/standards/frontend/accessibility.md
    estimated_time: 4h

  - name: testing
    description: Write unit and integration tests
    assigned_specialist: test-specialist
    dependencies:
      - api-endpoints
      - frontend-ui
    standards:
      - fabric/standards/testing/test-writing.md
    estimated_time: 3h

execution_order:
  - parallel: [database-setup]
  - parallel: [api-endpoints]
  - parallel: [frontend-ui]
  - parallel: [testing]

total_estimated_time: 13h
```

### PHASE 4: Generate Implementation Prompts

Create `implementation/prompts/` folder with one file per task group:

```markdown
# Implementation: [Task Group Name]

## Context
- **Spec**: @fabric/specs/YYYY-MM-DD-feature/spec.md
- **Tasks**: @fabric/specs/YYYY-MM-DD-feature/tasks.md (Task Group N)
- **Standards**: [List from orchestration.yml]

## Instructions

Follow the @.cursor/rules/[specialist].mdc agent guidelines.

### Your Task Group
[Paste the specific task group from tasks.md]

### Required Standards
Read and follow these standards:
- @fabric/standards/[path1].md
- @fabric/standards/[path2].md

### Workflow
1. Read the spec section related to these tasks
2. Analyze existing codebase patterns
3. Write tests first (TDD)
4. Implement the code
5. Verify against acceptance criteria
6. Mark tasks complete in tasks.md with [x]

### Completion
When done:
- All tests passing
- Tasks marked complete in tasks.md
- Code follows all standards
```

### PHASE 5: Summary

```
✅ Orchestration complete!

📁 Created:
├── orchestration.yml          - Coordination plan
└── implementation/
    └── prompts/
        ├── 1-database-setup.md
        ├── 2-api-endpoints.md
        ├── 3-frontend-ui.md
        └── 4-testing.md

EXECUTION PLAN:
┌─────────────────────────────────────────────────┐
│ Step 1: database-setup (backend-specialist)     │
│    ↓                                            │
│ Step 2: api-endpoints (backend-specialist)      │
│    ↓                                            │
│ Step 3: frontend-ui (frontend-specialist)       │
│    ↓                                            │
│ Step 4: testing (test-specialist)               │
└─────────────────────────────────────────────────┘

TOTAL ESTIMATED TIME: [X]h

HOW TO IMPLEMENT:
Option A: Run /implement-tasks for guided implementation
Option B: Open each prompt file and follow instructions

NEXT STEP 👉 Run /implement-tasks to start implementation
```

---

## Start Now

Ask me: **"Which spec should I create an orchestration plan for?"** and list specs with tasks.md

