/**
 * A binding saved with "Set as default" unchecked must not be the prompt that
 * runs.
 *
 * `getBoundPromptVersion` never looked at `isDefault`: it took whatever ORG (or
 * USER) row existed for the target and returned it. So unticking the box while
 * binding still made that prompt the tier's prompt, and there was no way to
 * stand a tier down short of deleting its row — which is also why "clear the
 * override" had nothing to hang off.
 *
 * These assert on the query the database actually receives, not on a returned
 * value a fixture could fake into agreeing.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/bound-prompt-respects-is-default.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: { promptBinding: { findFirst } },
	Prisma: {},
}));

import { getBoundPromptVersion } from "../prisma/queries/prompts";

const TARGET = {
	targetType: "AGENT" as const,
	targetKey: "test_case_drafter",
	documentType: "GENERAL",
};

/** Every `where` the resolver put to the database, in order. */
const wheres = () => findFirst.mock.calls.map((c) => c[0].where);

describe("getBoundPromptVersion honours isDefault", () => {
	beforeEach(() => {
		findFirst.mockReset();
		findFirst.mockResolvedValue(null);
	});

	it("asks for a default ORG binding, not merely an ORG binding", async () => {
		await getBoundPromptVersion({ ...TARGET, organizationId: "org-1" });

		const org = wheres().find((w) => w.scope === "ORG");
		expect(org).toBeDefined();
		expect(org.isDefault).toBe(true);
	});

	it("asks for a default USER binding in personal context", async () => {
		await getBoundPromptVersion({ ...TARGET, userId: "user-1" });

		const user = wheres().find((w) => w.scope === "USER");
		expect(user).toBeDefined();
		expect(user.isDefault).toBe(true);
	});

	it("asks for a default SYSTEM binding on the fallback", async () => {
		await getBoundPromptVersion({ ...TARGET, organizationId: "org-1" });

		const system = wheres().find((w) => w.scope === "SYSTEM");
		expect(system).toBeDefined();
		expect(system.isDefault).toBe(true);
	});

	it("falls through to SYSTEM when the org has only a non-default row", async () => {
		// A faithful fake: it holds rows and applies the `where` the resolver
		// sends, exactly as the database would. A fake that ignored isDefault
		// would pass whether or not the fix is present, which is the trap this
		// test exists to avoid.
		const rows = [
			{
				scope: "ORG",
				isDefault: false,
				promptVersion: { id: "pv-org-cleared" },
			},
			{
				scope: "SYSTEM",
				isDefault: true,
				promptVersion: { id: "pv-system" },
			},
		];
		findFirst.mockImplementation(
			async ({ where }: any) =>
				rows.find(
					(r) =>
						r.scope === where.scope &&
						(where.isDefault === undefined ||
							r.isDefault === where.isDefault),
				) ?? null,
		);

		const result = await getBoundPromptVersion({
			...TARGET,
			organizationId: "org-1",
		});

		// Without the fix the cleared org row wins and this is pv-org-cleared.
		expect(result).toEqual({ id: "pv-system" });
	});

	it("still prefers the org default over the system default", async () => {
		findFirst.mockImplementation(async ({ where }: any) => {
			if (where.scope === "ORG") {
				return { promptVersion: { id: "pv-org" } };
			}
			return { promptVersion: { id: "pv-system" } };
		});

		const result = await getBoundPromptVersion({
			...TARGET,
			organizationId: "org-1",
		});

		expect(result).toEqual({ id: "pv-org" });
		// And it did not even need to ask for the system one.
		expect(wheres().some((w) => w.scope === "SYSTEM")).toBe(false);
	});

	it("consults the caller's own USER binding in organization context", async () => {
		// This assertion used to be its inverse. The rule changed deliberately
		// with FR3 of Fizzy #2068 — a personal default now overrides the
		// organization's for the person who set it — so the old expectation is
		// no longer the contract, not a regression. The isolation that remains
		// absolute is between two USERS, asserted below.
		await getBoundPromptVersion({
			...TARGET,
			userId: "user-1",
			organizationId: "org-1",
		});

		const personal = wheres().find((w) => w.scope === "USER");
		expect(personal).toBeDefined();
		// Never an unscoped USER lookup: that would resolve someone else's
		// override for this caller.
		expect(personal?.userId).toBe("user-1");
	});

	it("still honours isDefault on the personal binding", async () => {
		// The tier can be stood down at every level, including this new one.
		await getBoundPromptVersion({
			...TARGET,
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(
			wheres()
				.filter((w) => w.scope === "USER")
				.every((w) => w.isDefault === true),
		).toBe(true);
	});
});
