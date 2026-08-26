# /plan-product

Define product vision, mission, and roadmap.

## Purpose

Establish the strategic foundation for your product. This creates shared understanding of goals, priorities, and technical direction.

## When to Use

- Starting a new product or major initiative
- Documenting an existing product
- Aligning team on product direction

## Process

### Step 1: Gather Information

Ask the user about:

1. **Vision**: What future are we creating?
2. **Problem**: What problem does this solve?
3. **Users**: Who are the target users?
4. **Value**: What unique value do we provide?
5. **Success**: How will we measure success?

### Step 2: Create Mission Document

Create `fabric/product/mission.md`:

```markdown
# Product Mission

## Vision
[The future we're creating]

## Mission Statement
[What we do, for whom, and why]

## Problem Statement
[The problem we're solving]

## Target Users
- User type 1: [Description]
- User type 2: [Description]

## Value Proposition
[Our unique value]

## Success Metrics
- Metric 1: [Description]
- Metric 2: [Description]
```

### Step 3: Create Roadmap

Create `fabric/product/roadmap.md`:

```markdown
# Product Roadmap

## Now (Current Quarter)
### Feature 1
- Description: [What it does]
- Goal: [Why we're building it]
- Status: 🔄 In Progress / 📋 Planned

## Next (Next Quarter)
### Feature 2
- Description: [What it does]
- Goal: [Why we're building it]

## Later (Future)
### Feature 3
- Description: [What it does]
- Goal: [Why we're building it]
```

### Step 4: Document Tech Stack

Create `fabric/product/tech-stack.md`:

```markdown
# Technology Stack

## Frontend
- **Framework**: [React, Next.js, Vue, etc.]
- **Styling**: [Tailwind, CSS Modules, etc.]
- **State Management**: [Zustand, Redux, etc.]

## Backend
- **Runtime**: [Node.js, Python, etc.]
- **Framework**: [Express, Fastify, Django, etc.]
- **Database**: [PostgreSQL, MongoDB, Cosmos DB, etc.]

## Infrastructure
- **Hosting**: [Vercel, AWS, etc.]
- **CI/CD**: [GitHub Actions, etc.]
- **Monitoring**: [Tools used]

## Key Libraries
- [Library 1]: [Purpose]
- [Library 2]: [Purpose]
```

## Completion

After creating product documents, inform the user:

```
✅ Product planning complete!

📁 Created:
- fabric/product/mission.md
- fabric/product/roadmap.md
- fabric/product/tech-stack.md

NEXT STEP 👉 Run `/shape-spec` to start building your first feature!
```

