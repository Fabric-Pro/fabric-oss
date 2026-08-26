## Summary

<!-- Brief description of changes -->

## Changeset

- [ ] Ran `pnpm changeset` and committed the generated `.changeset/*.md` file describing what changed and at what semver level
- [ ] Or: applied the `skip-changeset` label (for docs-only, CI-only, or other no-user-impact PRs)

CI will fail if neither is present on a PR that touches code. See [`packages/fabric-app/README.md`](../packages/fabric-app/README.md) for context.

## Documentation Checklist

- [ ] No temporary documentation added (`*_FIX.md`, `*_FINAL.md`, `*_PLAN.md`, etc.)
- [ ] No iteration files committed (`*_V2.md`, `*_UPDATED.md`, `*_TRY.md`, etc.)
- [ ] Existing canonical docs updated instead of creating new files
- [ ] ADR created if architecture was changed (`docs/adr/NNN-title.md`)
- [ ] All new markdown files have audience and owner metadata
- [ ] Documentation standards reviewed (`DOCUMENTATION_STANDARDS.md`)

## Testing

- [ ] Type check passes (`pnpm type-check`)
- [ ] Lint passes (`pnpm lint`)
- [ ] Relevant tests pass
- [ ] Tested in both personal and organization contexts (if applicable)

## Tenant Isolation (if applicable)

- [ ] Uses `tenantProtectedProcedure` or `resolveOrganizationId()`
- [ ] Queries use XOR pattern (never OR for tenant filtering)
- [ ] `organizationId` passed through entire call chain
