/**
 * Contract tests for the two predicates the drop job deletes by.
 *
 * These exist because the job had no test at all, and the one predicate it
 * built by hand — the audit trail's — was wrong in the most expensive possible
 * way: on `--all` with no refusals it degenerated to a bare
 * `{ organizationId: null }`, which on that table selects an organization's own
 * trail kept after the organization was deleted, every system actor's rows, and
 * the refusal evidence this same change started collecting. The deletion runs
 * with the tamper-evidence trigger deliberately suspended, so nothing would
 * have stopped it and nothing could have undone it.
 *
 * `personalWhere` was already tested thoroughly. The bug was in the code that
 * did not use it. So these tests pin the predicates rather than the classifier,
 * and the audit one asserts the degenerate shape can no longer be produced.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	auditLogWhere,
	ORGANIZATION_REFUSAL_ACTION,
	personalWhere,
	withOwner,
} from "../../../scripts/lib/personal-context-models";

const NULLABLE_OWNER = {
	name: "Example",
	encoding: "null" as const,
	userIdNullable: true,
	hasUserId: true,
};

const REQUIRED_OWNER = { ...NULLABLE_OWNER, userIdNullable: false };

describe("withOwner", () => {
	it("keeps the ownerless-row guard when adding an inclusion", () => {
		const where = withOwner(personalWhere(NULLABLE_OWNER), { in: ["u1"] });

		// Both conditions, not one replacing the other. Global rows must be
		// excluded by the predicate, not by SQL's incidental NULL handling.
		expect(where.userId).toEqual({ not: null, in: ["u1"] });
		expect(where.organizationId).toBeNull();
	});

	it("keeps the guard when adding an exclusion", () => {
		const where = withOwner(personalWhere(NULLABLE_OWNER), {
			notIn: ["refused"],
		});

		expect(where.userId).toEqual({ not: null, notIn: ["refused"] });
	});

	it("adds the owner alone where the model has no guard to keep", () => {
		expect(
			withOwner(personalWhere(REQUIRED_OWNER), { in: ["u1"] }).userId,
		).toEqual({ in: ["u1"] });
	});
});

describe("auditLogWhere", () => {
	it("never produces a bare tenancy sweep", () => {
		// The regression: --all with zero refusals. Every argument shape must
		// still constrain the owner.
		for (const where of [
			auditLogWhere(null, []),
			auditLogWhere(null, ["refused"]),
			auditLogWhere(["u1"], []),
			auditLogWhere([], []),
		]) {
			expect(where.userId).toMatchObject({ not: null });
		}
	});

	it("excludes rows with no owner, which a system actor writes", () => {
		expect(auditLogWhere(null, []).userId).toEqual({ not: null });
	});

	it("excludes the refusal evidence", () => {
		expect(auditLogWhere(["u1"], []).NOT).toEqual({
			action: ORGANIZATION_REFUSAL_ACTION,
		});
	});

	it("scopes to the cleared users when it has them", () => {
		expect(auditLogWhere(["u1", "u2"], ["refused"]).userId).toEqual({
			not: null,
			in: ["u1", "u2"],
		});
	});

	it("falls back to excluding the refused when it has no cleared list", () => {
		expect(auditLogWhere(null, ["refused"]).userId).toEqual({
			not: null,
			notIn: ["refused"],
		});
	});
});

describe("the refusal action name", () => {
	it("matches the one the web app actually writes", () => {
		// The script cannot import that module — it pulls the whole audit
		// dispatch stack — so the two literals are kept in step by reading it.
		// A rename that touched only one side would otherwise leave the drop
		// job deleting the evidence again, silently.
		const source = readFileSync(
			join(
				__dirname,
				"../../../apps/web/modules/saas/mcp/lib/record-organization-refusal.ts",
			),
			"utf8",
		);

		expect(source).toContain(`action: "${ORGANIZATION_REFUSAL_ACTION}"`);
	});
});
