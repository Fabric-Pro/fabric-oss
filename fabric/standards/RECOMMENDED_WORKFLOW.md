# Recommended Fabric Workflow

This document outlines the **perfect workflow** for using Fabric to plan, spec, and implement features with AI assistance.

## The Complete Development Cycle

```
┌─────────────────────────────────────────────────────────────┐
│                    FABRIC WORKFLOW                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. SETUP STANDARDS        → /standards-shaper             │
│     ↓                                                       │
│  2. PRODUCT PLANNING       → /plan-product                 │
│     ↓                                                       │
│  3. SPEC SHAPING           → /shape-spec                   │
│     ↓                                                       │
│  4. SPEC WRITING           → /write-spec                   │
│     ↓                                                       │
│  5. TASK CREATION          → /create-tasks                 │
│     ↓                                                       │
│  6. TASK ORCHESTRATION     → /orchestrate-tasks            │
│     ↓                                                       │
│  7. IMPLEMENTATION         → /implement-tasks              │
│     ↓                                                       │
│  8. CONTINUOUS IMPROVEMENT → iterate & refine              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Phase-by-Phase Guide

### Phase 0: Setup (One-Time)

**Before starting any development work, establish your project standards.**

#### Commands:
- `/standards-shaper` - Creates comprehensive project standards with dos and don'ts

#### What You Get:
```
fabric/standards/
├── global/
│   ├── coding-principles.md
│   ├── error-handling.md
│   ├── testing.md
│   └── security.md
├── frontend/
│   ├── components.md
│   ├── styling.md
│   └── state-management.md
├── backend/
│   ├── api-design.md
│   ├── database.md
│   └── authentication.md
└── README.md
```

#### Why This Matters:
- **Consistency**: All features follow same patterns
- **Quality**: Standards enforced automatically
- **Speed**: AI knows your preferences upfront
- **Maintainability**: Codebase stays clean and predictable

---

### Phase 1: Product Planning

**Define your product vision, mission, and roadmap.**

#### Commands:
- `/plan-product` - Interactive product planning session

#### What You Get:
```
fabric/product/
├── mission.md        # Vision, goals, target users
├── roadmap.md        # Phased development plan
└── tech-stack.md     # Technology decisions
```

#### When to Use:
- Starting a new product
- Major pivot or refactor
- Adding new team members (onboarding)
- Quarterly planning sessions

#### Example:
```
> /plan-product

AI: Let me help you define your product. What problem are you solving?

You: Building a task management app for remote teams

AI: [Asks clarifying questions about users, features, timeline]
AI: [Creates mission.md, roadmap.md, tech-stack.md]

✅ Product planning complete!
```

---

### Phase 2: Spec Shaping

**Shape the scope and design of a specific feature.**

#### Commands:
- `/shape-spec` - Interactive spec shaping

#### What You Get:
```
fabric/specs/YYYY-MM-DD-feature-name/
├── planning/
│   ├── requirements.md  # Gathered requirements
│   ├── decisions.md     # Key design decisions
│   └── visuals/         # Screenshots, wireframes
└── README.md
```

#### When to Use:
- Before building any new feature
- When requirements are fuzzy
- To validate approach before coding
- For collaborative design discussions

#### Example:
```
> /shape-spec

AI: What feature are you planning?

You: User authentication with OAuth

AI: [Asks about providers, user flows, security needs]
AI: [Saves requirements, decisions, creates spec folder]

✅ Spec shaped! Ready for /write-spec
```

---

### Phase 3: Spec Writing

**Transform shaped requirements into detailed specification.**

#### Commands:
- `/write-spec` - Generates formal spec document

#### What You Get:
```
fabric/specs/YYYY-MM-DD-feature-name/
├── spec.md              # ⭐ Complete specification
├── planning/
│   ├── requirements.md
│   ├── decisions.md
│   └── visuals/
└── README.md
```

#### What `spec.md` Contains:
- Feature overview and objectives
- User stories and acceptance criteria
- Technical architecture
- API contracts
- Database schemas
- UI/UX specifications
- Security considerations
- Testing strategy
- Success metrics

#### Example:
```
> /write-spec

AI: [Reads shaped requirements from previous phase]
AI: [Generates comprehensive spec.md]

✅ Spec written! Ready for /create-tasks
```

---

### Phase 4: Task Creation

**Break down the spec into implementable tasks.**

#### Commands:
- `/create-tasks` - Generates task breakdown

#### What You Get:
```
fabric/specs/YYYY-MM-DD-feature-name/
├── spec.md
├── tasks.md             # ⭐ Implementation tasks
├── planning/
└── README.md
```

#### Task Structure:
```markdown
## Task Group 1: Database Schema
- [ ] Parent Task: Create user authentication tables
  - [ ] Create users table with OAuth fields
  - [ ] Create sessions table
  - [ ] Add indexes for performance
  - [ ] Write migration scripts

## Task Group 2: OAuth Integration
- [ ] Parent Task: Implement OAuth flow
  - [ ] Set up OAuth provider configs
  - [ ] Create callback endpoints
  - [ ] Handle token exchange
  - [ ] Store tokens securely
```

#### Example:
```
> /create-tasks

AI: [Reads spec.md]
AI: [Generates task breakdown in tasks.md]
AI: Found 4 task groups with 23 total tasks

✅ Tasks created! Ready for /orchestrate-tasks
```

---

### Phase 5: Task Orchestration

**Plan and coordinate implementation across task groups.**

#### Commands:
- `/orchestrate-tasks` - Set up implementation coordination

#### What You Get:
```
fabric/specs/YYYY-MM-DD-feature-name/
├── spec.md
├── tasks.md
├── orchestration.yml     # ⭐ Implementation plan
├── implementation/
│   └── prompts/          # Generated implementation prompts
└── planning/
```

#### Orchestration Setup:
1. **Assign specialists** to each task group (Claude Code subagents)
2. **Map standards** to each task group
3. **Generate prompts** for guided implementation

#### Example:
```
> /orchestrate-tasks

AI: Found 4 task groups. Assign specialists:

1. Database Schema → backend-specialist
2. OAuth Integration → backend-specialist
3. Frontend Components → frontend-specialist
4. Testing → test-specialist

AI: Assign standards for each task group:

You: 
1. all
2. backend/*, global/security.md
3. frontend/*, global/error-handling.md
4. global/testing.md

✅ Orchestration ready! Use prompts to implement.
```

---

### Phase 6: Implementation

**Execute the implementation plan.**

#### Commands:
- `/implement-tasks` - Start guided implementation

#### Two Approaches:

##### A. Automated (Claude Code with Subagents)
```
> /orchestrate-tasks

AI: [Delegates to specialized subagents]
AI: [Each subagent implements their task group]
AI: [Progress tracked in tasks.md]

✅ Implementation complete!
```

##### B. Manual (Using Generated Prompts)
```
> /orchestrate-tasks

AI: Created 4 implementation prompts:

fabric/specs/YYYY-MM-DD-feature/implementation/prompts/
├── 1-database-schema.md
├── 2-oauth-integration.md
├── 3-frontend-components.md
└── 4-testing.md

Copy each prompt into chat to guide implementation.
```

#### During Implementation:
- Standards automatically enforced
- Context from spec.md preserved
- Progress tracked in tasks.md
- Specialists follow their expertise

---

### Phase 7: Verification & Testing

**Ensure implementation meets spec requirements.**

#### Built-in Verification:
- Each task references acceptance criteria from spec
- Standards compliance checked automatically
- Tests written according to testing standards
- Code review against project conventions

#### Manual Verification:
```
1. Review completed tasks in tasks.md
2. Run test suite
3. Verify against spec.md acceptance criteria
4. Check standards compliance
5. Security review for sensitive features
```

---

### Phase 8: Iteration & Refinement

**Continuous improvement based on learnings.**

#### Update Standards:
```
fabric/standards/
└── [category]/
    └── [standard].md  # Update with new patterns learned
```

#### Refine Workflow:
- Update mission.md if product direction shifts
- Add to roadmap.md for future phases
- Document lessons learned in spec folder

#### Create New Specs:
- Start new cycle with /shape-spec
- Build on existing standards
- Leverage previous specs as reference

---

## Best Practices

### ✅ DO:

1. **Start with standards** - Run `/standards-shaper` before first feature
2. **Shape before writing** - Use `/shape-spec` to clarify requirements
3. **Break down tasks** - Small, implementable chunks are better
4. **Use orchestration** - Let specialists handle their domains
5. **Track progress** - Keep tasks.md updated as you work
6. **Update standards** - Capture new patterns and decisions
7. **Reference specs** - Link to spec.md in code comments
8. **Iterate** - Refine workflow based on what works

### ❌ DON'T:

1. **Skip planning** - Jumping straight to code causes rework
2. **Write vague specs** - Be specific about requirements
3. **Ignore standards** - They exist for consistency
4. **Mix task groups** - Keep concerns separated
5. **Lose context** - Always reference the spec
6. **Skip testing** - Tests are part of implementation
7. **Forget documentation** - Update as you build
8. **Work in isolation** - Use the workflow for collaboration

---

## Real-World Example

### Scenario: Adding Real-Time Chat Feature

```bash
# Phase 0: Standards already exist
fabric/standards/ ← Created with /standards-shaper

# Phase 1: Product context
> /plan-product
✅ mission.md, roadmap.md, tech-stack.md

# Phase 2: Shape the feature
> /shape-spec
AI: What feature are you planning?
You: Real-time chat with typing indicators

✅ fabric/specs/2024-11-24-realtime-chat/planning/requirements.md

# Phase 3: Write detailed spec
> /write-spec
✅ fabric/specs/2024-11-24-realtime-chat/spec.md

# Phase 4: Break into tasks
> /create-tasks
✅ fabric/specs/2024-11-24-realtime-chat/tasks.md
   (Found: 5 task groups, 31 tasks)

# Phase 5: Orchestrate implementation
> /orchestrate-tasks
AI: Assign specialists...
You: 
1. WebSocket Server → backend-specialist
2. Message Persistence → database-specialist
3. Chat UI → frontend-specialist
4. Typing Indicators → frontend-specialist
5. E2E Tests → test-specialist

✅ fabric/specs/2024-11-24-realtime-chat/orchestration.yml

# Phase 6: Implement (automated)
[Subagents execute in parallel]
✅ All 31 tasks completed
✅ Tests passing
✅ Standards compliant

# Phase 7: Ship it! 🚀
```

---

## Advanced Patterns

### Working with Multiple Features

```
fabric/specs/
├── 2024-11-20-user-auth/      ← Phase 7 (Shipped ✅)
├── 2024-11-22-file-uploads/   ← Phase 6 (Implementing)
└── 2024-11-24-realtime-chat/  ← Phase 3 (Spec written)
```

### Sharing Standards Across Teams

```
fabric/standards/
├── global/           ← Shared by all teams
├── frontend/         ← Frontend team standards
├── backend/          ← Backend team standards
├── mobile/           ← Mobile team standards
└── infrastructure/   ← DevOps standards
```

### Integration with CI/CD

```yaml
# .github/workflows/standards-check.yml
- name: Check standards compliance
  run: |
    # Lint against fabric/standards/
    # Run tests defined in standards/global/testing.md
    # Verify API contracts match spec.md
```

---

## Command Quick Reference

| Phase | Command | Purpose |
|-------|---------|---------|
| 0 | `/standards-shaper` | Create project standards |
| 1 | `/plan-product` | Define product vision |
| 2 | `/shape-spec` | Gather feature requirements |
| 3 | `/write-spec` | Create detailed specification |
| 4 | `/create-tasks` | Break spec into tasks |
| 5 | `/orchestrate-tasks` | Plan implementation |
| 6 | `/implement-tasks` | Execute implementation |
| - | `/improve-skills` | Enhance AI capabilities |

---

## Summary

The Fabric workflow transforms chaotic development into a systematic process:

1. **Standards** define how to build
2. **Planning** defines what to build
3. **Specs** define why to build it
4. **Tasks** define the steps to build it
5. **Orchestration** coordinates who builds what
6. **Implementation** actually builds it
7. **Iteration** improves the process

**Start here**: `/standards-shaper` → `/plan-product` → `/shape-spec`

---

**Questions?** Check `fabric/standards/README.md` or explore command files in `.claude/commands/` or `.factory/commands/`
