# Shape Spec - Gather Requirements

**Purpose**: Gather requirements for a new feature through strategic questioning and create an initial specification outline.

**When to Use**: At the start of any new feature or project, before writing detailed specifications.

## Instructions for GitHub Copilot

You are acting as a requirements analyst and product designer. Your goal is to help shape a clear, complete specification by asking strategic questions and gathering all necessary information.

### Step 1: Understand the Request

First, ask the user to describe the feature they want to build:

```
What feature would you like to build? Please provide:
- A brief description of the feature
- The problem it solves
- Who will use it
```

### Step 2: Strategic Questioning

Ask clarifying questions in these areas:

#### Problem & Users
- What specific problem does this solve?
- Who are the primary users?
- How are they solving this problem today?
- What's the impact of not having this feature?

#### Functional Requirements
- What are the core capabilities needed?
- What data does the feature work with?
- What actions can users take?
- What are the expected outcomes?

#### User Experience
- What screens/pages are needed?
- What's the user flow from start to finish?
- What feedback do users receive?
- How should errors be handled?

#### Technical Constraints
- Are there performance requirements?
- What about security/privacy concerns?
- Any integration requirements?
- Browser/device compatibility needs?

#### Edge Cases
- What could go wrong?
- What are the boundary conditions?
- How should errors be handled?
- What validation is needed?

#### Success Criteria
- How do we know this is working correctly?
- What are the acceptance criteria?
- How will we measure success?

### Step 3: Create Spec Outline

Based on the answers, create a spec outline in this location:

```
fabric/specs/YYYY-MM-DD-feature-name/spec.md
```

Use this template:

```markdown
# [Feature Name]

**Created**: YYYY-MM-DD
**Status**: Draft
**Owner**: [Name]

## Overview

Brief description of the feature and its purpose.

## Problem Statement

What problem does this solve? Why is it needed?

## User Stories

- As a [user type], I want to [action] so that [benefit]
- As a [user type], I want to [action] so that [benefit]

## Functional Requirements

### Core Features
1. Feature 1
2. Feature 2

### Data Requirements
- What data is needed
- Where it comes from
- How it's stored

### Integration Points
- External APIs
- Internal services
- Third-party tools

## User Experience

### User Interface
- Screens/pages needed
- Key components
- Navigation flow

### User Flow
1. User starts at...
2. User performs...
3. System responds...
4. User completes...

### Error Handling
- Network failures
- Invalid input
- System errors

## Technical Requirements

### Performance
- Response time: < Xms
- Concurrent users: X
- Data volume: X records

### Security
- Authentication required: Yes/No
- Authorization: Role-based
- Data privacy: PII handling

### Compatibility
- Browsers: Chrome, Firefox, Safari, Edge
- Devices: Desktop, Mobile, Tablet
- API versions: vX.X

## Edge Cases

1. Empty states (no data)
2. Maximum limits (too much data)
3. Concurrent operations
4. Network failures
5. Invalid input

## Acceptance Criteria

### Must Have
- [ ] Criterion 1
- [ ] Criterion 2

### Should Have
- [ ] Criterion 3
- [ ] Criterion 4

### Nice to Have
- [ ] Criterion 5
- [ ] Criterion 6

## Out of Scope

What we're explicitly NOT building in this iteration:
- Item 1
- Item 2

## Open Questions

- Question 1?
- Question 2?

## Next Steps

1. Review and refine this spec
2. Get stakeholder approval
3. Create detailed tasks
4. Begin implementation
```

### Step 4: Validate Completeness

Before finishing, verify:
- [ ] Problem is clearly defined
- [ ] User stories are specific
- [ ] Functional requirements are detailed
- [ ] User flow is documented
- [ ] Edge cases are identified
- [ ] Acceptance criteria are testable
- [ ] Out of scope is defined

### Step 5: Save and Inform

Save the spec and inform the user:

```
✅ Spec outline created!

📄 Location: fabric/specs/YYYY-MM-DD-feature-name/spec.md

📊 Summary:
- User stories: X
- Core features: X
- Acceptance criteria: X
- Open questions: X

🎯 Next Steps:
1. Review the spec outline
2. Answer any open questions
3. Run: @.github/copilot/prompts/write-spec.md to create detailed spec
```

## Tips for Using This Prompt

### In GitHub Copilot Chat:

```
@workspace @.github/copilot/prompts/shape-spec.md

I want to build a user authentication system
```

### Reference Standards:

```
@workspace Check fabric/standards/ before shaping this spec
@.github/copilot/prompts/shape-spec.md
```

### Iterate:

Don't try to get everything perfect in one pass. Shape the spec, review it, and refine based on feedback.

## Remember

- **Ask, don't assume** - Clarify before documenting
- **Be specific** - Vague specs lead to rework
- **Think edge cases** - What could go wrong?
- **Define success** - How do we know it's done?
- **Reference standards** - Check `fabric/standards/` for patterns

