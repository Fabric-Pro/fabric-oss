# /implement-tasks

Execute implementation following the task list.

## Purpose

Systematically implement tasks from the task list, following TDD and project standards.

## When to Use

- After `/create-tasks` or `/orchestrate-tasks` completes
- When ready to start coding
- For each implementation session

## Pre-Check

1. Load spec: `fabric/specs/YYYY-MM-DD-feature/spec.md`
2. Load tasks: `fabric/specs/YYYY-MM-DD-feature/tasks.md`
3. Load standards: `fabric/standards/`
4. Load orchestration (if exists): `orchestration.yml`

## Process

### Step 1: Context Loading

Load and understand:
- Full specification
- All tasks and their status
- Project standards
- Existing codebase patterns

### Step 2: Task Selection

Ask the user:
```
Which task group(s) would you like to implement?

Available groups:
1. Database Setup (tasks 1.1-1.2) - Not started
2. Backend API (tasks 2.1-2.5) - Not started
3. Frontend UI (tasks 3.1-3.4) - Not started
4. Testing (tasks 4.1-4.3) - Not started

Enter group number(s) or specific task IDs:
```

### Step 3: Implementation Loop

For each task:

#### 3a. Announce the Task
```
🔧 Starting Task 2.1: Create API route structure
   Reference: spec.md Section 5.1
   Acceptance: Routes registered, 404 for unimplemented
```

#### 3b. Write Tests First (TDD)
```javascript
// Write failing test
describe('POST /api/resource', () => {
  it('should create a resource', async () => {
    // Test implementation
  });
});
```

#### 3c. Implement the Code
- Follow project standards
- Match spec requirements exactly
- Keep code clean and focused

#### 3d. Verify Tests Pass
Run tests and confirm they pass.

#### 3e. Update Task Status
Mark task complete in `tasks.md`:
```markdown
- [x] 2.1: Create API route structure ✅
```

#### 3f. Announce Completion
```
✅ Task 2.1 complete!

Changes made:
- Created src/api/routes.ts
- Added route handlers
- Tests passing

Next task: 2.2 - Implement [Endpoint 1]
Continue? (y/n)
```

### Step 4: Session Summary

After completing tasks or ending session:

```
📊 Implementation Session Summary

Completed:
✅ Task 2.1: Create API route structure
✅ Task 2.2: Implement [Endpoint 1]

Remaining:
⏳ Task 2.3: Implement [Endpoint 2]
⏳ Task 2.4: Add input validation

Progress: 8/15 tasks complete (53%)

Files changed:
- src/api/routes.ts (new)
- src/api/handlers/resource.ts (new)
- tests/api/resource.test.ts (new)

Next session: Continue with Task 2.3
```

## Implementation Guidelines

### Follow TDD
1. Write failing test
2. Write minimal code to pass
3. Refactor while tests pass

### Follow Standards
- Check `fabric/standards/` before writing code
- Match existing patterns in codebase
- Use consistent naming and structure

### Keep Tasks Small
- One task = one focused change
- Commit after each task
- Easy to review and revert

### Package Manager Detection

Before running any commands:
1. `bun.lockb` → Use **bun**
2. `pnpm-lock.yaml` → Use **pnpm**
3. `yarn.lock` → Use **yarn**
4. `package-lock.json` → Use **npm**

## Completion

When all tasks are complete:

```
🎉 Implementation Complete!

Feature: [Feature Name]
All 15 tasks completed successfully.

📁 Files created/modified: X
✅ Tests passing: Y
📊 Coverage: Z%

NEXT STEPS:
1. Review changes: git diff
2. Run full test suite
3. Create pull request
4. Update documentation if needed
```

