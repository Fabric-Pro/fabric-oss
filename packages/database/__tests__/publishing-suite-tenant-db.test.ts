/**
 * Publishing Suite — application-layer tenant registration unit tests.
 *
 * Covers Task 2 of the Publishing Suite Phase 1A plan: registering
 * `PublishingSuggestionCycle` and `PublishingTopic` in both
 * `USER_OWNED_TABLES` and `PROJECT_SCOPED_TABLES` in `tenant-db.ts` so every
 * `getTenantDb()` query filters them by tenant (XOR) and honors project
 * grants.
 *
 * Phase 1C-2b (Fizzy #1850) added a third model to the same two registries:
 * `PublishingNotificationDelivery`, the contributor-notification ledger, and
 * Phase 1C-3 a fourth: `PublishingChatDelivery`, the chat broadcast ledger. Both
 * are asserted here alongside the 1A pair, and for the same reason — a tenant
 * table that is registered in neither list is filtered by nothing, and the
 * omission looks exactly like a table that was deliberately left global.
 *
 * The registries themselves are module-private, so membership is proven
 * indirectly through `mergeWithTenantFilter`'s output — exactly as
 * `packages/api/__tests__/tenant-db-merge.test.ts` and
 * `packages/database/__tests__/url-context-source-fields.test.ts` do.
 *
 * Pure-unit; no DATABASE_URL needed.
 */

import { expect, it } from "vitest";
import {
	createOrganizationContext,
	createPersonalContext,
	grantProjectAccess,
	runWithTenantContext,
} from "../src/tenant-context";
import { mergeWithTenantFilter } from "../src/tenant-db";

// USER_OWNED registration: a bare context (no project grant) yields the pure tenant XOR filter.
it("filters PublishingSuggestionCycle / PublishingTopic by tenant XOR (user-owned)", () => {
	const personal = runWithTenantContext(createPersonalContext("u_1"), () =>
		mergeWithTenantFilter("PublishingSuggestionCycle", undefined),
	);
	expect(personal).toEqual({ userId: "u_1", organizationId: null });

	const org = runWithTenantContext(
		createOrganizationContext("org_1", "u_1"),
		() => mergeWithTenantFilter("PublishingTopic", undefined),
	);
	expect(org).toEqual({ organizationId: "org_1" }); // org context filters on organizationId only
});

// PROJECT_SCOPED registration: a project grant OR-unions the carve-out with the tenant filter.
it("adds the projectId carve-out for PublishingTopic (project-scoped)", () => {
	const merged = runWithTenantContext(createPersonalContext("u_1"), () => {
		grantProjectAccess("proj_A");
		return mergeWithTenantFilter("PublishingTopic", undefined);
	});
	expect(merged).toEqual({
		OR: [
			{ userId: "u_1", organizationId: null },
			{ projectId: { in: ["proj_A"] } },
		],
	});
});

// PROJECT_SCOPED registration: a project grant OR-unions the carve-out with the tenant filter.
it("adds the projectId carve-out for PublishingNotificationDelivery (project-scoped)", () => {
	const merged = runWithTenantContext(createPersonalContext("u_1"), () => {
		grantProjectAccess("proj_A");
		return mergeWithTenantFilter(
			"PublishingNotificationDelivery",
			undefined,
		);
	});
	expect(merged).toEqual({
		OR: [
			{ userId: "u_1", organizationId: null },
			{ projectId: { in: ["proj_A"] } },
		],
	});
});

// PROJECT_SCOPED registration: a project grant OR-unions the carve-out with the tenant filter.
it("adds the projectId carve-out for PublishingChatDelivery (project-scoped)", () => {
	// The broadcast ledger carries a projectId and the same tenant XOR as its
	// siblings, so a project guest must reach its own project's rows through the
	// same carve-out. Registering the model in USER_OWNED_TABLES alone would
	// leave the guest path filtering on a tenant they are not in.
	const merged = runWithTenantContext(createPersonalContext("u_1"), () => {
		grantProjectAccess("proj_A");
		return mergeWithTenantFilter("PublishingChatDelivery", undefined);
	});
	expect(merged).toEqual({
		OR: [
			{ userId: "u_1", organizationId: null },
			{ projectId: { in: ["proj_A"] } },
		],
	});
});
