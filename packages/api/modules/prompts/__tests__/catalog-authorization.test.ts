/**
 * Who may read an organization's prompt catalog.
 *
 * `catalog.list` takes an `organizationId` from the caller and returns which
 * prompt runs each action for that tenant — including the prompt NAMES bound at
 * every tier. It is gated at PROMPT_READ, which says nothing about membership,
 * so the handler checks it itself.
 *
 * That check had no test at all. Both consumers mock `orpcClient.prompts
 * .catalog.list` wholesale, so the handler — and the gate inside it — never ran
 * anywhere in the suite. Deleting or inverting the `if (!membership)` block
 * would have kept every one of the ~40 prompt test files green.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/catalog-authorization.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { listPromptCatalog, verifyOrganizationMembership } = vi.hoisted(() => ({
	listPromptCatalog: vi.fn(),
	verifyOrganizationMembership: vi.fn(),
}));

vi.mock("@repo/database", () => ({ listPromptCatalog }));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership,
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_READ: "prompt:read", PROMPT_UPDATE: "prompt:update" },
	requirePermission: () => (next: unknown) => next,
	requireInputOrgPermission: () => (next: unknown) => next,
	resolveOrganizationId: (i: string | null | undefined) => i ?? null,
	tenantProtectedProcedure: {
		use: () => ({
			route: () => ({
				input: () => ({
					output: () => ({ handler: (fn: unknown) => fn }),
				}),
			}),
		}),
	},
}));

import { catalogProcedures } from "../procedures/catalog";

type Handler = (a: unknown) => Promise<unknown>;

const list = (organizationId: string | null, userId = "user-1") =>
	(catalogProcedures.list as unknown as Handler)({
		input: { organizationId },
		context: { user: { id: userId, role: null }, session: {} },
	});

beforeEach(() => {
	listPromptCatalog.mockReset();
	listPromptCatalog.mockResolvedValue([]);
	verifyOrganizationMembership.mockReset();
	verifyOrganizationMembership.mockResolvedValue({ role: "member" });
});

describe("prompts.catalog.list membership gate", () => {
	it("refuses an organization the caller does not belong to", async () => {
		// The payload names the prompts bound at every tier for that tenant, so
		// this is a read of another organization's configuration.
		verifyOrganizationMembership.mockResolvedValue(null);

		await expect(list("org-b")).rejects.toThrow(/not a member/i);
		expect(listPromptCatalog).not.toHaveBeenCalled();
	});

	it("checks membership against the organization that was asked for", async () => {
		await list("org-a", "user-9");

		expect(verifyOrganizationMembership).toHaveBeenCalledWith(
			"org-a",
			"user-9",
		);
	});

	it("returns the catalog to a member", async () => {
		listPromptCatalog.mockResolvedValue([
			{ targetKey: "test_case_drafter", prompts: [] },
		]);

		const result = (await list("org-a")) as { entries: unknown[] };

		expect(result.entries).toHaveLength(1);
	});

	it("needs no membership check in personal context", async () => {
		// There is no organization to be a member of; the query scopes to the
		// caller's own USER bindings.
		await list(null);

		expect(verifyOrganizationMembership).not.toHaveBeenCalled();
		expect(listPromptCatalog).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: undefined,
			}),
		);
	});

	it("scopes the query to the caller, not just the organization", async () => {
		// Personal bindings are per user; passing the org alone would let one
		// member's catalog show another's overrides.
		await list("org-a", "user-9");

		expect(listPromptCatalog).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-9",
				organizationId: "org-a",
			}),
		);
	});
});
