# Tech Stack

## Overview

This document defines the official technology stack for the Fabric Portal project. All development work should use these technologies and versions.

## Framework & Runtime

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| **Application Framework** | Next.js | 16.0.1 | React framework with App Router |
| **Language** | TypeScript | 5.9.3 | Type-safe JavaScript |
| **Runtime** | Node.js | ≥22 | Server runtime |
| **Package Manager** | pnpm | 10.34.5 | Monorepo package management |
| **Build System** | Turbo | 2.6.0 | Monorepo build orchestration |

## Frontend

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| **UI Library** | React | 19.2.0 | Component library |
| **CSS Framework** | Tailwind CSS | 4.1.16 | Utility-first styling |
| **Component Library** | Shadcn UI + Radix UI | Latest | Accessible, unstyled components |
| **Rich Text Editor** | TipTap | 3.10.7 | Document editing |
| **Workflow Canvas** | React Flow (@xyflow/react) | 12.9.3 | Visual workflow builder |
| **Form Management** | React Hook Form | 7.66.0 | Form state and validation |
| **State Management** | TanStack Query | 5.90.6 | Server state management |
| **URL State** | nuqs | 2.7.2 | Type-safe URL state |
| **Animations** | Motion | 12.23.24 | Animation library |
| **Icons** | Lucide React | 0.552.0 | Icon library |
| **Themes** | next-themes | 0.4.6 | Dark/light mode |

## Backend & API

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| **API Framework** | oRPC | 1.10.3 | Type-safe RPC |
| **HTTP Server** | Hono | 4.10.4 | Fast web framework |
| **Authentication** | Better Auth | 1.3.34 | Auth with magic links, passkeys, 2FA |
| **Validation** | Zod | 4.1.12 | Schema validation |
| **Workflow Orchestration** | Temporal | Latest | Durable workflow execution |

## Database & Storage

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| **Primary Database** | PostgreSQL | 16+ | Relational database |
| **ORM** | Prisma | 6.18.0 | Database ORM with Zod generation |
| **Vector Database** | Qdrant | Latest | RAG/embeddings storage |
| **File Storage** | AWS S3 | - | Document/avatar storage |
| **Caching** | - | - | (Not currently implemented) |

## AI & LLM Integration

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| **AI SDK** | Vercel AI SDK | 5.0.87 | Unified AI interface |
| **OpenAI** | OpenAI SDK | 6.8.0 | GPT models |
| **Anthropic** | Anthropic SDK | Latest | Claude models |
| **Agent UI** | CopilotKit | 1.10.6 | AI copilot interface |
| **Agent Protocol** | AG-UI Protocol | 0.0.39 | Agent communication |

## Testing & Quality

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| **Unit Testing** | Vitest | 3.0.4 | Fast unit tests |
| **E2E Testing** | Playwright | 1.56.1 | Browser automation |
| **Component Testing** | React Testing Library | 16.2.0 | React component tests |
| **Linting/Formatting** | Biome | 2.3.3 | Fast linting and formatting |

## Infrastructure

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| **Service Orchestration** | .NET Aspire | Latest | Local dev orchestration |
| **Monitoring** | Prometheus + Grafana | Latest | Metrics and dashboards |
| **Tracing** | OpenTelemetry | Latest | Distributed tracing |

## Third-Party Services

| Category | Technology | Purpose |
|----------|------------|---------|
| **Email** | Resend | Transactional email |
| **Payments** | Stripe, Lemon Squeezy, Polar | Payment processing |
| **Web Scraping** | Firecrawl | Web content extraction |
| **Issue Tracking** | Linear, GitHub | Project management |
| **MCP** | Model Context Protocol | AI tool integration |

## Version Policy

- **Major Framework Updates**: Evaluate quarterly, apply after testing
- **Security Patches**: Apply within 48 hours
- **Minor Updates**: Bundle with feature releases
- **Lock Files**: Always commit `pnpm-lock.yaml`

## Adding New Dependencies

1. **Check existing packages** - Avoid duplicate functionality
2. **Evaluate bundle size** - Use bundlephobia.com
3. **Check maintenance status** - Active development, security updates
4. **Prefer workspace packages** - Use `@repo/*` when available
5. **Document the decision** - Add to this file if significant
