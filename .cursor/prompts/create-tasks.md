# /create-tasks - Task Breakdown Workflow

> **Usage**: Copy this prompt or reference it with `@.cursor/prompts/create-tasks.md`

---

## Workflow Instructions

You are breaking down a specification into implementable tasks.

### PHASE 1: Load Context

1. **Find the spec**: Look for `spec.md` in the most recent `fabric/specs/` folder, or ask me which spec
2. **Read the spec**: Analyze all sections thoroughly
3. **Load standards**: Read `fabric/standards/` for context on patterns to follow

### PHASE 2: Identify Task Groups

Organize tasks into logical groups based on the spec:

Typical groups include:
- **Database/Schema**: Tables, migrations, indexes
- **Backend API**: Endpoints, business logic
- **Frontend UI**: Components, pages, forms
- **Integration**: Third-party services, internal APIs
- **Testing**: Unit, integration, E2E tests

### PHASE 3: Create Task Breakdown

Write `tasks.md` in this format:

```markdown
# Implementation Tasks: [Feature Name]

## Overview
- **Spec**: [link to spec.md]
- **Total Groups**: [N]
- **Estimated Complexity**: [S/M/L/XL]

---

## Task Group 1: [Name]
**Dependencies**: None
**Specialist**: backend-specialist / frontend-specialist / etc.
**Complexity**: S/M/L

### Parent Task: [Description]
- [ ] 1.1: [Specific subtask]
- [ ] 1.2: [Specific subtask]
- [ ] 1.3: [Specific subtask]

**Acceptance Criteria**:
- [ ] [Verifiable criterion]
- [ ] [Verifiable criterion]

---

## Task Group 2: [Name]
**Dependencies**: Task Group 1
**Specialist**: [type]
**Complexity**: M

### Parent Task: [Description]
- [ ] 2.1: [Specific subtask]
- [ ] 2.2: [Specific subtask]

**Acceptance Criteria**:
- [ ] [Verifiable criterion]
```

### Task Writing Guidelines

**DO:**
- Make tasks small (2-4 hours each)
- Include specific file paths when known
- Reference spec sections for details
- Add clear acceptance criteria
- Mark dependencies explicitly

**DON'T:**
- Create vague tasks like "Build the feature"
- Mix frontend and backend in same group
- Skip acceptance criteria
- Create tasks without dependencies clarity

### PHASE 4: Review and Save

Before saving, verify:
- [ ] All spec requirements are covered by tasks
- [ ] Dependencies are logical (no circular deps)
- [ ] Tasks are small enough to implement
- [ ] Acceptance criteria are testable

Save to: `fabric/specs/[spec-folder]/tasks.md`

### PHASE 5: Report

```
✅ Tasks created!

📋 Tasks: fabric/specs/YYYY-MM-DD-feature/tasks.md

SUMMARY:
- Task Groups: [N]
- Total Tasks: [N]
- Dependencies: [described]

TASK GROUPS:
1. [Group 1 Name] - [N tasks] - No dependencies
2. [Group 2 Name] - [N tasks] - Depends on Group 1
3. [Group 3 Name] - [N tasks] - Depends on Group 1
4. [Group 4 Name] - [N tasks] - Depends on Groups 2, 3

NEXT STEP 👉 Run /implement-tasks to start implementation.
```

---

## Start Now

Ask me: **"Which spec should I create tasks for?"** and list available specs in `fabric/specs/`

