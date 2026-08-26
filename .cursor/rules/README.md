# Fabric Cursor Rules (Agents)

This directory contains Cursor-compatible rule files that define specialized AI agents for the Fabric workflow.

## Available Agents

| Agent | Description | Use Case |
|-------|-------------|----------|
| `implementer` | Full-stack implementation | Building features from specs |
| `spec-shaper` | Requirements gathering | Shaping feature requirements |
| `spec-writer` | Specification writing | Creating detailed specs |
| `spec-verifier` | Specification review | Validating specs |
| `spec-initializer` | Folder setup | Creating new spec folders |
| `tasks-list-creator` | Task breakdown | Creating implementation tasks |
| `product-planner` | Product strategy | Defining vision and roadmap |
| `implementation-verifier` | Code verification | Ensuring spec compliance |
| `backend-specialist` | Backend development | APIs, databases, server-side |
| `frontend-specialist` | Frontend development | UI, components, UX |
| `database-specialist` | Database design | Schema, migrations, queries |
| `devops-specialist` | DevOps/Infrastructure | CI/CD, deployment |
| `full-stack-specialist` | End-to-end development | Complete features |
| `test-specialist` | Testing | Unit, integration, E2E tests |

## How to Use

### Option 1: Reference in Chat

Mention the agent's purpose to have Cursor use its patterns:

```
I need help implementing the user authentication feature. 
Please follow the implementer workflow from the Fabric rules.
```

### Option 2: @ Mention Rule Files

In Cursor, you can reference rule files directly:

```
@.cursor/rules/implementer.mdc - Please implement the tasks in tasks.md
```

### Option 3: With Prompts

Use the prompts in `.cursor/prompts/` which orchestrate multiple agents:

```
Follow the workflow in @.cursor/prompts/implement-tasks.md
```

## Agent Workflow

```
┌─────────────────────────────────────────────────────┐
│                 FABRIC WORKFLOW                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  1. product-planner    → Define product vision      │
│  2. spec-initializer   → Create spec folder         │
│  3. spec-shaper        → Gather requirements        │
│  4. spec-writer        → Write detailed spec        │
│  5. spec-verifier      → Validate completeness      │
│  6. tasks-list-creator → Break into tasks           │
│  7. implementer        → Build the feature          │
│  8. implementation-verifier → Verify against spec   │
│                                                     │
│  Specialists: backend, frontend, database, devops   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Standards Integration

All agents reference project standards from:

```
fabric/standards/
├── global/       # Coding principles, error handling
├── frontend/     # Component patterns, styling
├── backend/      # API design, database patterns
└── testing/      # Test writing patterns
```

## Customization

These rule files are templates. Customize them for your project:

1. Add project-specific patterns
2. Update tech stack references
3. Add team conventions
4. Include common code examples

