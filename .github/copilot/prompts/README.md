# GitHub Copilot Workflow Prompts

Workflow prompts guide you through the Fabric framework's spec-driven development process. Reference these in GitHub Copilot Chat to follow the systematic workflow.

## How to Use

In GitHub Copilot Chat, reference prompts like this:

```
@.github/copilot/prompts/shape-spec.md
@.github/copilot/prompts/implement-tasks.md
@workspace @.github/copilot/prompts/create-tasks.md
```

## Workflow Phases

### Phase 0: Setup Standards

**standards-shaper.md** - `@.github/copilot/prompts/standards-shaper.md`
- Create or update project coding standards
- Define validation requirements
- Establish team conventions
- **Use when**: Starting a new project or updating standards

### Phase 1: Product Planning

**plan-product.md** - `@.github/copilot/prompts/plan-product.md`
- Define product vision and mission
- Create product roadmap
- Establish tech stack
- **Use when**: Starting a new product

**1-product-concept.md** - Define product concept
**2-create-mission.md** - Create mission statement
**3-create-roadmap.md** - Create product roadmap
**4-create-tech-stack.md** - Define technology stack

### Phase 2: Spec Shaping

**shape-spec.md** - `@.github/copilot/prompts/shape-spec.md`
- Gather requirements through questions
- Analyze user needs
- Create initial spec outline
- **Use when**: Starting a new feature

**1-initialize-spec.md** - Initialize spec structure
**1-get-spec-requirements.md** - Gather requirements
**2-shape-spec.md** - Shape specification

### Phase 3: Spec Writing

**write-spec.md** - `@.github/copilot/prompts/write-spec.md`
- Write detailed specification
- Define acceptance criteria
- Document edge cases
- **Use when**: After spec shaping is complete

### Phase 4: Task Creation

**create-tasks.md** - `@.github/copilot/prompts/create-tasks.md`
- Break spec into task groups
- Define implementation order
- Estimate effort
- **Use when**: After spec is written

**1-determine-tasks.md** - Determine task breakdown
**2-create-tasks-list.md** - Create detailed task list

### Phase 5: Task Orchestration

**orchestrate-tasks.md** - `@.github/copilot/prompts/orchestrate-tasks.md`
- Plan parallel vs sequential execution
- Assign specialists to task groups
- Create implementation roadmap
- **Use when**: Before implementation, especially for complex features

### Phase 6: Implementation

**implement-tasks.md** - `@.github/copilot/prompts/implement-tasks.md`
- Follow TDD approach
- Implement tasks systematically
- Update progress in tasks.md
- **Use when**: Ready to start coding

**2-implement-tasks.md** - Alternative implementation guide

### Phase 7: Verification

**3-verify-implementation.md** - `@.github/copilot/prompts/3-verify-implementation.md`
- Verify all acceptance criteria met
- Run full test suite
- Generate verification report
- **Use when**: After implementation is complete

### Continuous Improvement

**improve-skills.md** - `@.github/copilot/prompts/improve-skills.md`
- Enhance AI capabilities
- Add new skills to library
- Update existing skills
- **Use when**: Discovering new patterns or best practices

## Complete Workflow Example

### New Feature Development

```bash
# 1. Shape the spec
@workspace @.github/copilot/prompts/shape-spec.md
I want to build a user authentication system

# 2. Write detailed spec
@workspace @.github/copilot/prompts/write-spec.md
Write the full spec for fabric/specs/2024-01-15-user-auth/

# 3. Create tasks
@workspace @.github/copilot/prompts/create-tasks.md
Break down the auth spec into tasks

# 4. Orchestrate (optional for complex features)
@workspace @.github/copilot/prompts/orchestrate-tasks.md
Plan the implementation strategy

# 5. Implement
@workspace @.github/copilot/prompts/implement-tasks.md
Implement tasks from fabric/specs/2024-01-15-user-auth/tasks.md

# 6. Verify
@workspace @.github/copilot/prompts/3-verify-implementation.md
Verify the auth implementation
```

### Quick Bug Fix

```bash
# Find the relevant spec
@workspace Show me specs related to authentication

# Implement fix following the spec
@workspace @.github/copilot/prompts/implement-tasks.md
Fix the password reset bug following the auth spec
```

### Refactoring

```bash
# Check standards first
@workspace Show me fabric/standards/coding-standards.md

# Refactor following standards
@workspace @.github/copilot/agents/implementer.md
Refactor the auth service to follow our coding standards
```

## Tips for Using Prompts

### Combine with Workspace Context

```
@workspace @.github/copilot/prompts/shape-spec.md
```

This gives Copilot full context of your codebase while following the workflow.

### Reference Standards

```
@workspace Check fabric/standards/ before proceeding
@.github/copilot/prompts/implement-tasks.md
```

### Chain Prompts

Follow the workflow in order:
1. Shape → 2. Write → 3. Tasks → 4. Implement → 5. Verify

### Use Agents for Specialized Work

```
@workspace @.github/copilot/agents/backend-specialist.md
@.github/copilot/prompts/implement-tasks.md
```

Combine agents with prompts for domain-specific guidance.

## File Structure

After using these prompts, your project will have:

```
fabric/
├── standards/
│   ├── coding-standards.md
│   ├── validation-requirements.md
│   └── best-practices.md
└── specs/
    └── YYYY-MM-DD-feature-name/
        ├── spec.md              # From write-spec.md
        ├── tasks.md             # From create-tasks.md
        └── orchestration.yml    # From orchestrate-tasks.md (optional)
```

## Remember

- **Follow the workflow** - Don't skip phases
- **Reference standards** - Check `fabric/standards/` first
- **Update as you go** - Keep tasks.md current
- **Use @workspace** - Get context-aware responses
- **Combine prompts and agents** - Use both for best results

