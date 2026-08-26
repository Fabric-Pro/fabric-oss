# Fabric Cursor Commands

This directory contains workflow commands that guide you through the Fabric development process. Commands are organized into numbered workflows for sequential processes.

## Available Commands

### Product Planning Workflow
| Step | Command | Description |
|------|---------|-------------|
| 1 | `1-product-concept.md` | Gather product information |
| 2 | `2-create-mission.md` | Document product mission |
| 3 | `3-create-roadmap.md` | Create product roadmap |
| 4 | `4-create-tech-stack.md` | Document tech stack |

### Spec Writing Workflow
| Step | Command | Description |
|------|---------|-------------|
| 1 | `1-initialize-spec.md` | Initialize spec folder structure |
| 2 | `2-shape-spec.md` | Gather and document requirements |

### Task Creation Workflow
| Step | Command | Description |
|------|---------|-------------|
| 1 | `1-get-spec-requirements.md` | Locate spec and requirements files |
| 2 | `2-create-tasks-list.md` | Break spec into actionable tasks |

### Implementation Workflow
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

### Option 1: Reference in Chat

Reference the command file using `@`:

```
Follow @.cursor/commands/1-product-concept.md
```

### Option 2: Copy and Paste

Open the command file and copy its contents into the chat.

### Option 3: Sequential Workflow

Follow numbered commands in order:

```
@.cursor/commands/1-product-concept.md
→ @.cursor/commands/2-create-mission.md
→ @.cursor/commands/3-create-roadmap.md
→ @.cursor/commands/4-create-tech-stack.md
```

## Commands vs Prompts

- **Commands** (this folder): Sequential workflow steps, designed to be run in order
- **Prompts** (`.cursor/prompts/`): Standalone prompts that can be run independently

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
│  3-create-roadmap          /write-spec (prompt)                 │
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

## Tips

1. **Follow the numbers**: Commands are numbered for a reason - follow them in order
2. **Reference previous outputs**: Each command builds on the previous one
3. **Check confirmation messages**: Each command outputs a "NEXT STEP" suggestion
4. **Use with prompts**: Commands work alongside the prompts in `.cursor/prompts/`

