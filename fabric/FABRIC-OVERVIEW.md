# 🧵 Fabric - Spec-Driven Development for AI Agents

**Transform how you build software with AI agents**. Fabric is a complete framework that brings structure, standards, and systematic workflows to AI-assisted development.

## The Fabric Workflow

Fabric follows a proven 8-phase cycle for building features:

```
┌─────────────────────────────────────────────────────────────┐
│                    FABRIC WORKFLOW                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Phase 0: Setup Standards        → /standards-shaper        │
│           ↓                                                 │
│  Phase 1: Product Planning       → /plan-product            │
│           ↓                                                 │
│  Phase 2: Spec Shaping           → /shape-spec              │
│           ↓                                                 │
│  Phase 3: Spec Writing           → /write-spec              │
│           ↓                                                 │
│  Phase 4: Task Creation          → /create-tasks            │
│           ↓                                                 │
│  Phase 5: Task Orchestration     → /orchestrate-tasks       │
│           ↓                                                 │
│  Phase 6: Implementation         → /implement-tasks         │
│           ↓                                                 │
│  Phase 7: Continuous Improvement → iterate & refine         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
fabric/
├── FABRIC-OVERVIEW.md    # This file
├── standards/            # Your team's coding standards
│   ├── global/           # Global conventions
│   ├── backend/          # API, database patterns
│   ├── frontend/         # Components, styling
│   └── testing/          # Test patterns
├── product/              # Product documentation
│   ├── mission.md        # Vision and mission
│   ├── roadmap.md        # Feature roadmap
│   └── tech-stack.md     # Technology decisions
└── specs/                # Feature specifications
    └── YYYY-MM-DD-feature/
        ├── README.md
        ├── spec.md       # Detailed specification
        ├── tasks.md      # Implementation tasks
        └── planning/
            ├── requirements.md
            ├── decisions.md
            └── visuals/
```

---

## Universal Prompts (Copy & Paste)

Use these prompts with any AI assistant. Replace the command path with your platform:

- **Cursor**: `@.cursor/prompts/[command].md`
- **Augment**: `@.augment/commands/[command].md`
- **Claude Code**: `@.claude/commands/[command].md`

### Phase 0: Setup Standards

```
Analyze this project and create customized coding standards following 
@.cursor/prompts/standards-shaper.md

Detect our tech stack, extract patterns from the codebase, and create 
project-specific standards in fabric/standards/ and fabric/product/
```

### Phase 1: Product Planning

```
Help me define the product vision and roadmap following 
@.cursor/prompts/plan-product.md

Create mission.md, roadmap.md, and tech-stack.md in fabric/product/
Ask me the necessary questions to understand our product goals.
```

### Phase 2: Spec Shaping

```
I want to shape requirements for a new feature following 
@.cursor/prompts/shape-spec.md

Feature: [describe your feature here]

Ask clarifying questions, gather requirements, and create the spec folder 
structure in fabric/specs/
```

### Phase 3: Spec Writing

```
Write a detailed specification for the shaped feature following 
@.cursor/prompts/write-spec.md

Read the requirements from fabric/specs/[feature]/planning/ and create 
a comprehensive spec.md with architecture, APIs, data models, and more.
```

### Phase 4: Task Creation

```
Break down the specification into implementable tasks following 
@.cursor/prompts/create-tasks.md

Read fabric/specs/[feature]/spec.md and create tasks.md with logical 
task groups, acceptance criteria, and effort estimates.
```

### Phase 5: Task Orchestration

```
Plan the implementation order for the tasks following 
@.cursor/prompts/orchestrate-tasks.md

Analyze dependencies, identify parallelization opportunities, and create 
milestones with completion criteria.
```

### Phase 6: Implementation

```
Implement the feature tasks following 
@.cursor/prompts/implement-tasks.md

Load the spec, tasks, and standards. Follow TDD - write tests first, 
then implement. Mark tasks complete as we go.
```

### Phase 7: Continuous Improvement

```
Verify and improve the implementation following the Fabric workflow.

Review against:
- fabric/specs/[feature]/spec.md - All requirements met?
- fabric/specs/[feature]/tasks.md - All tasks complete?
- fabric/standards/ - Standards followed?

Run tests, check coverage, identify improvements, and document lessons learned.
```

### Quick Start (All-in-One)

```
I want to build a new feature using the Fabric spec-driven workflow.
Read fabric/FABRIC-OVERVIEW.md to understand the process, then help me 
start with Phase 0 (standards) or Phase 2 (spec shaping) depending on 
whether this project already has standards set up.
```

---

## Quick Reference

### Slash Commands (for supported editors)

| Phase | Command | Purpose |
|-------|---------|---------|
| 0 | `/standards-shaper` | Create coding standards |
| 1 | `/plan-product` | Define product vision |
| 2 | `/shape-spec` | Gather requirements |
| 3 | `/write-spec` | Write detailed spec |
| 4 | `/create-tasks` | Break into tasks |
| 5 | `/orchestrate-tasks` | Plan implementation |
| 6 | `/implement-tasks` | Execute implementation |
| 7 | (manual) | Iterate & refine |

### 14 Specialized Agents

| Agent | Expertise |
|-------|-----------|
| `product-planner` | Product strategy, roadmaps |
| `spec-shaper` | Requirements gathering |
| `spec-writer` | Writing specifications |
| `spec-verifier` | Validating specs |
| `spec-initializer` | Creating spec folders |
| `tasks-list-creator` | Task breakdown |
| `implementer` | Full-stack development |
| `implementation-verifier` | Testing & verification |
| `backend-specialist` | APIs, databases, server-side |
| `frontend-specialist` | UI, components, styling |
| `database-specialist` | Schema, migrations, queries |
| `test-specialist` | Unit, integration, E2E tests |
| `devops-specialist` | CI/CD, deployment |
| `full-stack-specialist` | End-to-end features |

---

## Best Practices

### ✅ DO:

1. **Start with Standards** - Run Phase 0 before your first feature
2. **Always Shape Before Writing** - Phase 2 → 3 → 4 → 5 → 6
3. **Break Down Complex Tasks** - Database → API → UI → Tests
4. **Reference Specs in Code** - `// See fabric/specs/2024-11-24-auth/spec.md Section 4.2`
5. **Keep Standards Updated** - Add new patterns as you discover them
6. **Commit fabric/ to Git** - Share with your team

### ❌ DON'T:

1. **Skip Planning** - Always follow the workflow phases
2. **Write Vague Specs** - Be specific about requirements
3. **Ignore Standards** - Follow fabric/standards/ patterns
4. **Mix Concerns** - Separate frontend, backend, testing tasks
5. **Forget to Commit** - Commit fabric/ to git

---

## Platform Support

| Platform | Config Location | Content |
|----------|-----------------|---------|
| **Cursor** | `.cursor/` | rules/, prompts/ |
| **Claude Code** | `.claude/` | agents/, commands/ |
| **Augment (Auggie)** | `.augment/` | rules/, commands/ |
| **Cline** | `.cline/` | prompts/ |
| **VS Code** | `.vscode/fabric/` | snippets/ |
| **All Platforms** | `fabric/` | standards/, product/, specs/ |

---

## Learn More

- **GitHub**: https://github.com/fabric-ai/fabric-cli
- **Documentation**: See README.md in the repository

**Ready to build? Start with Phase 0: Setup Standards!**

