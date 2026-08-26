# /plan-product - Product Planning Workflow

> **Usage**: Copy this prompt or reference it with `@.cursor/prompts/plan-product.md`

---

## Workflow Instructions

You are helping me define the product vision, mission, and roadmap.

### PHASE 1: Gather Product Information

Ask me these questions in batches of 2-3:

**Vision & Problem:**
1. What problem are you solving?
2. Who experiences this problem most acutely?
3. What does success look like in 1 year?

**Users & Market:**
4. Who are your primary target users?
5. Are there secondary user groups?
6. What alternatives do users currently have?

**Solution:**
7. What is your core solution?
8. What makes your approach unique?
9. What are the must-have features for MVP?

**Technical:**
10. Any specific technology requirements or preferences?
11. What scale do you need to support initially?
12. Any integration requirements?

**Timeline:**
13. When do you want to launch MVP?
14. What's your development capacity?

### PHASE 2: Create Product Documents

Create `fabric/product/` directory with these files:

#### mission.md
```markdown
# [Product Name]

## Vision
[One-sentence future state]

## Mission
[How you'll achieve the vision]

## Core Problem
[The problem you're solving]

## Target Users

### Primary
- **Who**: [Description]
- **Pain Points**: [List]
- **Goals**: [List]

### Secondary
- **Who**: [Description]
- **Use Case**: [Description]

## Unique Value Proposition
[What makes you different]

## Success Metrics
1. [Metric 1]: [Target]
2. [Metric 2]: [Target]
3. [Metric 3]: [Target]

## Core Values
1. [Value 1]: [Description]
2. [Value 2]: [Description]
3. [Value 3]: [Description]
```

#### roadmap.md
```markdown
# Product Roadmap

## Phase 1: MVP (Target: [Date])
**Goal**: [Phase goal]

### Features
- [ ] [Core feature 1]
- [ ] [Core feature 2]
- [ ] [Core feature 3]

### Success Criteria
- [Criterion 1]
- [Criterion 2]

---

## Phase 2: Growth (Target: [Date])
**Goal**: [Phase goal]

### Features
- [ ] [Feature 1]
- [ ] [Feature 2]

---

## Phase 3: Scale (Target: [Date])
**Goal**: [Phase goal]

### Features
- [ ] [Feature 1]
- [ ] [Feature 2]

---

## Phase 4: Expansion (Future)
**Goal**: [Long-term vision]

### Ideas
- [Future idea 1]
- [Future idea 2]
```

#### tech-stack.md
```markdown
# Technology Stack

## Frontend
- **Framework**: [e.g., Next.js 14]
- **Styling**: [e.g., Tailwind CSS]
- **State**: [e.g., React Query + Zustand]
- **Rationale**: [Why these choices]

## Backend
- **Runtime**: [e.g., Node.js]
- **Framework**: [e.g., Next.js API Routes]
- **Rationale**: [Why]

## Database
- **Primary**: [e.g., PostgreSQL]
- **ORM**: [e.g., Drizzle]
- **Rationale**: [Why]

## Authentication
- **Provider**: [e.g., NextAuth.js]
- **Methods**: [e.g., OAuth, Magic Links]
- **Rationale**: [Why]

## Infrastructure
- **Hosting**: [e.g., Vercel]
- **Database Hosting**: [e.g., Neon]
- **Rationale**: [Why]

## Third-Party Services
- [Service 1]: [Purpose]
- [Service 2]: [Purpose]

## Development Tools
- **Package Manager**: [e.g., pnpm]
- **Testing**: [e.g., Vitest, Playwright]
- **CI/CD**: [e.g., GitHub Actions]
```

### PHASE 3: Summary

```
✅ Product planning complete!

📁 Created: fabric/product/
├── mission.md     - Vision, users, success metrics
├── roadmap.md     - 4-phase development plan
└── tech-stack.md  - Technology decisions

SUMMARY:
- Vision: [One line]
- MVP Target: [Date]
- Primary Users: [Description]
- Core Tech: [Key technologies]

NEXT STEPS:
1. Review the generated documents
2. Run /standards-shaper to create coding standards
3. Run /shape-spec for your first feature
```

---

## Start Now

Ask me: **"What product are you building? Tell me about the problem you're solving."**

