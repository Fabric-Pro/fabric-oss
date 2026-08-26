# Fabric Portal - Project Standards

This directory contains comprehensive coding standards, best practices, and conventions for the Fabric Portal project.

## Purpose

These standards ensure:

- **Consistency** - All code follows the same patterns and conventions
- **Quality** - Best practices are enforced across the codebase
- **Maintainability** - Code is easy to understand and modify
- **Onboarding** - New team members can quickly learn project conventions
- **AI Assistance** - AI coding assistants follow project-specific patterns

## Quick Links

| Category | Key Documents |
|----------|---------------|
| **Getting Started** | [Tech Stack](global/tech-stack.md) • [Conventions](global/conventions.md) |
| **Code Style** | [Coding Style](global/coding-style.md) • [Error Handling](global/error-handling.md) |
| **Backend** | [API Design (oRPC)](backend/api.md) • [Temporal Workflows](backend/temporal.md) |
| **Frontend** | [React Components](frontend/components.md) • [CSS/Styling](frontend/css.md) |
| **Testing** | [Test Writing](testing/test-writing.md) |
| **AI/Agents** | [Agent Development](ai/agents.md) • [LLM Integration](ai/llm-integration.md) |
| **Infrastructure** | [Deployment](infrastructure/deployment.md) • [Monitoring](infrastructure/monitoring.md) |

## Standards Categories

### 🌐 Global Standards

Apply to all code in this project:

| Document | Description |
|----------|-------------|
| [tech-stack.md](global/tech-stack.md) | Official technology stack and versions |
| [coding-style.md](global/coding-style.md) | TypeScript/React coding patterns |
| [conventions.md](global/conventions.md) | Project structure and naming conventions |
| [error-handling.md](global/error-handling.md) | Error handling patterns for API and UI |
| [validation.md](global/validation.md) | Input validation with Zod |
| [commenting.md](global/commenting.md) | Code documentation guidelines |

### 🔧 Backend Standards

For API, database, and server-side code:

| Document | Description |
|----------|-------------|
| [api.md](backend/api.md) | oRPC procedures, routers, and patterns |
| [temporal.md](backend/temporal.md) | Durable workflow development |
| [queries.md](backend/queries.md) | Prisma database queries |
| [models.md](backend/models.md) | Database schema design |
| [migrations.md](backend/migrations.md) | Database migration practices |

### 🎨 Frontend Standards

For React components and UI:

| Document | Description |
|----------|-------------|
| [components.md](frontend/components.md) | React 19 component patterns |
| [css.md](frontend/css.md) | Tailwind CSS and styling |
| [accessibility.md](frontend/accessibility.md) | WCAG accessibility guidelines |
| [responsive.md](frontend/responsive.md) | Responsive design patterns |

### 🧪 Testing Standards

For all testing activities:

| Document | Description |
|----------|-------------|
| [test-writing.md](testing/test-writing.md) | Vitest, RTL, and Playwright patterns |

### 🤖 AI Standards

For AI agents and LLM integration:

| Document | Description |
|----------|-------------|
| [agents.md](ai/agents.md) | Agent development with LangGraph, CopilotKit |
| [llm-integration.md](ai/llm-integration.md) | LLM API best practices |

### 🏗️ Infrastructure Standards

For deployment and operations:

| Document | Description |
|----------|-------------|
| [deployment.md](infrastructure/deployment.md) | Deployment and CI/CD practices |
| [monitoring.md](infrastructure/monitoring.md) | Metrics, logging, and tracing |

## How to Use

### For Developers

1. **Read relevant standards** before starting work on a feature
2. **Reference during development** to ensure compliance
3. **Update standards** when discovering new patterns worth sharing

### For AI Assistants

Standards are automatically:
- Loaded during task orchestration
- Referenced during code generation
- Enforced during code review

### For Code Review

Use standards as a checklist:
- [ ] Follows coding principles
- [ ] Proper error handling
- [ ] Has appropriate tests
- [ ] Security considerations addressed
- [ ] Accessible UI components

## Tech Stack Summary

| Layer | Technologies |
|-------|--------------|
| **Framework** | Next.js 16, React 19, TypeScript 5.9 |
| **Styling** | Tailwind CSS 4.1, Shadcn UI, Radix UI |
| **API** | oRPC, Hono, Zod |
| **Database** | PostgreSQL, Prisma 6.18, Qdrant |
| **Auth** | Better Auth 1.6 |
| **AI** | Vercel AI SDK 6, OpenAI, Anthropic |
| **Workflows** | Temporal |
| **Testing** | Vitest, Playwright, React Testing Library |
| **Build** | pnpm, Turbo, Biome |

## Document Format

Each standard document follows this structure:

```markdown
# [Standard Name]

## Overview
Brief description of what this standard covers.

## When to Apply
- Situation 1
- Situation 2

## Core Principles
Key principles guiding this standard.

## ✅ DO
Good practices with code examples.

## ❌ DON'T
Anti-patterns with explanations.

## Patterns & Examples
Common patterns with full implementations.

## Common Mistakes
Frequent errors and how to avoid them.

## Resources
Links to official docs and further reading.
```

## Maintenance

### When to Update Standards

- New patterns emerge in the codebase
- Framework best practices change
- Team learns better approaches
- New team members have questions

### Update Process

1. Propose changes in a PR
2. Get team review
3. Update affected standards
4. Announce changes to team

## Related Documents

- [AGENTS.md](../../AGENTS.md) - AI assistant guide (root level)
- [RECOMMENDED_WORKFLOW.md](RECOMMENDED_WORKFLOW.md) - Development workflow
- [FABRIC-OVERVIEW.md](FABRIC-OVERVIEW.md) - Project overview

---

**Last Updated**: December 2024  
**Standards Version**: 2.0

*These standards are living documents. Contribute improvements through pull requests.*

