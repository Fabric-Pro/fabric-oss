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

const { findFirst, promptFindUnique } = vi.hoisted(() => ({
	findFirst: vi.fn(),
	promptFindUnique: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		promptBinding: { findFirst },
		prompt: { findUnique: promptFindUnique },
	},
	Prisma: {},
}));

import {
	getBoundPromptForAgent,
	getBoundPromptVersion,
} from "../prisma/queries/prompts";

const TARGET = {
	targetType: "AGENT" as const,
	targetKey: "test_case_drafter",
	documentType: "GENERAL",
};

/** Every `where` the resolver put to the database. */
const wheres = () => findFirst.mock.calls.map((c) => c[0].where);
const scopeConditions = () => wheres()[0]?.OR ?? [];
const scopeCondition = (scope: string) =>
	scopeConditions().find(
		(condition: { scope: string }) => condition.scope === scope,
	);

describe("getBoundPromptVersion honours isDefault", () => {
	beforeEach(() => {
		findFirst.mockReset();
		findFirst.mockResolvedValue(null);
		promptFindUnique.mockReset();
	});

	it("asks for a default ORG binding, not merely an ORG binding", async () => {
		await getBoundPromptVersion({ ...TARGET, organizationId: "org-1" });

		const org = scopeCondition("ORG");
		expect(org).toBeDefined();
		expect(wheres()[0].isDefault).toBe(true);
	});

	it("uses one exact lookup for the requested action and caller-visible tiers", async () => {
		await getBoundPromptVersion({
			targetType: "FEATURE",
			targetKey: "project_document_generator",
			documentType: "DRAFT",
			storyKind: "BUG",
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
		});

		expect(findFirst).toHaveBeenCalledTimes(1);
		expect(wheres()[0]).toMatchObject({
			targetType: "FEATURE",
			targetKey: "project_document_generator",
			documentType: "DRAFT",
			storyKind: "BUG",
			isDefault: true,
			OR: [
				{ scope: "SYSTEM" },
				{
					scope: "ORG",
					organizationId: "org-1",
					OR: [{ projectId: "project-1" }, { projectId: null }],
				},
				{ scope: "USER", userId: "user-1" },
			],
		});
		expect(findFirst.mock.calls[0][0].orderBy).toEqual([
			{ scope: "desc" },
			{ projectId: { sort: "desc", nulls: "last" } },
		]);
	});

	it("returns null when no exact default binding exists", async () => {
		await expect(
			getBoundPromptVersion({ ...TARGET, storyKind: "BUG" }),
		).resolves.toBeNull();

		expect(findFirst).toHaveBeenCalledTimes(1);
	});

	it("asks for a default USER binding in personal context", async () => {
		await getBoundPromptVersion({ ...TARGET, userId: "user-1" });

		const user = scopeCondition("USER");
		expect(user).toBeDefined();
		expect(wheres()[0].isDefault).toBe(true);
	});

	it("asks for a default SYSTEM binding on the fallback", async () => {
		await getBoundPromptVersion({ ...TARGET, organizationId: "org-1" });

		const system = scopeCondition("SYSTEM");
		expect(system).toBeDefined();
		expect(wheres()[0].isDefault).toBe(true);
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
				rows.find((row) =>
					where.OR.some(
						(condition: { scope: string }) =>
							row.scope === condition.scope &&
							(where.isDefault === undefined ||
								row.isDefault === where.isDefault),
					),
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
			if (
				where.OR.some(
					(condition: { scope: string }) => condition.scope === "ORG",
				)
			) {
				return { promptVersion: { id: "pv-org" } };
			}
			return { promptVersion: { id: "pv-system" } };
		});

		const result = await getBoundPromptVersion({
			...TARGET,
			organizationId: "org-1",
		});

		expect(result).toEqual({ id: "pv-org" });
		expect(findFirst).toHaveBeenCalledTimes(1);
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

		const personal = scopeCondition("USER");
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

		expect(scopeCondition("USER")).toBeDefined();
		expect(wheres()[0].isDefault).toBe(true);
	});
});

describe("getBoundPromptForAgent", () => {
	beforeEach(() => {
		findFirst.mockReset();
		promptFindUnique.mockReset();
	});

	it("returns the selected binding's version with one guarded parent lookup", async () => {
		findFirst.mockResolvedValue({
			promptVersion: {
				id: "version-1",
				promptId: "prompt-1",
				version: 2,
				content: "selected content",
				variables: { locale: "en" },
			},
		});
		promptFindUnique.mockResolvedValue({
			id: "prompt-1",
			key: "test-case",
			name: "Test case",
			description: "Selected prompt",
			scope: "SYSTEM",
			format: "TEXT",
			category: "testing",
			tags: ["test"],
		});

		await expect(
			getBoundPromptForAgent({
				agentName: "test_case_drafter",
				documentType: "GENERAL",
			}),
		).resolves.toEqual({
			id: "prompt-1",
			key: "test-case",
			name: "Test case",
			description: "Selected prompt",
			scope: "SYSTEM",
			format: "TEXT",
			category: "testing",
			tags: ["test"],
			version: {
				id: "version-1",
				version: 2,
				content: "selected content",
				variables: { locale: "en" },
			},
		});

		expect(findFirst).toHaveBeenCalledTimes(1);
		expect(findFirst.mock.calls[0][0].include).toEqual({
			promptVersion: true,
		});
		expect(promptFindUnique).toHaveBeenCalledWith({
			where: { id: "prompt-1" },
		});
	});

	it("returns null when the selected version's parent was deleted", async () => {
		findFirst.mockResolvedValue({
			promptVersion: {
				id: "version-1",
				promptId: "deleted-prompt",
				version: 2,
				content: "selected content",
				variables: null,
			},
		});
		promptFindUnique.mockResolvedValue(null);

		await expect(
			getBoundPromptForAgent({
				agentName: "test_case_drafter",
				documentType: "GENERAL",
			}),
		).resolves.toBeNull();

		expect(promptFindUnique).toHaveBeenCalledWith({
			where: { id: "deleted-prompt" },
		});
	});

	it("returns null when no exact binding exists", async () => {
		findFirst.mockResolvedValue(null);

		await expect(
			getBoundPromptForAgent({
				agentName: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: "BUG",
			}),
		).resolves.toBeNull();

		expect(findFirst).toHaveBeenCalledTimes(1);
		expect(findFirst.mock.calls[0][0].where.storyKind).toBe("BUG");
		expect(promptFindUnique).not.toHaveBeenCalled();
	});
});
