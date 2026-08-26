# /create-tasks

Break down a specification into implementable tasks.

## Purpose

Transform the specification into a structured task list that guides implementation.

## When to Use

- After `/write-spec` completes
- When specification is ready
- Before implementation begins

## Pre-Check

1. Verify spec exists: `fabric/specs/YYYY-MM-DD-feature/spec.md`
2. Load project standards from `fabric/standards/`

## Process

### Step 1: Analyze the Spec

Read and understand:
- All spec sections
- Dependencies between components
- Complexity of each area

### Step 2: Create Task Groups

Organize into logical groups:

1. **Database/Data Layer**
2. **Backend/API**
3. **Frontend/UI**
4. **Testing**
5. **Documentation** (if needed)

### Step 3: Write Tasks

Create `tasks.md`:

```markdown
# Implementation Tasks

Feature: [Feature Name]
Spec: ./spec.md
Created: YYYY-MM-DD

## Task Group 1: Database Setup
Reference: spec.md Section 4

- [ ] 1.1: Create database schema
  - Create tables as specified in Section 4.1
  - Acceptance: Migrations run successfully
  - Effort: S

- [ ] 1.2: Add database indexes
  - Add indexes for query optimization
  - Acceptance: Indexes created, queries optimized
  - Effort: S

## Task Group 2: Backend API
Reference: spec.md Section 5

- [ ] 2.1: Create API route structure
  - Set up routes as specified in Section 5.1
  - Acceptance: Routes registered, 404 for unimplemented
  - Effort: S

- [ ] 2.2: Implement [Endpoint 1]
  - Implement POST /api/[resource]
  - Acceptance: Endpoint works per spec, tests pass
  - Effort: M

- [ ] 2.3: Implement [Endpoint 2]
  - Implement GET /api/[resource]
  - Acceptance: Endpoint works per spec, tests pass
  - Effort: M

- [ ] 2.4: Add input validation
  - Validate all inputs per Section 7.3
  - Acceptance: Invalid inputs rejected with proper errors
  - Effort: S

- [ ] 2.5: Add error handling
  - Implement error handling per standards
  - Acceptance: All errors handled gracefully
  - Effort: S

## Task Group 3: Frontend UI
Reference: spec.md Section 6

- [ ] 3.1: Create page layout
  - Create page structure per Section 6.1
  - Acceptance: Page renders, matches spec
  - Effort: S

- [ ] 3.2: Implement [Component 1]
  - Build component per Section 6.2
  - Acceptance: Component works, styled correctly
  - Effort: M

- [ ] 3.3: Connect to API
  - Wire up API calls
  - Acceptance: Data flows correctly, errors handled
  - Effort: M

- [ ] 3.4: Add loading and error states
  - Handle all UI states
  - Acceptance: Graceful loading/error handling
  - Effort: S

## Task Group 4: Testing
Reference: spec.md Section 8

- [ ] 4.1: Write unit tests
  - Test business logic
  - Acceptance: >80% coverage on new code
  - Effort: M

- [ ] 4.2: Write integration tests
  - Test API endpoints
  - Acceptance: All endpoints tested
  - Effort: M

- [ ] 4.3: Write E2E tests
  - Test critical user flows
  - Acceptance: Happy path tested
  - Effort: M

---

## Summary
- Total Tasks: X
- Effort Breakdown: S(X) M(Y) L(Z)
- Estimated Duration: [Time estimate]

## Notes
- Tasks should be completed in order within each group
- Groups can be worked on in parallel by different team members
- Mark tasks complete with [x] as you finish
```

### Step 4: Task Guidelines

Each task should have:
- **Clear description**: What to do
- **Acceptance criteria**: How to know it's done
- **Effort estimate**: S (1-2h), M (2-4h), L (4-8h)
- **Spec reference**: Where to find details

## Completion

After creating tasks, inform the user:

```
✅ Tasks created!

📄 Created: fabric/specs/YYYY-MM-DD-feature/tasks.md

📊 Summary:
- Task Groups: X
- Total Tasks: Y
- Effort: S(a) M(b) L(c)

NEXT STEP 👉 Run `/implement-tasks` to start building!
```

