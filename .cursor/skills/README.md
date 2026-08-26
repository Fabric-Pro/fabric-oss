# Cursor Skills

Skills are reusable knowledge modules that provide specialized expertise for specific tasks, technologies, or patterns.

## How to Use Skills

### Reference in Chat

```
Use @.cursor/skills/nextjs-app-router/SKILL.md for this task
```

### Combine with Agents

```
Follow @.cursor/agents/frontend-specialist.md with @.cursor/skills/tailwind-design-system/SKILL.md
```

### Auto-Discovery

Cursor can automatically discover and apply relevant skills based on the task context.

## Available Skills (50)

### Frontend Development

| Skill | Description |
|-------|-------------|
| `nextjs-app-router` | Next.js 13+ App Router patterns |
| `nextjs-server-components` | React Server Components |
| `react-server-actions` | Server Actions for forms |
| `shadcn-ui-components` | shadcn/ui component library |
| `tailwind-design-system` | Tailwind CSS design systems |
| `frontend-component-patterns` | React component patterns |
| `accessibility-wcag` | WCAG accessibility compliance |

### Backend Development

| Skill | Description |
|-------|-------------|
| `api-design` | REST & GraphQL API design |
| `backend-service-patterns` | Service architecture patterns |
| `database-design` | Database schema design |
| `neondb-serverless` | Neon serverless PostgreSQL |
| `convex-backend` | Convex backend platform |
| `convex-realtime` | Realtime features with Convex |
| `data-migration` | Database migration strategies |
| `error-handling-patterns` | Error handling best practices |
| `security-patterns` | Security implementation |

### Testing

| Skill | Description |
|-------|-------------|
| `test-driven-development` | TDD methodology |
| `e2e-testing` | End-to-end testing |
| `playwright-automation` | Playwright test automation |

### DevOps & Infrastructure

| Skill | Description |
|-------|-------------|
| `ci-cd-pipeline` | CI/CD pipeline setup |
| `vercel-deployment` | Vercel deployment |
| `monitoring-observability` | Monitoring & observability |
| `git-workflow` | Git branching strategies |
| `incident-response` | Incident response procedures |

### Code Quality

| Skill | Description |
|-------|-------------|
| `typescript-strict` | Strict TypeScript patterns |
| `code-review` | Code review best practices |
| `refactoring` | Refactoring techniques |
| `debugging-systematic` | Systematic debugging |
| `root-cause-tracing` | Root cause analysis |
| `standards-enforcement` | Standards compliance |
| `performance-optimization` | Performance tuning |

### Documentation & Content

| Skill | Description |
|-------|-------------|
| `documentation-generation` | Auto-generating docs |
| `changelog-generator` | Changelog management |
| `content-research-writer` | Content writing |
| `document-processing-pdf` | PDF processing |
| `document-processing-docx` | DOCX processing |
| `document-processing-xlsx` | XLSX processing |

### Planning & Strategy

| Skill | Description |
|-------|-------------|
| `brainstorming` | Ideation techniques |
| `competitive-research` | Competitive analysis |
| `brand-guidelines` | Brand identity |
| `domain-name-brainstormer` | Domain name ideas |
| `kaizen-continuous-improvement` | Continuous improvement |

### Tools & Utilities

| Skill | Description |
|-------|-------------|
| `mcp-builder` | MCP server development |
| `skill-creator` | Creating new skills |
| `file-organizer` | File organization |
| `invoice-organizer` | Invoice management |
| `meeting-insights-analyzer` | Meeting analysis |
| `artifacts-builder` | Building artifacts |
| `canvas-design` | Design canvas work |
| `threat-hunting` | Security threat analysis |

## Skill Structure

Each skill follows this structure:

```markdown
---
name: skill-name
description: When to use this skill and what it does
---

# Skill Name - Brief Description

## When to use this skill
- [Trigger condition 1]
- [Trigger condition 2]

## Core Concepts
[Key principles and patterns]

## Examples
[Code examples and patterns]

## Resources
[Links to documentation]
```

## Creating New Skills

Use the `skill-creator` skill to create new skills:

```
Use @.cursor/skills/skill-creator/SKILL.md to create a new skill for [topic]
```

## Improving Skills

Run the improve-skills command to enhance skill descriptions:

```
Follow @.cursor/commands/improve-skills.md
```

