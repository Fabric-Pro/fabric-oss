# Fabric Augment Commands

This directory contains workflow commands that guide you through the Fabric development process.

## Available Commands

### Standalone Commands

| Command | Description | When to Use |
|---------|-------------|-------------|
| `/plan-product` | Define product vision and roadmap | Starting a new product |
| `/standards-shaper` | Create project coding standards | Once per project, at start |
| `/shape-spec` | Gather feature requirements | Before building any feature |
| `/write-spec` | Create detailed specification | After shaping requirements |
| `/create-tasks` | Break spec into tasks | After writing spec |
| `/orchestrate-tasks` | Plan implementation strategy | Before implementing |
| `/implement-tasks` | Execute implementation | After creating tasks |

### Sequential Workflow Commands

**Product Planning Workflow:**
| Step | Command | Description |
|------|---------|-------------|
| 1 | `1-product-concept.md` | Gather product information |
| 2 | `2-create-mission.md` | Document product mission |
| 3 | `3-create-roadmap.md` | Create product roadmap |
| 4 | `4-create-tech-stack.md` | Document tech stack |

**Spec Writing Workflow:**
| Step | Command | Description |
|------|---------|-------------|
| 1 | `1-initialize-spec.md` | Initialize spec folder structure |
| 2 | `2-shape-spec.md` | Gather and document requirements |

**Task Creation Workflow:**
| Step | Command | Description |
|------|---------|-------------|
| 1 | `1-get-spec-requirements.md` | Locate spec and requirements files |
| 2 | `2-create-tasks-list.md` | Break spec into actionable tasks |

**Implementation Workflow:**
| Step | Command | Description |
|------|---------|-------------|
| 1 | `1-determine-tasks.md` | Confirm which tasks to implement |
| 2 | `2-implement-tasks.md` | Execute task implementation |
| 3 | `3-verify-implementation.md` | Verify and report on implementation |

### Utility Commands
| Command | Description |
|---------|-------------|
| `improve-skills.md` | Analyze and improve skill definitions |

## How to Use

### Option 1: Interactive Mode

In Auggie's interactive mode, use commands directly:

```
/shape-spec
```

### Option 2: Reference Files

Reference workflow commands:

```
Follow .augment/commands/shape-spec.md
```

### Option 3: Sequential Workflow

Follow numbered commands in order:

```
.augment/commands/1-product-concept.md
→ .augment/commands/2-create-mission.md
→ .augment/commands/3-create-roadmap.md
→ .augment/commands/4-create-tech-stack.md
```

## Workflow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     FABRIC WORKFLOWS                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  PRODUCT PLANNING          FEATURE DEVELOPMENT                  │
│  ─────────────────         ───────────────────                  │
│                                                                 │
│  1-product-concept         1-initialize-spec                    │
│       ↓                         ↓                               │
│  2-create-mission          2-shape-spec                         │
│       ↓                         ↓                               │
│  3-create-roadmap          /write-spec                          │
│       ↓                         ↓                               │
│  4-create-tech-stack       1-get-spec-requirements              │
│                                 ↓                               │
│                            2-create-tasks-list                  │
│                                 ↓                               │
│                            1-determine-tasks                    │
│                                 ↓                               │
│                            2-implement-tasks                    │
│                                 ↓                               │
│                            3-verify-implementation              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## File Outputs

### Product Planning Commands
```
fabric/product/
├── mission.md
├── roadmap.md
└── tech-stack.md
```

### Spec Commands
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

### Implementation Commands
```
fabric/specs/YYYY-MM-DD-feature/
└── verification-report.md
```

## Tips

1. **Follow the numbers**: Commands are numbered for a reason - follow them in order
2. **Reference previous outputs**: Each command builds on the previous one
3. **Check confirmation messages**: Each command outputs a "NEXT STEP" suggestion
4. **Use with rules**: Commands work alongside the agent rules in `.augment/rules/`
