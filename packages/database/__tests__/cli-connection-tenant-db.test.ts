/**
 * CLI connection nudge — application-layer tenant registration (Fizzy #2457).
 *
 * The three tables added by U2 are registered for RLS in
 * `scripts/apply-rls-direct.ts` AND in the `tenant-db.ts` table sets, and only
 * the second of those is what scopes a read on the tenant path.
 * `getTenantFilter` returns `null` for a model it does not recognise and
 * `mergeWithTenantFilter` then passes the WHERE through UNFILTERED — it fails
 * OPEN, not closed. A table registered for RLS but missing here therefore looks
 * protected in review while every `getTenantDb()` query against it reads every
 * tenant's rows.
 *
 * `rls-coverage.test.ts` asserts the registration is written down; this asserts
 * what it produces, which is the thing that actually isolates. The registries
 * are module-private, so membership is proven through `mergeWithTenantFilter`'s
 * output — the same indirection `publishing-suite-tenant-db.test.ts` uses.
 *
 * Pure-unit; no DATABASE_URL needed.
 */

import { describe, expect, it } from "vitest";
import {
	createOrganizationContext,
	createPersonalContext,
	runWithTenantContext,
} from "../src/tenant-context";
import { mergeWithTenantFilter } from "../src/tenant-db";

describe("reach tables are scoped to the organization alone", () => {
	it.each(["OrganizationCliReach", "OrganizationCliFirstReach"])(
		"%s filters on organizationId in an organization context",
		(model) => {
			const filter = runWithTenantContext(
				createOrganizationContext("org_1", "u_1"),
				() => mergeWithTenantFilter(model, undefined),
			);
			// No userId: the fact is about the organization, not about the
			// member whose credential happened to reach it. Adding one here
			// would hide the answer from everyone but that person.
			expect(filter).toEqual({ organizationId: "org_1" });
		},
	);

	// ADR 018: there is no personal arm to route into, and org_only has no
	// personal branch. The blocked sentinel is the fail-CLOSED default — the
	// value that matters is that it is not `undefined`, which would read every
	// row in the table.
	it.each(["OrganizationCliReach", "OrganizationCliFirstReach"])(
		"%s reads nothing in a personal context",
		(model) => {
			const filter = runWithTenantContext(
				createPersonalContext("u_1"),
				() => mergeWithTenantFilter(model, undefined),
			);
			expect(filter).toEqual({ organizationId: "___BLOCKED___" });
		},
	);

	it("preserves an existing WHERE alongside the tenant filter", () => {
		const filter = runWithTenantContext(
			createOrganizationContext("org_1", "u_1"),
			() =>
				mergeWithTenantFilter("OrganizationCliReach", {
					credentialKind: "ORGANIZATION_API_KEY",
				}),
		);
		// AND-wrapped rather than spread, so a caller's WHERE can never
		// overwrite the tenant predicate by naming the same key.
		expect(filter).toEqual({
			AND: [
				{ credentialKind: "ORGANIZATION_API_KEY" },
				{ organizationId: "org_1" },
			],
		});
	});
});

describe("the dismissal is scoped to its own user within the organization", () => {
	it("filters on BOTH userId and organizationId in an organization context", () => {
		const filter = runWithTenantContext(
			createOrganizationContext("org_1", "u_1"),
			() =>
				mergeWithTenantFilter(
					"CliConnectionPromptDismissal",
					undefined,
				),
		);
		// The difference from the reach tables above, and the reason the two
		// registrations are not interchangeable: whether a colleague dismissed
		// the prompt is not this member's business.
		expect(filter).toEqual({ userId: "u_1", organizationId: "org_1" });
	});

	it("never returns an unfiltered WHERE, in either context", () => {
		const personal = runWithTenantContext(
			createPersonalContext("u_1"),
			() =>
				mergeWithTenantFilter(
					"CliConnectionPromptDismissal",
					undefined,
				),
		);
		// organizationId is NOT NULL on this table, so the personal branch
		// matches nothing — which is the correct fail-closed answer, not a
		// pass-through.
		expect(personal).toEqual({ userId: "u_1", organizationId: null });
		expect(personal).not.toBeUndefined();
	});
});
