# Claude Code Native Features Guide

This guide helps you leverage Claude Code's native features for maximum productivity with the Fabric framework.

## Claude Code's Unique Capabilities

### 1. Task Tool (Parallel Execution)

Claude Code's Task tool allows spawning multiple subagents in parallel for concurrent work.

**When to Use:**
- Implementing multiple independent task groups
- Running parallel test suites
- Processing multiple files simultaneously

**Example from implement-tasks.md:**

```markdown
I'll spawn 4 subagents in parallel to implement these task groups:

<task>
Implement authentication system
- Use @implementer agent
- Follow fabric/specs/2024-01-15-auth/tasks.md
- Update tasks.md with progress
</task>

<task>
Implement user dashboard
- Use @frontend-specialist agent
- Follow fabric/specs/2024-01-15-dashboard/tasks.md
- Update tasks.md with progress
</task>

<task>
Implement API endpoints
- Use @backend-specialist agent
- Follow fabric/specs/2024-01-15-api/tasks.md
- Update tasks.md with progress
</task>

<task>
Write integration tests
- Use @test-specialist agent
- Follow fabric/specs/2024-01-15-tests/tasks.md
- Update tasks.md with progress
</task>
```

All 4 agents work simultaneously, dramatically reducing implementation time.

### 2. Agent YAML Frontmatter

Claude Code agents use YAML frontmatter for configuration:

```yaml
---
name: implementer
description: Full-stack developer for feature implementation
color: red
model: inherit
---
```

**Fields:**
- `name` - Agent identifier
- `description` - When to use this agent
- `color` - Visual identifier in Claude Code UI
- `model` - Model to use (inherit = use current model)

### 3. Slash Commands

Claude Code supports custom slash commands in `.claude/commands/`:

```bash
/shape-spec      # Start requirements gathering
/write-spec      # Write detailed specification
/create-tasks    # Break spec into tasks
/implement-tasks # Start implementation
/verify          # Verify implementation
```

**How They Work:**
- Commands are markdown files in `.claude/commands/`
- Invoked with `/command-name` in chat
- Provide structured workflows

### 4. Subagent Delegation

Delegate work to specialized agents:

```markdown
I'll delegate this to the backend specialist:

@backend-specialist
Design and implement a REST API for user management with:
- CRUD operations for users
- JWT authentication
- Role-based authorization
- Input validation
- Error handling
```

**Best Practices:**
- Be specific about what the subagent should do
- Provide context (spec location, standards)
- Set clear success criteria
- Use appropriate specialist for the domain

### 5. Projects Integration

**Claude Projects** provide persistent context across conversations.

**Setup:**
1. Create a Claude Project for your repository
2. Add key files to project knowledge:
   - `fabric/standards/global/coding-style.md`
   - `fabric/standards/global/validation.md`
   - `README.md`
   - Package files (`package.json`, `requirements.txt`)

**Benefits:**
- Context persists across sessions
- No need to re-explain project structure
- Faster, more accurate responses

### 6. Artifacts (Coming Soon)

Claude Artifacts allow creating interactive previews:
- UI component previews
- API documentation
- Architecture diagrams
- Test reports

**Future Integration:**
- Generate interactive spec previews
- Visualize task dependencies
- Preview UI components before implementation

## Fabric Workflow with Claude Native Features

### Phase 1: Spec Shaping

```
/shape-spec

[Claude asks strategic questions]
[You provide answers]
[Claude creates spec outline in fabric/specs/]
```

### Phase 2: Spec Writing

```
/write-spec

[Claude delegates to @spec-writer]
[Detailed spec created with acceptance criteria]
```

### Phase 3: Task Creation

```
/create-tasks

[Claude delegates to @tasks-list-creator]
[Tasks broken into groups]
[Dependencies identified]
```

### Phase 4: Orchestration

```
/orchestrate-tasks

[Claude analyzes task groups]
[Creates orchestration.yml]
[Assigns specialists to groups]
```

### Phase 5: Parallel Implementation

```
/implement-tasks

Choose Option A: Parallel Execution

[Claude spawns multiple subagents using Task tool]
[Each specialist works on their task group]
[All update same tasks.md file]
[Progress tracked in real-time]
```

**Example Output:**
```
🚀 Starting parallel implementation...

Task 1: @backend-specialist implementing API endpoints
Task 2: @frontend-specialist building dashboard UI
Task 3: @database-specialist creating schema
Task 4: @test-specialist writing tests

[All tasks execute simultaneously]

✅ All task groups completed!
```

### Phase 6: Verification

```
/verify

[Claude delegates to @implementation-verifier]
[Checks all acceptance criteria]
[Runs test suite]
[Generates verification report]
```

## Advanced Patterns

### Specialist Orchestration

Use `orchestration.yml` to assign specialists:

```yaml
task_groups:
  - name: authentication-system
    assigned_specialist: backend-specialist
  - name: user-dashboard
    assigned_specialist: frontend-specialist
  - name: database-schema
    assigned_specialist: database-specialist
  - name: integration-tests
    assigned_specialist: test-specialist
```

Claude reads this and delegates appropriately.

### Progressive Enhancement

Start simple, enhance iteratively:

```
1. /shape-spec → Basic requirements
2. /write-spec → Detailed spec
3. /create-tasks → Initial tasks
4. [Review and refine]
5. /orchestrate-tasks → Optimize execution
6. /implement-tasks → Execute
```

### Context Management

**Keep Context Focused:**
- Reference specific specs: `fabric/specs/2024-01-15-auth/spec.md`
- Point to standards: `fabric/standards/global/coding-style.md`
- Use agents for domain expertise: `@backend-specialist`

**Avoid Context Overload:**
- Don't paste entire files
- Reference file paths instead
- Use agents to encapsulate expertise

## Tips for Maximum Productivity

### 1. Use Task Tool for Parallelism

When you have multiple independent task groups, always choose parallel execution:

```
/implement-tasks
→ Option A: Parallel Execution
```

This can reduce implementation time by 4x or more.

### 2. Leverage Specialists

Don't use generic `@implementer` when a specialist is better:

```
❌ @implementer Build the API
✅ @backend-specialist Design and implement REST API with authentication
```

### 3. Create Claude Projects

Set up a Claude Project for each repository:
- Persistent context
- Faster responses
- Better understanding

### 4. Use Slash Commands

Slash commands provide structure:

```
✅ /shape-spec
❌ "Help me gather requirements"
```

### 5. Update Progress

Keep `tasks.md` updated. Claude uses this to track progress and make decisions.

## Troubleshooting

### Subagents Not Working

**Issue:** Subagent delegation fails
**Solution:** Use `@agent-name` syntax and ensure agent exists in `.claude/agents/`

### Parallel Execution Slow

**Issue:** Task tool not spawning agents in parallel
**Solution:** Ensure tasks are truly independent (no shared dependencies)

### Commands Not Found

**Issue:** `/command` not recognized
**Solution:** Check command exists in `.claude/commands/` and is a `.md` file

## Next Steps

1. **Set up Claude Project** for your repository
2. **Try parallel execution** with `/implement-tasks`
3. **Use specialists** for domain-specific work
4. **Leverage slash commands** for structured workflows
5. **Keep tasks.md updated** for progress tracking

## Resources

- [Claude Code Documentation](https://docs.anthropic.com/claude/docs)
- [Fabric Framework README](../../../README.md)
- [Workflow Guide](../../shared/default/RECOMMENDED_WORKFLOW.md)

