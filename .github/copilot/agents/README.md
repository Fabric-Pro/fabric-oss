# GitHub Copilot Agents

Specialized AI agents for different aspects of software development. Reference these agents in GitHub Copilot Chat using the `@` symbol.

## How to Use

In GitHub Copilot Chat, reference agents like this:

```
@.github/copilot/agents/implementer.md Help me implement this feature
@.github/copilot/agents/backend-specialist.md Design an API for user management
@.github/copilot/agents/frontend-specialist.md Create a responsive dashboard layout
```

## Available Agents

### Workflow Agents

**Spec Shaper** - `@.github/copilot/agents/spec-shaper.md`
- Gather requirements through strategic questioning
- Shape feature specifications
- Identify edge cases and acceptance criteria
- Use when: Starting a new feature

**Spec Writer** - `@.github/copilot/agents/spec-writer.md`
- Write detailed technical specifications
- Document API contracts and data models
- Define acceptance criteria
- Use when: After spec shaping is complete

**Tasks List Creator** - `@.github/copilot/agents/tasks-list-creator.md`
- Break specs into actionable tasks
- Group related tasks
- Estimate effort and dependencies
- Use when: After spec is written

**Product Planner** - `@.github/copilot/agents/product-planner.md`
- Define product vision and roadmap
- Create user personas
- Prioritize features
- Use when: Starting a new product or major feature

### Implementation Agents

**Implementer** - `@.github/copilot/agents/implementer.md`
- Full-stack feature implementation
- Test-driven development
- Follow specifications and tasks
- Use when: Implementing features from tasks.md

**Backend Specialist** - `@.github/copilot/agents/backend-specialist.md`
- API design and implementation
- Database schema and queries
- Authentication and authorization
- Use when: Building server-side features

**Frontend Specialist** - `@.github/copilot/agents/frontend-specialist.md`
- React/Next.js components
- State management
- Responsive UI design
- Use when: Building user interfaces

**Database Specialist** - `@.github/copilot/agents/database-specialist.md`
- Schema design and optimization
- Migrations and data modeling
- Query optimization
- Use when: Designing or modifying database

**Full Stack Specialist** - `@.github/copilot/agents/full-stack-specialist.md`
- End-to-end feature development
- Frontend + Backend integration
- Complete user flows
- Use when: Building complete features

**DevOps Specialist** - `@.github/copilot/agents/devops-specialist.md`
- CI/CD pipelines
- Docker and containerization
- Deployment strategies
- Use when: Setting up infrastructure

**Test Specialist** - `@.github/copilot/agents/test-specialist.md`
- Test strategy and planning
- Unit, integration, E2E tests
- Test automation
- Use when: Writing comprehensive tests

### Verification Agents

**Spec Verifier** - `@.github/copilot/agents/spec-verifier.md`
- Verify spec completeness
- Check for ambiguities
- Validate acceptance criteria
- Use when: Reviewing specifications

**Implementation Verifier** - `@.github/copilot/agents/implementation-verifier.md`
- Verify implementation matches spec
- Check acceptance criteria
- Validate test coverage
- Use when: Verifying completed work

**Spec Initializer** - `@.github/copilot/agents/spec-initializer.md`
- Initialize new spec structure
- Set up directories and files
- Create templates
- Use when: Starting a new spec

## Agent Workflow

### Typical Development Flow

1. **Plan** → `@.github/copilot/agents/product-planner.md`
2. **Shape** → `@.github/copilot/agents/spec-shaper.md`
3. **Write Spec** → `@.github/copilot/agents/spec-writer.md`
4. **Create Tasks** → `@.github/copilot/agents/tasks-list-creator.md`
5. **Implement** → `@.github/copilot/agents/implementer.md` or specialists
6. **Verify** → `@.github/copilot/agents/implementation-verifier.md`

### Specialized Workflows

**Backend Feature:**
1. Spec Shaper → Spec Writer → Tasks Creator
2. Database Specialist (schema)
3. Backend Specialist (API)
4. Test Specialist (tests)
5. Implementation Verifier

**Frontend Feature:**
1. Spec Shaper → Spec Writer → Tasks Creator
2. Frontend Specialist (components)
3. Test Specialist (component tests)
4. Implementation Verifier

**Full Stack Feature:**
1. Spec Shaper → Spec Writer → Tasks Creator
2. Full Stack Specialist (end-to-end)
3. Test Specialist (all layers)
4. Implementation Verifier

## Tips for Using Agents

### Be Specific
```
❌ Help me build a feature
✅ @.github/copilot/agents/backend-specialist.md Design a REST API for user authentication with JWT tokens
```

### Combine with Workspace Context
```
@workspace @.github/copilot/agents/implementer.md Implement the tasks in fabric/specs/2024-01-15-user-auth/tasks.md
```

### Reference Standards
```
@.github/copilot/agents/frontend-specialist.md Create a form component following the patterns in fabric/standards/coding-standards.md
```

### Chain Agents
```
1. @.github/copilot/agents/spec-shaper.md Shape a spec for user dashboard
2. @.github/copilot/agents/spec-writer.md Write the full spec based on the shaped requirements
3. @.github/copilot/agents/tasks-list-creator.md Break this spec into tasks
```

## Remember

- Agents are **guidance**, not rigid rules
- Adapt workflows to your project needs
- Reference `fabric/standards/` for project-specific patterns
- Keep `fabric/specs/*/tasks.md` updated as you work
- Use `@workspace` for context-aware responses

