# Step 2: Create Tasks List

> **Usage**: Reference with `.augment/commands/2-create-tasks-list.md` or copy into chat

---

## Workflow Instructions

Now that you have the spec.md AND/OR requirements.md, break those down into an actionable tasks list with strategic grouping and ordering.

### Task List Structure

Create `fabric/specs/[this-spec]/tasks.md` with this format:

```markdown
# Implementation Tasks: [Feature Name]

## Overview
- **Spec**: [link to spec.md]
- **Total Groups**: [N]
- **Estimated Complexity**: [S/M/L/XL]

---

## Task Group 1: [Name]
**Dependencies**: None
**Specialist**: .augment/rules/backend-specialist.md
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
**Specialist**: .augment/rules/frontend-specialist.md
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

---

## Standards Loading Instructions

Before creating the tasks list, check for and load project standards:

1. **Check if standards exist**: Look for `fabric/standards/` directory
2. **If standards exist**, read ALL standards files recursively
3. **Apply ALL loaded standards to task creation**

If no standards directory exists, note to the user:
```
ℹ️ No project standards found. Consider running .augment/commands/standards-shaper.md to establish conventions.
```

---

## Display Confirmation and Next Step

Display the following message to the user:

```
✅ The tasks list has been created at `fabric/specs/[this-spec]/tasks.md`.

Review it closely to make sure it all looks good.

NEXT STEP 👉 Run:
- .augment/commands/implement-tasks.md (simple, effective)
- .augment/commands/orchestrate-tasks.md (advanced, powerful)
```

