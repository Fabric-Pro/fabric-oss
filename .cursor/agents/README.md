# Cursor Agents

Agents are specialized AI personas that can be invoked for specific development tasks. They complement the `.mdc` rules files in `.cursor/rules/`.

## Agents vs Rules

| Aspect | Agents (`.md`) | Rules (`.mdc`) |
|--------|---------------|----------------|
| Format | Markdown | Cursor MDC format |
| Usage | Reference with `@` | Auto-apply via globs |
| Purpose | Explicit invocation | Contextual activation |
| Location | `.cursor/agents/` | `.cursor/rules/` |

## Available Agents

### Development Specialists

| Agent | Description | Best For |
|-------|-------------|----------|
| `backend-specialist` | APIs, databases, server-side | Backend features |
| `frontend-specialist` | Components, UI, styling | Frontend features |
| `database-specialist` | Schema, migrations, queries | Database work |
| `devops-specialist` | CI/CD, deployment, infra | Infrastructure |
| `full-stack-specialist` | End-to-end features | Full features |
| `test-specialist` | Testing strategies, coverage | Test writing |

### Workflow Specialists

| Agent | Description | Best For |
|-------|-------------|----------|
| `product-planner` | Product vision, roadmaps | Planning phase |
| `spec-initializer` | Spec folder setup | Starting specs |
| `spec-shaper` | Requirements gathering | Shaping phase |
| `spec-writer` | Detailed specifications | Writing specs |
| `spec-verifier` | Spec quality checks | Verification |
| `tasks-list-creator` | Task breakdown | Task creation |
| `implementer` | Task implementation | Building |
| `implementation-verifier` | Final verification | QA phase |

## How to Use

### Option 1: Reference in Chat

```
Use @.cursor/agents/backend-specialist.md to implement the API
```

### Option 2: Combine with Rules

```
Follow @.cursor/agents/frontend-specialist.md with @.cursor/rules/frontend-specialist.mdc
```

### Option 3: Reference in Commands

Commands can delegate to agents:

```markdown
Delegate this task to @.cursor/agents/implementer.md
```

## Agent Structure

Each agent file follows this structure:

```markdown
---
name: agent-name
description: When to use this agent
---

# Agent Name

[Agent persona and expertise]

## Core Expertise
[List of specialties]

## Implementation Workflow
[Step-by-step approach]

## Technology Patterns
[Code examples]

## Standards Compliance
[References to standards]
```

## Customization

Feel free to modify these agents for your team:

1. Add team-specific patterns
2. Update technology examples
3. Add links to internal documentation
4. Customize workflows

