# Contributing to Fabric AI

Thank you for your interest in contributing to Fabric AI. This guide covers the development setup, conventions, and process for submitting changes.

Taking part in this project means following our [Code of Conduct](./CODE_OF_CONDUCT.md). To report a possible violation, email fabric.help@techfabric.com.

## Prerequisites

- **Node.js** >= 20
- **pnpm** 10+
- **Docker Desktop** (for infrastructure services)
- **.NET 10 SDK** (optional, for Aspire orchestration)

## Getting Started

```bash
# Clone the repository
git clone https://github.com/Fabric-Pro/fabric-oss.git
cd fabric-oss

# Install dependencies
pnpm install

# Copy environment file
cp .env.example .env.local
# Edit .env.local with your API keys and settings

# Start infrastructure (choose one)
docker-compose up -d          # Docker Compose
./aspire.sh run               # .NET Aspire (recommended)

# Initialize database
pnpm --filter @repo/database generate
cd packages/database
npx dotenv -c -e ../../.env.local -- npx prisma migrate dev --schema=./prisma/schema.prisma
cd ../..

# Seed required data
pnpm --filter @repo/database seed
pnpm --filter @repo/database seed:ai-models
pnpm --filter @repo/database seed:system-agents
pnpm --filter @repo/database apply:rls

# Start development server
pnpm dev
```

Open http://localhost:3001 in your browser.

## Development Workflow

### Branch Naming

Use descriptive branch names with a prefix:

- `feature/` - New features (e.g., `feature/workspace-sharing`)
- `fix/` - Bug fixes (e.g., `fix/tenant-isolation-leak`)
- `docs/` - Documentation changes (e.g., `docs/api-reference`)
- `refactor/` - Code refactoring (e.g., `refactor/auth-middleware`)

### Commit Conventions

Write clear, concise commit messages:

- Use imperative mood: "Add feature" not "Added feature"
- Keep the first line under 72 characters
- Reference issue numbers where applicable

### Database Changes

All schema changes **must** use migrations, never `prisma db push`:

```bash
cd packages/database
npx dotenv -c -e ../../.env.local -- npx prisma migrate dev --name your_migration_name --schema=./prisma/schema.prisma
pnpm --filter @repo/database generate
pnpm --filter @repo/database apply:rls
```

### Quality Checks

Run these before submitting a PR:

```bash
pnpm type-check    # TypeScript validation
pnpm lint          # Biome linting
pnpm format        # Biome formatting
```

### Claude Code hooks

This repo ships Claude Code PreToolUse hooks that enforce destructive-command, secret-file, DB-migration, branch-naming, and pre-PR quality rules. See [`.claude/README.md`](./.claude/README.md) for the full list and the escape-path policy.

### Testing

```bash
pnpm --filter web test          # Unit tests (Vitest)
pnpm --filter web e2e           # E2E tests (Playwright)
pnpm --filter @repo/database test:tenant  # Tenant isolation tests
```

### Pull request scope and evidence

Keep pull requests small and focused. Large features or architectural changes
need a proposal in [GitHub Discussions](https://github.com/Fabric-Pro/fabric-oss/discussions)
before implementation, so maintainers and contributors can agree on the shape
before substantial work begins.

When a test fails, fix the behavior or update the test only when the intended
contract changed. Do not weaken, skip, or delete a failing test merely to make
CI green. Pull requests—including AI-assisted contributions—that show no
evidence of relevant local testing may be closed without detailed review.

## Multi-Tenant Architecture

Every feature **must** support both personal and organization contexts with strict data isolation. See the [Tenant Isolation Guide](/docs/guides/tenant-isolation) for details.

### Feature Checklist

Before submitting a feature PR, verify:

- [ ] Schema has `userId` + `organizationId` columns
- [ ] Queries use XOR pattern (never OR for tenant filtering)
- [ ] Uses `tenantProtectedProcedure` or `resolveOrganizationId()`
- [ ] Page exists in both `(account)/` and `(organizations)/[organizationSlug]/`
- [ ] Components use `useOrganizationContext()`
- [ ] Tested in both personal and organization contexts

## Coding Standards

Detailed standards are in `fabric/standards/`:

- **Global**: `global/coding-style.md`, `global/conventions.md`, `global/error-handling.md`
- **Backend**: `backend/api.md`, `backend/queries.md`, `backend/temporal.md`
- **Frontend**: `frontend/components.md`, `frontend/css.md`, `frontend/accessibility.md`
- **Testing**: `testing/test-writing.md`

### Key Conventions

- Use Biome for linting and formatting (not ESLint/Prettier)
- Prefer React Server Components; minimize `"use client"`
- Use Zod for runtime validation
- Use Tailwind + shadcn/ui for styling
- Keep files under 1000 lines

## Placeholder Data

Use reserved placeholder values in fixtures, tests, examples and documentation — `example.com`, `example-org`, `dev@example.com` — never a real organization, domain, deployment or person.

Write descriptive commit messages and PR titles; a specific subject line is worth more than a vague one. Describe what the change does rather than who asked for it, and cite tickets by number so the reference stays stable.

This applies to everything that becomes public on push, not just source files: commit messages, branch names, PR titles and PR bodies are all permanent and are indexed.

An `Identifiers` check enforces this on every PR, alongside `pre-commit` and `commit-msg` hooks that `pnpm install` wires up. It is configuration-driven and inert without that configuration, so it will not fire on fork PRs. When it does fire it reports a rule number and a location rather than the matched text, both in the log and on the PR's checks page.

Every term blocks; there is no severity that merely warns. A warning attached to a passing check is not a control — nobody reads the output of something green.

**If a finding is a false positive**, there are two escape hatches, and both are deliberate acts rather than silent passes:

- **Locally**, `git commit --no-verify` skips the hooks.
- **In CI**, apply the `identifier-override` label to the PR. The check then reports its findings and passes. Applying a label needs write access, so a fork contributor cannot self-approve, and GitHub records who applied it and when in the PR timeline.

Prefer fixing the text over overriding. A term that produces repeated false positives is a problem with the term list, not with the PR — say so, and it can be narrowed or dropped.

**Branch names are the one input CI cannot protect in time.** Pushing a branch publishes its name; by the time a PR check runs, the name is already on the remote and in the logs of any workflow that fetched it. Only the local hooks catch a branch name before that happens, which is why they matter more than the CI check does. A `pre-push` hook scans every ref about to be published — including the remote name in `git push origin HEAD:other-name` — and aborts the push before anything reaches the remote.

### Keeping the local term list current

The term list cannot live in this repository, so it is distributed out of band as `.blocked-terms` at the repository root. A copy that has fallen behind the shared list is worse than no copy at all: the hooks still run and still look like protection, while checking against terms that have moved on.

The `pre-push` hook therefore checks the list's age before it checks anything else. It reads the shared list's last-changed timestamp — a repository secret's value cannot be read back, but its metadata can — and compares it against your copy. Nothing needs committing when the list grows.

Two comparisons, strongest first. If you have synced, `.blocked-terms.stamp` records exactly which version you hold. If you have not — the normal case for a list handed over out of band — the file's own modification time is used instead: **a copy written before the shared list last changed cannot contain those changes.**

| Your checkout | What happens |
| --- | --- |
| No `.blocked-terms` | Nothing. Presence of the file is what marks a checkout as internal; external contributors and fresh clones are never nagged. |
| Copy is at least as new as the shared list | Nothing. |
| Copy is behind | The list is fetched if a source is configured, and the push then proceeds; otherwise the push is **blocked**. |
| Offline, or no access | One line, and the push proceeds. A push must not depend on GitHub being reachable. |

The modification-time comparison is a heuristic in one direction only: re-saving an old list makes it look current. It is never wrong about a file that has genuinely sat untouched since before the list changed, which is the case that actually occurs. `--accept` upgrades you to the exact comparison.

**Replacing the file is the whole fix** — writing it makes it newer than the shared list, and the next push proceeds. No command is required.

```bash
pnpm terms:sync            # fetch the current list, if a source is configured
pnpm terms:sync --accept   # optional: pin the exact version you hold
pnpm terms:check           # report freshness, change nothing
```

Set `FABRIC_TERMS_SOURCE` to `variable:NAME` or `repo:OWNER/REPO:path[@ref]` to enable automatic fetching; without it, detection still works and `--accept` is the one-line manual path. `pnpm install` fetches the list for you when your machine has none and you have access, so a new contributor is covered from their first commit rather than from whenever someone remembers to send them a file.

One limit worth knowing: `pre-push` covers **ref names and list freshness only**. File content is scanned by `pre-commit` and by CI, so committing with `--no-verify` leaves content unscanned until the PR runs.

**Screenshots are the gap no check can close.** One image of a running deployment exposes an organization name, project names and live data at once, and GitHub keeps attachment URLs reachable even after the comment is deleted. Capture from a demo environment with synthetic data.

## Licensing

Fabric is licensed under **Apache-2.0** for the platform core and **MIT** for the client packages (`packages/cli`, `packages/sdk`, `packages/sdk-mcp`, and the `packages/integrations-*` family). The nine client-package manifests currently declare MIT; the Apache-2.0 core license and the definitive path → license map are established by the root and per-package `LICENSE` files before the public release. Some packages additionally ship third-party notices (see `THIRD_PARTY_NOTICES.md` where present) — incorporated third-party material retains its original license.

**Inbound = outbound:** by contributing, you agree that your contribution is licensed under the same license as the code it modifies — Apache-2.0 for the core, MIT for the client packages. There is no copyright assignment and no CLA.

The source licenses do not grant rights to use Fabric's trademarks as the name
or branding of a derivative product. See the trademark notice in [README.md](./README.md).

## Developer Certificate of Origin (DCO)

Every commit must be signed off, certifying the [Developer Certificate of Origin](https://developercertificate.org/) — a statement that you have the right to submit the change under the project's license. It is a certification, **not** a copyright transfer; you keep your copyright.

```bash
git commit -s -m "Your commit message"
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer, which must match the commit author. A DCO check runs on every PR and is required before merge. Exemptions are limited to merge commits and an authenticated automation allowlist: the changesets release PR, Dependabot, and the corporate OSS Relay App on same-repository `relay/**` branches. The relay path is a corporate contribution authorized out of band and uses `Submitted-on-behalf-of`; it is not DCO and the App does not certify on a human's behalf. Conflict resolutions inside merge commits are not certified, so prefer rebasing over merging when updating your branch. Unsigned PR commits cannot merge.

We squash-merge. The DCO check validates each of your PR commits before merge, and maintainers carry your `Signed-off-by` trailer and `Co-authored-by` credit into the squash commit message — a maintainer cannot certify on your behalf.

## Pull Request Process

1. Create a branch from `master`
2. Make your changes following the conventions above
3. Run quality checks (`type-check`, `lint`, `format`)
4. Run relevant tests
5. Sign off every commit (`git commit -s`, see DCO above)
6. Submit a PR with a clear title and description
7. Address review feedback

### PR Description

Include:
- Summary of changes
- Motivation/context
- Testing performed
- Screenshots for UI changes

## Project Structure

```
fabric-portal/
├── apps/web/          # Next.js application
├── packages/
│   ├── api/           # oRPC API layer
│   ├── auth/          # Authentication (Better Auth)
│   ├── database/      # Prisma schema, queries, tenant isolation
│   ├── ai/            # AI/LLM integration
│   ├── temporal/      # Temporal workflows & activities
│   └── ...            # Supporting packages
├── agents/            # LangGraph agents
├── config/            # App configuration
└── fabric/standards/  # Coding standards
```

## Documentation Discipline

All documentation must follow `DOCUMENTATION_STANDARDS.md`. Key rules:

- **Documentation is minimal and authoritative.** No work logs, fix summaries, or iteration narratives.
- **Iteration belongs in PR descriptions and commit messages**, not in markdown files.
- **Feature descriptions belong in existing topic files.** Update, don't duplicate.
- **All structural changes require an ADR** in `docs/adr/`.
- **AI-generated documentation must be reviewed** before merging. AI updates canonical files; it does not create variants.

See `DOCUMENTATION_STANDARDS.md` for the full policy including prohibited file patterns and directory rules.

## Questions?

Use [GitHub Discussions](https://github.com/Fabric-Pro/fabric-oss/discussions)
for support, questions, and early design proposals. Use issues for reproducible
bugs and accepted feature requests.

Maintainers aim to label and respond to new issues within about three business
days. This is a best-effort target, not a service-level agreement; maintainer
capacity is limited.
