# RBAC Deployment Strategy

## Context

The `features/rbac-and-guests` branch adds lean RBAC to ~624 API procedures via three middleware decorators (`requirePermission`, `requireProjectPermission`, `requirePermissionAllowGuest`). This document covers how to deploy safely without affecting existing users.

## Risk Assessment

### 1. Org-scoped procedures: SAFE

The middleware reads `activeOrganizationRole` from Better Auth's existing `member.role` column. The role matrix maps the same lowercase strings Better Auth already stores:

| `member.role` | `OrgRole` | Permission Level |
|---------------|-----------|-----------------|
| `"owner"` | `owner` | Full (including `ORG_DELETE`) |
| `"admin"` | `admin` | Everything except `ORG_DELETE` |
| `"member"` | `member` | Read + create + edit |

No data migration needed. Existing users keep their current access level.

### 2. Personal-context procedures: FIXED

`requirePermission` and `requirePermissionAllowGuest` now check `context.tenantContext.type === "personal"` and skip the org-role check. Personal data is already isolated by `userId` in `tenant-db.ts`, so the org-level permission check is redundant there.

Org procedures are still safe because:
- When a user passes an explicit `organizationId`, the tenant context type is `"organization"`, not `"personal"` -- the permission check runs normally.
- Org procedures have defense-in-depth: handlers call `requireOrgMembership()` or `resolveOrganizationId()` which verify actual membership independently of the middleware.

### 3. Project-scoped procedures: SAFE

`requireProjectPermission` has three resolution paths:
- **Path A:** Personal-project owner (userId match, no org) -- passes through
- **Path B:** Org member of project's host org -- checks `member.role` via direct DB query
- **Path C:** Guest with accepted `ProjectMember` row -- checks project role

All three paths use ground-truth DB lookups, not session state.

### 4. Unknown role values: VERIFY PRE-DEPLOY

If any `member.role` value is not in `{owner, admin, member, viewer}`, `resolveOrgPermissions` returns an empty set and the user gets FORBIDDEN on everything.

### 5. Dry-run mode: AVAILABLE BUT USE WITH CAUTION

`RBAC_DRY_RUN=true` logs permission denials as warnings instead of throwing FORBIDDEN. This allows requests through without enforcement. Use only in staging or during a very short observation window -- it weakens security by allowing unauthorized operations to execute.

**Recommendation:** Prefer full enforcement with monitoring over dry-run in production. The role mapping is deterministic and verifiable via DB query.

## Pre-Deploy Checklist

### 1. Audit existing role values

```sql
SELECT DISTINCT role, COUNT(*) FROM "member" GROUP BY role;
```

All values must be in `{owner, admin, member}`. Fix any anomalies before deploy.

### 2. Check for viewer role assignments (if unintended)

```sql
SELECT COUNT(*) FROM "member" WHERE role = 'viewer';
```

### 3. Verify migrations are additive

Two migrations on this branch:
- `20260302100000_add_role_permission_system` -- creates `permission`, `role`, `role_permission`, `principal_role` tables (additive)
- `20260414185958_project_member_roles` -- adds `PROJECT_ADMIN`, `COMMENTER` to `ProjectMemberRole` enum (additive)

No destructive changes. Old code runs fine against the new schema.

### 4. Run test suite

```bash
# Permission coverage regression guard (3 tests)
cd packages/api && npx vitest run __tests__/permission-coverage.test.ts

# Permissions package (46 tests)
cd packages/permissions && npx vitest run

# Type check
pnpm type-check
```

## Deploy Steps

### Option A: Full enforcement (recommended)

1. Run pre-deploy checklist on production DB
2. Deploy with `RBAC_DRY_RUN` unset (default: enforcement ON)
3. Monitor for FORBIDDEN error rate spike in first 24h
4. Alert on log pattern: `Missing required permission:`

### Option B: Staged rollout with dry-run

1. Deploy with `RBAC_DRY_RUN=true`
2. Monitor logs for `[RBAC dry-run]` entries for 24h
3. Review flagged denials -- each is a case where the new system would block a user
4. If no false positives, remove `RBAC_DRY_RUN` env var to enforce
5. Keep observation window short -- dry-run allows unauthorized operations

## Rollback Plan

Revert the deploy. The middleware is the only enforcement point. Removing it restores pre-RBAC behavior (no permission checks). Migrations are additive, so no schema rollback needed -- old code ignores the new tables.

## Key Files

| File | Purpose |
|------|---------|
| `packages/permissions/lib/roles.ts` | Role-to-permission matrices |
| `packages/permissions/lib/resolve.ts` | `resolveOrgPermissions` / `resolveProjectPermissions` |
| `packages/api/orpc/middleware/require-permission.ts` | Three enforcement decorators + dry-run mode |
| `packages/api/orpc/middleware/tenant-context-middleware.ts` | Sets `activeOrganizationRole` from `member.role` |
| `packages/api/__tests__/permission-coverage.test.ts` | Regression guard for decorator coverage |

## Architecture Decisions

1. **Roles are fixed in code** (not DB tables). The `packages/permissions` package defines role matrices as TypeScript constants. Graduation to DB-backed roles is a future phase.
2. **Auth middleware queries ground-truth tables** (`member`, `projectMember`), never `session.activeOrganizationId`. Session state is a UX convenience, not an authz signal.
3. **Personal-context bypass is intentional**. Personal data isolation is handled by `tenant-db.ts` userId filtering. The RBAC layer only governs org and project access.
4. **Permission backfill was scoped into the MVP**. Every undecorated procedure is a privilege escalation path for lower-privilege actors. The coverage test prevents regressions.
