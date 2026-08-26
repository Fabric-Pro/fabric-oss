# Fabric - Spec-Driven Development for AI Agents

**Transform how you build software with AI agents**. Fabric is a complete framework that brings structure, standards, and systematic workflows to AI-assisted development.

## The Fabric Workflow

Fabric follows a proven 8-phase cycle for building features:

```
Phase 0: Setup Standards        → /standards-shaper
Phase 1: Product Planning       → /plan-product
Phase 2: Spec Shaping           → /shape-spec
Phase 3: Spec Writing           → /write-spec
Phase 4: Task Creation          → /create-tasks
Phase 5: Task Orchestration     → /orchestrate-tasks
Phase 6: Implementation         → /implement-tasks
Phase 7: Continuous Improvement → iterate & refine
```

For detailed phase-by-phase guidance, examples, and best practices, see **[RECOMMENDED_WORKFLOW.md](./RECOMMENDED_WORKFLOW.md)**.

## Directory Structure

```
fabric/
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
        ├── spec.md       # Detailed specification
        ├── tasks.md      # Implementation tasks
        └── planning/
            ├── requirements.md
            └── decisions.md
```

## 14 Specialized Agents

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

## Platform Support

| Platform | Config Location |
|----------|-----------------|
| **Cursor** | `.cursor/` |
| **Claude Code** | `.claude/` |
| **Augment** | `.augment/` |
| **Cline** | `.cline/` |
| **All Platforms** | `fabric/` (standards, product, specs) |

## Getting Started

1. **New project?** Start with Phase 0: `/standards-shaper`
2. **Standards exist?** Jump to Phase 2: `/shape-spec` for your next feature
3. **Need details?** See [RECOMMENDED_WORKFLOW.md](./RECOMMENDED_WORKFLOW.md) for the complete guide
