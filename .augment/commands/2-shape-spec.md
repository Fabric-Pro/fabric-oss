# Step 2: Shape Spec

> **Usage**: Reference with `.augment/commands/2-shape-spec.md` or copy into chat

---

## Workflow Instructions

Now that you've initialized the spec folder, it's time to gather requirements and shape the specification.

### Requirements Gathering Process

Ask the user these questions to understand the feature:

#### 1. Feature Overview
- What is this feature?
- Why is it needed?
- What problem does it solve?

#### 2. User Stories
- Who are the users?
- What do they need to do?
- What's the expected outcome?

#### 3. Scope Definition
- What is IN scope?
- What is OUT of scope?
- Any constraints or limitations?

#### 4. Technical Considerations
- Integration points with existing code?
- Database changes needed?
- API endpoints required?
- UI/UX requirements?

#### 5. Acceptance Criteria
- How will we know this is complete?
- What are the testable outcomes?

### Document Requirements

Create `fabric/specs/[this-spec]/planning/requirements.md` with the gathered information:

```markdown
# Requirements: [Feature Name]

## Overview
[Brief description]

## User Stories
- As a [user], I want to [action] so that [benefit]

## Scope
### In Scope
- [Item 1]
- [Item 2]

### Out of Scope
- [Item 1]

## Technical Considerations
[Technical notes]

## Acceptance Criteria
- [ ] [Criterion 1]
- [ ] [Criterion 2]
```

---

## Display Confirmation and Next Step

Once you've documented the requirements:

```
✅ Requirements documented at `fabric/specs/[this-spec]/planning/requirements.md`.

NEXT STEP 👉 Run .augment/commands/write-spec.md to create the detailed specification
```

