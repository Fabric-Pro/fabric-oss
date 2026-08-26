# Deployment

Multi-environment deployment strategy for Fabric Portal.

- **Audience**: DevOps/Infrastructure
- **Owner**: Platform team

---

## Service Architecture

| Service | Port | Type |
|---------|------|------|
| Next.js Web App | 3001 | Application |
| Temporal Worker | - | Application |
| PartyKit | 1999 | Application |
| PostgreSQL | 5432 | Infrastructure |
| Redis | 6379 | Infrastructure |
| Qdrant | 6333 | Infrastructure |
| Temporal Server | 7233 | Infrastructure |
| MinIO (S3) | 9000 | Infrastructure |
| AI Agents | 8124-8134 | Docker containers |

## Environment Strategy

| Aspect | Dev | QA | Prod |
|--------|-----|-----|------|
| Purpose | Development & testing | Quality assurance | Production |
| Scaling | Manual | Auto-scaling | High availability |
| Observability | Basic logs (Aspire) | Full monitoring | Enterprise monitoring |
| Data retention | Ephemeral | 30 days | 90+ days |
| Cost target | <$100/mo | $200-500/mo | $500-2000+/mo |

## Infrastructure Requirements

| Component | Dev | QA/Prod |
|-----------|-----|---------|
| PostgreSQL | Docker (local) | Managed (Azure/AWS) |
| Redis | Docker (local) | Managed |
| Qdrant | Docker (local) | Qdrant Cloud |
| Temporal | Docker (local) | Temporal Cloud |
| Object Storage | MinIO (local) | Cloudflare R2 / AWS S3 |
| Observability | Aspire Dashboard | Grafana Cloud + Application Insights |

## Local Development

```bash
# Option A: Docker Compose
# Optional: copy .env.compose.example to .env.compose for local overrides.
docker compose up -d postgres minio temporal temporal-ui qdrant redis && pnpm dev

# Option B: .NET Aspire (recommended)
cd aspire/Fabric.AppHost && dotnet run
```

See `docs/ASPIRE_USAGE.md` for detailed Aspire orchestration guide.

## Azure Deployment

See `deployment/azure/README.md` for:
- Bicep infrastructure templates
- CI/CD workflow configuration
- Key Vault secret management
- Container Apps scaling
- Observability setup

## Release Strategy

Production deploys are driven by Git tags (`v*.*.*`); branch pushes to `master` continue to deploy to dev. Tags are produced automatically from [changesets](https://github.com/changesets/changesets) — developers do not tag manually. Implemented in `.github/workflows/deploy-azure-container-apps.yml` and `.github/workflows/release.yml`.

### How a release happens

1. **Per PR:** the author runs `pnpm changeset` and commits the generated `.changeset/<name>.md` describing what changed and at what semver level. CI (`changeset-check.yml`) fails the PR if no changeset is present. Opt out via the `skip-changeset` label for docs-only / CI-only PRs.
2. **On merge to `master`:** `release.yml` invokes the [changesets bot](https://github.com/changesets/action), which finds the unreleased changeset files and either:
   - opens / updates a **"chore: release"** PR that collates them into version bumps + per-package `CHANGELOG.md` updates, OR
   - if that PR was just merged, runs `pnpm release` (which builds and publishes `@fabricorg/*` packages to npm and creates `<package>@<version>` git tags).
3. **Auto-tag:** the next step in `release.yml` reads `packages/fabric-app/package.json`'s new version and pushes `v<version>` to the repo. This tag is what `deploy-azure-container-apps.yml` listens for.
4. **Prod deploy:** the tag push fires the prod workflow, which runs build-once-promote (see below) and deploys.

The `fabric-app` package in `packages/fabric-app/` is a private meta-package whose sole job is carrying the app version. See its [README](../packages/fabric-app/README.md) for the rationale.

### Required setup for the auto-tag step

The auto-tag step in `release.yml` cannot use the default `GITHUB_TOKEN` to push the `v<version>` tag — GitHub deliberately filters events from default-token pushes so they don't trigger downstream workflows (anti-recursion rule). Without an App token (or PAT), the tag would be created but the deploy would never fire.

**Recommended: GitHub App** (short-lived tokens, per-repo scope, no personal-account dependency, audit trail)

1. Create a GitHub App at `https://github.com/organizations/<org>/settings/apps/new` (or `https://github.com/settings/apps/new` for a personal account). Name it e.g. `Fabric Release Bot`. Uncheck the **Active** webhook checkbox. Under **Repository permissions** set **Contents: Read and write** and leave everything else as "No access". Scope it to "Only on this account". Click **Create GitHub App**.
2. On the app's settings page, scroll to **Private keys** → **Generate a private key**. Save the downloaded `.pem` file securely (GitHub does not let you retrieve key contents again). Note the **App ID** shown near the top.
3. In the app's left sidebar click **Install App** → choose the org/account → **Only select repositories** → pick `Fabric-Pro/fabric` → **Install**.
4. Add two repo secrets at `https://github.com/Fabric-Pro/fabric/settings/secrets/actions`:
   - `RELEASE_APP_ID` — the integer App ID from step 2.
   - `RELEASE_APP_PRIVATE_KEY` — the entire contents of the `.pem` file, including the `-----BEGIN/END RSA PRIVATE KEY-----` lines.

The workflow's "Mint GitHub App installation token" step uses `actions/create-github-app-token@v2` to exchange these for a ~1-hour token scoped to this installation. No rotation required because keys live for the App's lifetime; rotate by generating a new key in the App settings if it's ever exposed.

**Alternative: Personal access token** (simpler to set up but tied to a human account)

If a GitHub App isn't an option, replace the App-mint step in `release.yml` with a direct PAT reference:

```yaml
- name: Auto-tag fabric-app deploy tag
  env:
    RELEASE_TOKEN: ${{ secrets.RELEASE_PAT }}
  # ... rest of step unchanged
```

PAT options: **fine-grained** (preferred) scoped to this repo with `Contents: Read and write`, or **classic** with the `repo` scope. Either requires periodic rotation.

The App / PAT secrets are referenced only in the auto-tag chain; `changesets/action` and the rest of the release workflow continue to use the default `GITHUB_TOKEN`.

### Branch cutover (complete)

`master` is now the upstream canonical branch; `main` has been archived. `.changeset/config.json`'s `baseBranch`, every GitHub Actions workflow's trigger filter (`release.yml`, `changeset-check.yml`, `deploy-azure-container-apps.yml`, `unit-tests.yml`, `security.yml`, `temporal-replay-validation.yml`), and the GitLab CI job gates in `ci/gitlab/*.yml` (`$CI_COMMIT_BRANCH == "master"`) all reference `master` only.

Workflow `run:` steps resolve the base branch dynamically (`github.base_ref` exposed as `BASE_REF`) so no shell-level hard-coding was needed — `unit-tests.yml` uses `--filter="...[origin/${BASE_REF}]"` and `security.yml` uses `git rev-parse "origin/$BASE_REF"`. If you add a new workflow that diffs against a branch, follow the same pattern; never hard-code `origin/main`.

A quick way to check nothing was missed: `grep -rn "main" .github/workflows/ .changeset/ ci/gitlab/` and review each match — a hit there is either dead code, a stale comment, or a regression.

### Trigger model

| Trigger | Environment | Behavior |
|---|---|---|
| Push to `master` | dev | Selective build via `detect-changes` — only changed components rebuild and deploy. |
| Push tag `v*.*.*` | prod | Build-once-promote (see below). All components deployed at the tagged commit. |
| `workflow_dispatch` | input-selected | Full build of every component, regardless of diff. Manual fallback. |

The prod path is gated by the **GitHub Environment `Production`** — configure required reviewers and a deployment tag protection rule for `v*.*.*` in repo Settings → Environments.

### Build-once-promote model

On a tag push, the workflow does not rebuild components that were already built and validated in dev. Instead:

1. **`promote-images` job** runs first. For each component (`temporal-worker`, `mcp-stdio-wrapper`, all LangGraph agents), it attempts `az acr import` from the dev ACR (`fabric{SUFFIX}devacr`) into the prod ACR by `${{ github.sha }}`.
2. Components present in dev ACR at the tagged SHA are imported with no rebuild — same image bytes flow into prod ACR.
3. Components missing from dev ACR at that SHA (typically: unchanged since the last release, so dev ACR has them at an older SHA) fall through to the existing build jobs and are built fresh from source at the tagged commit.
4. Deploy jobs read from prod ACR by `${{ github.sha }}` and don't care whether the image got there via import or build.

This pattern works around the fundamental tension between *selective dev builds* (only changed components are built on `master` push) and *coherent prod state* (every prod deploy should reflect a single commit's source tree). Components that don't need rebuilding don't rebuild; components without a dev image at the tagged SHA are built once on the way to prod.

### RBAC required for the GitHub Actions OIDC principal

| Permission | Resource | Purpose |
|---|---|---|
| `AcrPull` | Dev ACR (`fabric{SUFFIX}devacr`) | Source pull for `az acr import` |
| `Container Registry Data Importer and Data Reader` (or Contributor) | Prod ACR (`fabric{SUFFIX}prodacr`) | Grants `Microsoft.ContainerRegistry/registries/importImage/action` plus push for fallback builds |
| `Contributor` | Dev & prod resource groups | Existing — for ACR/Container Apps management |

### Operational notes

- **Tag from a commit that's already deployed to dev.** If you tag a commit that's never been built in dev, every component falls through to build-from-source — functionally equivalent to Phase 1 (full release build), just slower than promote.
- **Idempotent re-runs.** `az acr import --force` overwrites the same tag in prod ACR if it already exists, so re-running a failed release workflow is safe.
- **The `:latest` tag in prod ACR is not updated by promotion.** Prod deploys reference images by `${{ github.sha }}`, not `:latest`, so this is cosmetic. Builds (fallback path) still tag `:latest` as a side effect.
- **Reference for the underlying primitive:** [`az acr import` documentation](https://learn.microsoft.com/azure/container-registry/container-registry-import-images).

### Reference architecture

```
Push master    ─►  detect-changes  ─►  build changed components  ─►  push to dev ACR  ─►  deploy to dev
                                                                          │
                                                                          ▼
                                                                  dev ACR holds
                                                                  fabric/<X>:<sha>
                                                                  per component

Push v1.2.3   ─►  promote-images  ─►  for each component, try `az acr import` dev→prod at <sha>
                       │
                       ├─►  promoted   ─►  build job SKIPPED   ─►  deploy from prod ACR
                       │
                       └─►  missing    ─►  build from source   ─►  push to prod ACR  ─►  deploy
```

## Required Environment Variables

See `.env.example` for the complete list. At minimum:

```bash
DATABASE_URL="postgresql://..."
DIRECT_URL="postgresql://..."
BETTER_AUTH_SECRET="..."
# At least one AI provider key
ANTHROPIC_API_KEY="sk-ant-..." # or OPENAI_API_KEY, GROQ_API_KEY, etc.
```

## Database / data tasks

- [ ] Run `pnpm exec tsx packages/database/scripts/backfill-mcp-token-hash.ts` from the repo root if the `mCPConfig.accessTokenHash` audit returned `null_hash > 0`.
