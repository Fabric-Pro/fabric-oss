# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Precedence**: `fabric/standards/*` > `AGENTS.md` > `.augment/rules/*.md`
>
> For detailed architecture, multi-tenant patterns, authorization, API patterns, and database workflows, see `AGENTS.md`. This file covers commands, design context, and operational notes.

## Common Commands

Requires `pnpm@11.25.0` and Node `>=22.19.0`. First run: `pnpm install`.

```bash
# Development
pnpm dev                              # Start all services (Turbo, 25 concurrent)
pnpm --filter web dev                 # Start web app only (port 3001, set via .env.local / Aspire — Next dev itself doesn't pin a port)
pnpm build                            # Build entire monorepo
pnpm start                            # Production start

# Quality
pnpm type-check                       # TypeScript check across all packages
pnpm lint                             # Biome lint
pnpm format                           # Biome format (with write)
pnpm knip                             # Dead-code / dependency check (required CI gate — run from repo root)

# Testing
pnpm test                                         # Full monorepo sweep, one turbo task at a time (--concurrency=1): the heavy vitest suites each saturate the host on their own, so parallel tasks starved suites past their per-test ceilings; on a 32-core box the serialized sweep finished in comparable time with no timeouts (turbo rejects a second --concurrency, override with `pnpm dotenv -e .env.test.local -- turbo test --concurrency=N`). Sources only .env.test.local (meant to hold just the DB URLs; copy .env.test.local.example), never .env.local; shell-exported vars still cross
pnpm --filter web test                            # Run all Vitest unit tests
pnpm --filter web test __tests__/path/to/file     # Run a single test file
pnpm --filter web test --watch path/to/file       # Watch mode for a single test
pnpm --filter web e2e                             # Playwright E2E (interactive)
pnpm --filter web e2e tests/path/to/test.spec.ts  # Single E2E test

# Database (always use migrate dev, NEVER db push)
cd packages/database
npx dotenv -c -e ../../.env.local -- npx prisma migrate dev --name migration_name --schema=./prisma/schema.prisma
pnpm --filter @repo/database generate   # Regenerate Prisma client + Zod schemas
pnpm --filter @repo/database apply:rls  # Apply RLS policies (after tenant table changes)
pnpm --filter @repo/database studio     # Open Prisma Studio
pnpm --filter @repo/database seed:ai-models    # Seed AI model catalog
pnpm --filter @repo/database seed:system-agents # Seed system agents for delegation

# Aspire (infrastructure)
./aspire.sh restart                   # Restart Aspire AppHost + all dependent Docker resources (Postgres, Temporal, LangGraph agents, etc.)
```

## Knip Is a Required CI Check

`pnpm knip` (run from the repo root) must exit 0 on every PR — it checks unused files, unused/unlisted dependencies and binaries, unresolved imports, unused exports/types, and duplicate exports. If your change adds a dependency, an export, or a new file, run it before opening the PR.

**Fix findings at the source**: delete the dead code, or declare the missing dependency in the right workspace `package.json`. Only add a `knip.json` entry/ignore when the code is genuinely invoked outside the import graph (CLI scripts, externally-triggered hooks, generated output) or a false positive you can demonstrate — and say why in the PR. Every existing `knip.json` entry is evidence-backed; do not remove one to "clean up" without reproducing that it's safe.

**Configuration hints are informational and never fail the run.** Two current hints look actionable but are wrong — acting on them breaks the gate:

- *"Remove redundant entry pattern: tests/setup.ts"* (data-analyst) — knip's vitest plugin does not detect that workspace's `setupFiles`; removing the entry makes the file report as unused.
- *"Remove from ignoreDependencies: content-collections"* (apps/web) — `content-collections` is a tsconfig path alias onto the generated `.content-collections/` directory, which exists on dev machines but not on a fresh CI checkout, where the specifier degrades to an unlisted package. The hint only appears locally; removing the ignore fails CI.

Never declare `@react-email/preview-server` in `packages/mail` (react-email auto-installs it; declaring it drags a vulnerable Next.js into the lockfile). The generated `packages/database/prisma/zod/index.ts` barrel is a knip `entry` on purpose — never hand-edit generated code to satisfy knip.

## Important: Do NOT Run `git clean`

**Never run `git clean -fd` or `git clean -fdx` in this repo.** The `agents/` directory contains LangChain agents tracked in git but whose working-tree files can be inadvertently wiped by `git clean`. If you need to clean build artifacts, use `pnpm clean` (turbo) or remove specific directories manually. Running `git clean` has previously deleted the entire `agents/langchain/` subtree (448 files), requiring a full `git checkout -- agents/` restore.

## Windows-native local development

When developing on Windows under .NET Aspire (no WSL), the repo requires a small set of host-specific patches (Docker socket path, `host.docker.internal` aliases, etc.) that **must not be committed**. If you're modifying Aspire / agent containers / temporal-worker locally and see uncommitted edits in those areas, treat them as local-only.

## Architecture Overview

**fabric-portal** is a multi-tenant SaaS monorepo. Every feature must support both personal (`/app/...`) and organization (`/app/{slug}/...`) contexts with strict XOR data isolation.

### Key Packages

| Package | Purpose |
|---------|---------|
| `apps/web` | Next.js 16 application (marketing + SaaS) |
| `packages/api` | oRPC API server — procedures, routers, middleware |
| `packages/auth` | Better Auth (magic links, passkeys, 2FA) |
| `packages/database` | Prisma schema, queries, tenant isolation (`tenant-db.ts`) |
| `packages/ai` | LLM integration (Vercel AI SDK 6, model resolution) |
| `packages/temporal` | Durable workflows and activities |
| `packages/mcp` | Model Context Protocol integration |
| `agents/` | LangGraph agents |

### Multi-Tenant XOR Pattern (Critical)

```typescript
// Always exclusive filtering — never OR
const filter = organizationId
  ? { organizationId, userId }          // Org context
  : { organizationId: null, userId };   // Personal context (null is REQUIRED)
```

Use `tenantProtectedProcedure` (recommended) or `resolveOrganizationId()` for manual control. See `AGENTS.md` for full details.

**The personal arm is no longer a context you route into.** Every account has an
organization, and `organizationId: null` is now a fail-closed default reached only
when something failed to resolve one — code that lands there should treat it as a
bug, not as personal context. The XOR rule itself is unchanged: never `OR` two
tenant predicates. See `docs/adr/018-organization-is-the-only-tenant-context.md`.

**One documented exception: `PromptBinding` resolution.** `getBoundPromptVersion` consults the caller's own `USER` binding *before* the `ORG` one inside an organization, so a personal default prompt overrides the organization's for the person who set it (Fizzy #2068, FR3/FR4). Do not "fix" this back to XOR.

The rule above exists to stop one tenant's **data** reaching another. A prompt binding is not tenant data — it is one person's preference about their own work, and honouring it exposes nobody else's anything. The isolation that matters here is between two *users*, and that stays absolute: every `USER`-scope lookup is filtered by `userId`, so no one ever resolves someone else's override.

Four queries must move together or the UI starts contradicting the runtime: `getBoundPromptVersion` (what runs), `getBindingStatusForPrompts` (the "Default · <tier>" badge), `listPromptCatalog` (the catalog's in-force marker) and `listPromptsForStages` (the stage panel). Pinned by `packages/database/__tests__/personal-override-in-org-context.test.ts`.

The accepted trade-off: an organization's default prompt is a strong recommendation, not an enforcement mechanism. A prompt an organization must be able to *mandate* needs an explicit policy — not a preference the resolver quietly ignores.

### Naming: UserStory (Backend) = Feature (Frontend)

Backend uses `UserStory`, `StoryTask`, `ProjectStoryStatus`. Frontend displays these as "Features" with `F-XXX` identifiers. Do not rename backend models.

## "Get Started" Upkeep

Fabric ships an in-app "Get started" experience — a contextual **drawer** that gives a flag-aware overview of every area and its components, a guided **spotlight tour**, per-page **detailed tours** that spotlight the real in-page components, and one-off "Show me" highlights. It lives in its own module: `apps/web/modules/saas/get-started/`. Three registries are the single source of truth:

- `lib/get-started-registry.ts` — the drawer content (nav areas, project tabs, settings), each item carrying a smart description, its feature-flag gate (`enabled`), and a `data-onboarding-target` anchor for "Show me". Also `GET_STARTED_PAGES` — the per-page detailed tours: for each covered project page, the ordered list of in-page components (each an anchor + title + body, optionally `conditional`) walked by "Tour this page" and the first-visit auto-open.
- `lib/tour-steps.ts` — the guided tour sequence.

Anchors are placed on **live** components: sidebar nav items in `NavBar.tsx` (`onboardingId`); the project tab bar in `ProjectDetails.tsx` (`data-onboarding-target={\`project-tab-${tab.id}\`}`); and the in-page components a page tour spotlights, on the page components themselves (e.g. `ProjectOverview.tsx`, `DocumentsList.tsx`, `StoriesRoadmap.tsx`, `SecurityAccessibilityPage.tsx`). `ProjectDetails.tsx` fires `GET_STARTED_PROJECT_TAB_EVENT` on every tab change so the controller knows which page is on screen (the active tab is client state, not the URL).

**Rule: when you add, rename, or remove a nav destination, project tab, settings page, or a covered in-page component — or gate one behind a feature flag — update the matching registry entry (and its anchor) in the same change.** Gate anything a flag can hide with `enabled`; add tour copy under `onboarding.tour.steps.<id>` in `packages/i18n/translations/en.json` (per-page component copy is inline in `GET_STARTED_PAGES`, no i18n key needed). **When you add a brand-new page, set its `since` to today's ISO date** — a page dated after `ONBOARDING_PAGE_BASELINE` auto-opens its tour once for *existing* users too (a new feature announces itself), not just new-account signups.

This is **enforced by CI**: `apps/web/__tests__/modules/saas/get-started/drift.test.ts` fails when a step / drawer item / page component points at an anchor or project tab that no longer exists, when a required area/group loses coverage, or when a step is missing copy. It also runs a **coverage guard** in the reverse direction — every project tab in `ProjectDetails`' `tabs` array must have a `GET_STARTED_PAGES` tour (or an explicit, commented `PAGE_COVERAGE_EXEMPT` entry), and every tour body must clear a minimum length — so a **new tab can't ship untoured or with placeholder copy**. A red drift test means the guide has gone stale — fix the registry/anchor, don't weaken the test.

## Design Context

### Users
Engineering teams and developers using Fabric as their daily AI-powered SDLC platform. They are professionals doing serious, focused work — planning, writing specs, reviewing code, shipping. The interface must support deep work without distraction. Confidence and clarity matter more than visual novelty.

### Brand Personality
**Ambitious · Elegant · Grounded**

Big vision, refined execution. The product is serious — it handles the full delivery pipeline. The aesthetic signals craft and capability without showmanship. No gimmicks. No decoration for decoration's sake.

### Aesthetic Direction

**The marketing page is the reference.** The recently redesigned marketing page (warm neutrals, serif headlines, uppercase editorial labels, dot-grid textures, deep red accent `#B91C1C`) sets the bar. The SaaS app should feel like the same product — not a separate, cheaper-feeling dashboard bolted on.

**Carry over from the marketing redesign into every app view:**
- **Editorial section labels** — uppercase, wide letter-spacing (`tracking-[0.2em]`), small font size, with the thin vertical red bar prefix (`.editorial-label` pattern)
- **Serif headings** — use `--font-serif` (EB Garamond) for page-level `h1` headings: dashboard hero, empty states, settings page titles
- **Dot-grid backgrounds** — replace animated gradient blob heroes (`animate-pulse rounded-full blur-[100px]`) with the dot-grid texture (`radial-gradient(circle, rgba(0,0,0,0.13) 1px, transparent 1px) 32px 32px`)
- **Warm neutral cards** — stone-toned surfaces (`bg-muted` / `bg-card`) with subtle borders, not elevated glassy white. Cards should feel like paper, not floating panels.

**Explicit anti-patterns to eliminate:**
- Glassmorphism (`backdrop-blur` + semi-transparent backgrounds on cards)
- Animated gradient orbs / blobs (`animate-pulse rounded-full blur-[80px+]`)
- Gradient text on data values (`bg-gradient-to-r bg-clip-text text-transparent` on numbers/metrics)
- `GradientText` component used on anything other than pure decoration
- Hardcoded hex colors (`#3B82F6`, `#8B5CF6`, etc.) — use CSS variable tokens
- `transition-all` on layout elements — use specific property transitions
- `group-hover:scale-110` on icons — too jittery, use opacity or color transitions instead

**Color system:**
- Primary: `--primary` (`#9F2A3A` light / `#c4556a` dark) — deep rose/red, used for CTAs, active states, links
- Secondary: `--secondary` (emerald `#059669` / `#34d399`) — success/AI-active states
- Destructive: `--destructive` (`#dc2626` / `#ef4444`) — errors and danger actions
- Highlight: `--highlight` (`#f59e0b` / `#fbbf24`) — amber, warnings and emphasis
- Accent: `--accent` — neutral hover/tint surface (rose-tinted in light, dark zinc in dark)
- Backgrounds: `--background` (warm stone `#fafaf9` / dark zinc `#18181b`), `--card` (white / `#1c1c1e`), `--muted` (stone-100 / zinc-800)
- All colors via CSS variables — no hardcoded hex in component files

**Typography:**
- Display headings: `--font-display` at `-0.025em` tracking, `font-weight: 600`
- Page h1 / hero titles: `--font-serif` (EB Garamond), `font-weight: 400`, generous line height
- Section labels: `--font-sans`, 11px, uppercase, `tracking-[0.2em]`, `--mkt-tx-4` / `text-muted-foreground`
- Body / UI: `--font-sans`, standard Tailwind scale

### Design Principles

1. **Editorial restraint** — If an element carries no information, it does not exist. Ambient gradient blobs, glassmorphism, decorative scale transforms, and gradient text on data values are removed entirely. Empty space is intentional.

2. **Typography is the hierarchy** — Size, weight, tracking, and family do all the work. Color is used for state and brand, not to create visual interest. A heading is a heading because it is large and serif — not because it has a gradient.

3. **Warm materials, not cold chrome** — Stone neutrals, deep rose warmth, and editorial red create a palette that feels like paper and craft, not a sterile tech dashboard. Cards have texture (dot-grid) before they have shadow.

4. **Motion with purpose, never ambient** — Animations orient users (entrance fades, state transitions, loading indicators). They never loop indefinitely for aesthetic effect. All motion respects `prefers-reduced-motion` via `motion-safe:` Tailwind variants or `@media (prefers-reduced-motion: reduce)` in CSS.

5. **One source of truth for tokens** — Every color value is a CSS variable from the design system (`--primary`, `--muted-foreground`, `--mkt-red`, etc.). Hardcoded hex in component files is a bug, not a style choice. Sparkline colors, chart accents, and status indicators all map to tokens.

### Accessibility Standard
WCAG 2.1 AA minimum. All interactive elements must be keyboard accessible. Persistent animations must be wrapped in `motion-safe:`. Icon-only controls must have `aria-label` or a proper `<Tooltip>`. Skip navigation link required in app shell.

## Temporal Worker Auto-Restart

After making code changes to any files under `packages/temporal/`, automatically restart the temporal worker using the Aspire MCP tools so the changes take effect:

1. Use `mcp__aspire__execute_resource_command` with resource `temporal-worker` and command `resource-restart`
2. Do this after staging the changes but before asking the user to test

Replay validation for non-determinism runs automatically in CI on PRs to `master` when `packages/temporal/src/workflows/**` changes (see `.github/workflows/temporal-replay-validation.yml`). To run it locally against a fresh set of dev histories: `pnpm --filter @repo/temporal fetch:replay-histories && pnpm --filter @repo/temporal test:replay` (requires `TEMPORAL_*` env vars).

## When Tests Fail

**Default to "the test caught a real issue" — not "the test is stale."** Before
modifying a failing test's assertion, mock setup, or expected value, prove the
production code is correct:

1. **Read the source the test exercises.** Map the failing assertion to the
   source line that produced the actual value. If the source dropped a behavior
   the test asserted (e.g., a title prefix, a header, an audit-log call), that
   may be a real regression — surface it to the user before touching the test.
2. **Check git history** for the source file (`git log -p <file>` and `git
   blame`) to see when/why the behavior changed. If the change was deliberate
   (referenced in a PR/spec), updating the test is fine. If it was incidental
   or recent and undocumented, treat it as a regression.
3. **Only update the test when the source is the source of truth.** Legitimate
   reasons: the API surface deliberately moved (e.g., oRPC version bump
   relocated the handler), the schema deliberately changed, the contract was
   intentionally simplified. Document the reasoning in the commit message.

If unsure, ask the user: *"this test asserts X but the source no longer does X
— is this a regression I should fix in the source, or did we deliberately drop
X?"* Don't paper over the divergence by silently weakening the assertion.

This applies equally to skipping a failing test ("temporarily disable") and to
changing an `expect(...)` value to match the new output. Both hide regressions.

## Identifiers — Never Write a Real One

**This repository is public.** File content, commit messages, branch names, PR titles and PR bodies are visible the moment they are pushed and cannot be retracted once cloned.

A ticket's title, description and comments often name a real organization, deployment or person. **That context is for your understanding — it never goes into what you write.** Describe what the change does, not who it is for:

- **Code comments and doc-comments** — "compliance-sensitive deployments expect ≥90 days", not the name of one
- **Runtime strings** — the worst place for a real name is a message an operator sees; there was one in `instrumentation.ts` for months
- **UI placeholder text, example values, fixtures** — `example-org`, `example.com`, `dev@example.com`; never a real organization, domain, colleague or identity GUID
- **Branch names, commit subjects and bodies, PR titles and descriptions** — write a specific, descriptive subject; a vague one is worse. Cite the ticket by number (`Fizzy #1263`) so the reference stays stable. Reusing a ticket's own title is fine — just check it for a real name first, since that is the usual way one arrives
- **Changeset bodies** — the rich internal context below line 1 is wanted and stays, but keep real names, hostnames and internal URLs out of it; that detail belongs in the ticket

Enforced by the identifier scan in the `security` CI check and the local `pre-commit` / `commit-msg` hooks, which report a rule number without echoing the matched text. Treat a hit as a real finding: rewrite it generically rather than looking for a way around the check. See `CONTRIBUTING.md` § Placeholder Data.

**Screenshots:** capture from a demo environment with synthetic data. Never attach an image of a real deployment to a PR — one screenshot exposes the organization name, project names and live data at once, and GitHub keeps attachment URLs reachable after the comment is deleted.

## Landing a PR: the OSS relay

Never run `gh pr merge` here; a ruleset blocks it. PRs land by relay and close as `relayed`.

To land a PR, in this order:

1. `HEAD=$(gh pr view <n> --json headRefOid --jq .headRefOid)`
2. `gh api -X POST repos/Fabric-Pro/fabric-dev/issues/<n>/comments -f body="/relay $HEAD"`
3. `gh api -X POST repos/Fabric-Pro/fabric-dev/issues/<n>/labels -f 'labels[]=ready-for-relay'`

Do this as soon as the PR is ready; do not wait for checks. The relay waits by itself for the six required checks (type-check, unit-tests, Biome, changeset, DCO, security) on that head, so authorizing early costs nothing, and a red check never wastes a relay attempt. Four of those — type-check, unit-tests, Biome and the changeset check — run only on the public relay PR and are skipped in this repo, so a failure in any of them surfaces here as a relay refusal comment rather than a red check on this PR.

After any push, repeat steps 1 and 2 with the new head. Never edit a `/relay` comment; an edited one no longer authorizes.

Done means: the PR is closed with the `relayed` label and a comment naming the public PR and squash SHA. Do not poll more often than every few minutes.

If a `fabric-relay[bot]` comment says the relay refused the change: read its reasons. A failed required check means fix, push, and repeat steps 1 and 2. A labeled PR that gets no relay comment at all after its checks finish is missing step 2 for the current head; the relay posts nothing for that, it just waits for the comment. Do not rebase for a stale base; the relay transplants onto current master itself. Never use `gh pr update-branch`; if the relay reports a conflict, rebase or cherry-pick onto current master and force-push so every commit is authored and committed by you, then repeat steps 1 and 2.

An open, labeled PR with no relay comment is usually waiting on checks or on a transient retry; leave it alone. A failed attempt closes its own public PR; nothing to clean up.

**On Git Bash (Windows), step 2 needs care.** MSYS path conversion rewrites a leading `/relay` into `C:/Program Files/Git/relay`, and the mangled comment authorizes nothing while looking like it worked. Write the body as JSON and post it with `--input`, then read the stored comment back and confirm it reads exactly `/relay <40-char sha>`:

```bash
gh api -X POST repos/Fabric-Pro/fabric-dev/issues/<n>/comments --input relay.json
gh api repos/Fabric-Pro/fabric-dev/issues/<n>/comments --jq '.[-1].body'
```

Only the publication paths are allowed through; anything outside them is refused with "changed file N is outside the publication path allowlist". `.claude/` itself publishes — its agents, commands, hooks and skills are all in the public repo — but `.claude/checklists/` and `.claude/docs/` are denied prefixes, so internal working material such as test checklists belongs on the main checkout, not in the branch you relay. A brand-new top-level directory or root file is refused until the relay's path policy lists it.

## Git Commit and PR Guidelines

- **Always commit with `git commit -s`** (DCO sign-off). Every non-merge commit needs a `Signed-off-by:` trailer matching the commit author — the `DCO` workflow checks this on every PR. Forgot one? `git rebase --signoff origin/master && git push --force-with-lease`. See CONTRIBUTING.md § Developer Certificate of Origin.
- Do NOT include "Co-Authored-By: Claude" or any Claude attribution in commit messages
- Do NOT include "Generated with Claude Code" or similar attribution in PR descriptions
- Keep commit messages and PRs clean and professional without AI tool attribution

## Changesets on PRs

Every PR that touches code needs a `.changeset/*.md` file with **non-empty frontmatter** declaring at least one package bump (typically `"fabric-app": patch`), or the `skip-changeset` label for docs/CI/markdown-only PRs. Empty frontmatter is a silent footgun — the file passes the file-exists check but produces no version bump or CHANGELOG entry, so the change ships invisibly. See `AGENTS.md` § Changesets for the full format and examples.

**Always bump `fabric-app` — never internal `@repo/*` packages.** The deployable app is the only meta-package that drives a release; prod deploy fires off the `v<fabric-app version>` tag. Declaring `"@repo/database": patch` (or `@repo/api`, `@repo/web`, `@repo/temporal`, etc.) cascades patch bumps to every workspace package that depends on them via `updateInternalDependencies: "patch"` — a single such changeset turns a clean one-package release PR into a 25-package, 100+ file noise wall (this was the regression in PR #1161). Public-npm packages under `@fabricorg/*` are the only exception: bump them in frontmatter when the change ships a new public release of that specific package.

**Body convention (LLM-generated changesets):** Line 1 of the body is the published CHANGELOG headline — one sentence, ≤150 chars, no soft-wrap. Everything below the first newline is internal context (diagnosis, staging traces, file lists, test counts) that the formatter at `.changeset/changelog-formatter.cjs` drops from the rendered CHANGELOG. Add a blank line before that context for readability — the formatter only reads line 1 regardless. Write rich bodies for `git log` archaeology, but always lead with a strong headline. **Keep ticket numbers out of the headline**: it is published verbatim to the public CHANGELOG, so cite `Fizzy #N` in the commit subject and the PR instead. The internal context below the headline may reference the ticket, as a commit body does.
