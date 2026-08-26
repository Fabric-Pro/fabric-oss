# /shape-spec

Gather and document requirements for a new feature.

## Purpose

Shape the scope and requirements for a feature through structured questioning. This prevents building the wrong thing.

## When to Use

- Before building any new feature
- When requirements are vague
- When scope needs clarification

## Pre-Check: Load Standards

Before shaping, check for existing standards:

1. Look for `fabric/standards/` directory
2. If it exists, read ALL standards files
3. Keep standards in mind during shaping
4. Ensure requirements don't conflict with standards

If no standards exist:
```
ℹ️ No project standards found at fabric/standards/
   Consider running /standards-shaper to establish project conventions.
```

## Process

### Phase 1: Initialize Spec Folder

Create the folder structure:

```
fabric/specs/YYYY-MM-DD-feature-name/
├── README.md
├── planning/
│   ├── requirements.md
│   ├── decisions.md
│   └── visuals/
```

### Phase 2: Gather Requirements

Ask clarifying questions about:

**Functional Requirements**
1. What should this feature do?
2. Who are the users?
3. What's the workflow?
4. What are the inputs/outputs?

**Non-Functional Requirements**
5. Performance expectations?
6. Security requirements?
7. Accessibility needs?

**Scope**
8. What's in scope?
9. What's explicitly out of scope?
10. What's the MVP vs nice-to-have?

**Technical Considerations**
11. Any integrations needed?
12. Data storage requirements?
13. Existing patterns to follow?

### Phase 3: Request Visual Assets

Ask for:
- Mockups or wireframes
- Reference screenshots
- Flow diagrams
- Any visual inspiration

Save to `planning/visuals/`

### Phase 4: Document Findings

Update `planning/requirements.md`:

```markdown
# Requirements

## Functional Requirements
1. [Requirement 1]
2. [Requirement 2]

## Non-Functional Requirements
1. [Performance, security, etc.]

## User Stories
1. As a [user], I want to [action] so that [benefit]

## Scope
### In Scope
- [Item]

### Out of Scope
- [Item]

## Acceptance Criteria
- [ ] [Criterion 1]
- [ ] [Criterion 2]
```

Update `planning/decisions.md` with key decisions made.

## Completion

After shaping, inform the user:

```
✅ Spec shaping complete!

📁 Created: fabric/specs/YYYY-MM-DD-feature-name/
├── README.md
├── planning/
│   ├── requirements.md
│   ├── decisions.md
│   └── visuals/

NEXT STEP 👉 Run `/write-spec` to generate the detailed specification.
```

