# Fabric Cursor Prompts

This directory contains standalone workflow prompts that guide you through the Fabric development process.

> **Note**: Prompts are standalone commands. For sequential workflows, see `.cursor/commands/`. For specialized agents, see `.cursor/agents/`. For reusable skills, see `.cursor/skills/`.

## Available Prompts

| Prompt | Description | When to Use |
|--------|-------------|-------------|
| `/plan-product` | Define product vision and roadmap | Starting a new product |
| `/standards-shaper` | Create project coding standards | Once per project, at start |
| `/shape-spec` | Gather feature requirements | Before building any feature |
| `/write-spec` | Create detailed specification | After shaping requirements |
| `/create-tasks` | Break spec into tasks | After writing spec |
| `/orchestrate-tasks` | Plan implementation strategy | Before implementing |
| `/implement-tasks` | Execute implementation | After creating tasks |

## How to Use

### Option 1: Reference in Chat

Reference the prompt file:

```
Follow the workflow in @.cursor/prompts/shape-spec.md
```

### Option 2: Copy and Paste

Open the prompt file and copy its contents into the chat.

### Option 3: Describe the Command

Simply say what you want to do:

```
I want to shape a new feature spec. Follow the Fabric workflow.
```

## Recommended Workflow

```
┌─────────────────────────────────────────────────────┐
│                 FABRIC WORKFLOW                     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  1. /standards-shaper  → Create coding standards    │
│     ↓                                               │
│  2. /plan-product      → Define product vision      │
│     ↓                                               │
│  3. /shape-spec        → Gather requirements        │
│     ↓                                               │
│  4. /write-spec        → Write specification        │
│     ↓                                               │
│  5. /create-tasks      → Break into tasks           │
│     ↓                                               │
│  6. /orchestrate-tasks → Plan implementation        │
│     ↓                                               │
│  7. /implement-tasks   → Build the feature          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Related Resources

### Commands (`.cursor/commands/`)
Sequential workflow steps for multi-phase processes:
- `1-product-concept.md` → `2-create-mission.md` → `3-create-roadmap.md` → `4-create-tech-stack.md`
- `1-initialize-spec.md` → `2-shape-spec.md`
- `1-get-spec-requirements.md` → `2-create-tasks-list.md`
- `1-determine-tasks.md` → `2-implement-tasks.md` → `3-verify-implementation.md`

### Agents (`.cursor/agents/`)
Specialized AI personas for specific tasks:
- **Development**: `backend-specialist`, `frontend-specialist`, `database-specialist`, `full-stack-specialist`
- **Workflow**: `spec-initializer`, `spec-shaper`, `spec-writer`, `tasks-list-creator`, `implementer`
- **Quality**: `test-specialist`, `spec-verifier`, `implementation-verifier`

### Rules (`.cursor/rules/`)
Auto-activating context via Cursor's `.mdc` rule system.

### Skills (`.cursor/skills/`)
50+ reusable knowledge modules covering:
- Frameworks: Next.js, React, Tailwind, shadcn/ui
- Backend: API design, database patterns, security
- DevOps: CI/CD, deployment, monitoring
- Testing: TDD, E2E, Playwright

## File Outputs

Each prompt creates files in your project:

### /plan-product
```
fabric/product/
├── mission.md
├── roadmap.md
└── tech-stack.md
```

### /standards-shaper
```
fabric/standards/
├── global/
├── frontend/
├── backend/
└── testing/
```

### /shape-spec & /write-spec
```
fabric/specs/YYYY-MM-DD-feature/
├── README.md
├── planning/
│   ├── requirements.md
│   ├── decisions.md
│   └── visuals/
├── spec.md
└── tasks.md
```

### /orchestrate-tasks
```
fabric/specs/YYYY-MM-DD-feature/
├── orchestration.yml
└── implementation/
    └── prompts/
```

## Tips

1. **Start with standards**: Run `/standards-shaper` before your first feature
2. **Shape before writing**: Don't skip `/shape-spec` - it catches issues early
3. **Small tasks**: Break tasks into 2-4 hour chunks
4. **Reference specs**: Always link back to spec.md in your code
5. **Update as you go**: Keep tasks.md updated with `[x]` as you complete

## Customization

These prompts are templates. Customize them for your workflow:

1. Add project-specific questions to `/shape-spec`
2. Modify spec sections in `/write-spec`
3. Adjust task grouping logic in `/create-tasks`
4. Add custom standards categories
