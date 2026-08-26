# Step 4: Create Tech Stack

> **Usage**: Reference with `@.cursor/commands/4-create-tech-stack.md` or copy into chat

---

## Workflow Instructions

The final part of our product planning process is to document this product's tech stack in `fabric/product/tech-stack.md`.

### Tech Stack Document Structure

```markdown
# [Product Name] Tech Stack

## Overview
[Brief description of the technical architecture]

---

## Frontend

### Framework
- **Primary**: [e.g., Next.js 14]
- **Language**: [e.g., TypeScript 5.x]

### UI & Styling
- **Component Library**: [e.g., shadcn/ui]
- **Styling**: [e.g., Tailwind CSS]
- **Icons**: [e.g., Lucide React]

### State Management
- [e.g., React Query, Zustand]

---

## Backend

### Runtime & Framework
- **Runtime**: [e.g., Node.js 20 / Bun]
- **Framework**: [e.g., Next.js API Routes / Hono]

### API Style
- [REST / GraphQL / tRPC]

---

## Database

### Primary Database
- **Type**: [e.g., PostgreSQL]
- **Provider**: [e.g., Neon, Supabase, PlanetScale]

### ORM / Query Builder
- [e.g., Drizzle ORM, Prisma]

---

## Infrastructure

### Hosting
- **Frontend**: [e.g., Vercel]
- **Backend**: [e.g., Vercel Functions]
- **Database**: [e.g., Neon]

### CI/CD
- [e.g., GitHub Actions]

### Monitoring
- [e.g., Vercel Analytics, Sentry]

---

## Development Tools

### Package Manager
- [bun / pnpm / yarn / npm]

### Testing
- **Unit**: [e.g., Vitest]
- **E2E**: [e.g., Playwright]

### Code Quality
- **Linting**: [ESLint]
- **Formatting**: [Prettier / Biome]
- **Type Checking**: [TypeScript]

---

## Third-Party Services
| Service | Purpose | Provider |
|---------|---------|----------|
| [Auth] | [Authentication] | [Clerk / Auth.js] |
| [Payments] | [Billing] | [Stripe] |
| [Email] | [Transactional] | [Resend] |
```

---

## Display Confirmation and Next Step

Once you've created tech-stack.md, output the following message:

```
✅ I have documented the product's tech stack at `fabric/product/tech-stack.md`.

Review it to ensure all of the tech stack details are correct for this product.

🎉 Product planning complete! You're ready to start planning feature specs.

NEXT STEPS 👉 
- Run @.cursor/prompts/shape-spec.md to start a new feature
- Run @.cursor/prompts/write-spec.md if you already have requirements
```

---

## User Standards & Preferences Compliance

The user may provide information regarding their tech stack, which should take precedence when documenting the product's tech stack. To fill in any gaps, find the user's usual tech stack information as documented in `fabric/standards/` (if it exists).

