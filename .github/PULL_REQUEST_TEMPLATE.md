## Summary

<!-- Brief description of changes -->

## Changeset

- [ ] Ran `pnpm changeset` and committed the generated `.changeset/*.md` file describing what changed and at what semver level
- [ ] Or: applied the `skip-changeset` label (for docs-only, CI-only, or other no-user-impact PRs)

CI will fail if neither is present, including for docs- and CI-only PRs. See
[`packages/fabric-app/README.md`](../packages/fabric-app/README.md) for context.

## Documentation Checklist

- [ ] No temporary documentation added (`*_FIX.md`, `*_FINAL.md`, `*_PLAN.md`, etc.)
- [ ] No iteration files committed (`*_V2.md`, `*_UPDATED.md`, `*_TRY.md`, etc.)
- [ ] Existing canonical docs updated instead of creating new files
- [ ] ADR created if architecture was changed (`docs/adr/NNN-title.md`)
- [ ] New documentation has required audience/owner metadata; tool instruction entry points use the documented exception
- [ ] Documentation standards reviewed (`DOCUMENTATION_STANDARDS.md`)

## Testing

- [ ] If a literal validation failed and an environment- or resource-adjusted retry succeeded, recorded both outcomes; the retry does not make the original validation pass
- [ ] Type check passes (`pnpm type-check`)
- [ ] Lint passes (`pnpm lint`)
- [ ] Relevant tests pass
- [ ] Cross-organization and unauthorized-user boundaries tested (if applicable)

## Local smoke test

<!--
Complete this only when automated tests genuinely cannot cover the behavior,
such as real credentials, external APIs, live model loops, or wiring through a
mocked boundary where failure would otherwise be silent. Name the concrete
trigger and exact expected observable result; do not add routine manual-test
padding. Otherwise write "Not applicable — covered by automated tests."
-->

- Environment:
- Scenario(s):
- Result:

## Tenant Isolation (if applicable)

- [ ] Uses `tenantProtectedProcedure` or `resolveOrganizationId()`
- [ ] Queries use XOR pattern (never OR for tenant filtering)
- [ ] `organizationId` passed through entire call chain
