# Fabric Framework - GitHub Copilot Workspace Instructions

You are an AI assistant using the Fabric framework for spec-driven development. This workspace follows a systematic workflow for building features with AI assistance.

## Core Principles

1. **Spec-Driven Development**: Always start with a specification before coding
2. **Task Breakdown**: Break specs into actionable tasks
3. **Standards Compliance**: Follow project standards in `fabric/standards/`
4. **Test-Driven**: Write tests before implementation
5. **Documentation**: Keep specs and tasks updated

## Workflow Phases

### Phase 0: Setup Standards
**Command**: Reference `@.github/copilot/prompts/standards-shaper.md`
- Create or update project coding standards
- Define validation requirements
- Establish team conventions

### Phase 1: Product Planning
**Command**: Reference `@.github/copilot/prompts/plan-product.md`
- Define product vision and mission
- Create roadmap
- Establish tech stack

### Phase 2: Spec Shaping
**Command**: Reference `@.github/copilot/prompts/shape-spec.md`
- Gather requirements through questions
- Analyze user needs
- Create initial spec outline

### Phase 3: Spec Writing
**Command**: Reference `@.github/copilot/prompts/write-spec.md`
- Write detailed specification
- Define acceptance criteria
- Document edge cases

### Phase 4: Task Creation
**Command**: Reference `@.github/copilot/prompts/create-tasks.md`
- Break spec into task groups
- Define implementation order
- Estimate effort

### Phase 5: Task Orchestration
**Command**: Reference `@.github/copilot/prompts/orchestrate-tasks.md`
- Plan parallel vs sequential execution
- Assign specialists to task groups
- Create implementation roadmap

### Phase 6: Implementation
**Command**: Reference `@.github/copilot/prompts/implement-tasks.md`
- Follow TDD approach
- Implement tasks systematically
- Update progress in tasks.md

### Phase 7: Verification
**Command**: Reference `@.github/copilot/prompts/verify-implementation.md`
- Verify all acceptance criteria met
- Run full test suite
- Generate verification report

## Specialized Agents

Reference these agents for domain-specific work:

- `@.github/copilot/agents/implementer.md` - Full-stack implementation
- `@.github/copilot/agents/backend-specialist.md` - Backend/API work
- `@.github/copilot/agents/frontend-specialist.md` - Frontend/UI work
- `@.github/copilot/agents/database-specialist.md` - Database design
- `@.github/copilot/agents/test-specialist.md` - Testing strategies
- `@.github/copilot/agents/devops-specialist.md` - CI/CD and deployment

## File Structure

```
fabric/
├── standards/           # Project coding standards
│   ├── coding-standards.md
│   ├── validation-requirements.md
│   └── best-practices.md
└── specs/              # Feature specifications
    └── YYYY-MM-DD-feature-name/
        ├── spec.md     # Detailed specification
        ├── tasks.md    # Task breakdown
        └── orchestration.yml  # Implementation plan
```

## GitHub Copilot Native Features

### Chat Participants
- `@workspace` - Query entire workspace context
- `@terminal` - Get terminal command help
- `@vscode` - VS Code specific questions

### Slash Commands
- `/explain` - Explain code
- `/fix` - Fix problems
- `/tests` - Generate tests
- `/new` - Create new files

### Best Practices
1. Always reference `@workspace` for context-aware responses
2. Use `@.github/copilot/prompts/` for workflow guidance
3. Reference `@.github/copilot/agents/` for specialized tasks
4. Check `fabric/standards/` before making changes
5. Update `fabric/specs/*/tasks.md` as you complete tasks

## Quick Start

1. **New Feature**: Start with `@.github/copilot/prompts/shape-spec.md`
2. **Implementation**: Use `@.github/copilot/prompts/implement-tasks.md`
3. **Bug Fix**: Reference relevant spec in `fabric/specs/`
4. **Refactoring**: Check `fabric/standards/` first

## Standards Location

All project standards are in `fabric/standards/`. Always check these before:
- Writing new code
- Making architectural decisions
- Choosing libraries or patterns
- Implementing features

## Skills Library

Reference skills from `.github/copilot/skills/` for deep expertise:
- Next.js, React, TypeScript patterns
- API design and backend services
- Database design and migrations
- Testing strategies (TDD, E2E)
- CI/CD and deployment
- Security patterns

## Remember

- **Always start with a spec** - No coding without a specification
- **Follow the workflow** - Don't skip phases
- **Update as you go** - Keep tasks.md current
- **Reference standards** - Consistency is key
- **Test first** - TDD approach for all features

