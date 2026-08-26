/**
 * Which bindings the library badge is even allowed to see.
 *
 * The runtime resolver is strict XOR: inside an organization it consults ORG
 * then SYSTEM and never the caller's personal bindings; in personal context it
 * consults USER then SYSTEM and never an org's. `listPromptsForStages` states
 * the consequence outright — surfacing a USER binding in org context advertises
 * a default that generation will not use.
 *
 * The badge query pushed both conditions unconditionally, and since USER
 * outranks ORG in the precedence rule, the library could show "Default ·
 * Personal" for a prompt the runtime would never pick there. The badge is the
 * only signal a user has about which prompt runs, so it disagreeing with the
 * runtime is the whole defect.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/binding-status-scope-isolation.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { bindingFindMany, promptFindMany, promptCount } = vi.hoisted(() => ({
	bindingFindMany: vi.fn(),
	promptFindMany: vi.fn(),
	promptCount: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		promptBinding: { findMany: bindingFindMany },
		prompt: { findMany: promptFindMany, count: promptCount },
	},
	Prisma: {},
}));

import {
	getBindingStatusForPrompts,
	listPrompts,
} from "../prisma/queries/prompts";

/** The scope filters the query asked the database for. */
const scopesAskedFor = (): string[] => {
	const where = bindingFindMany.mock.calls[0][0].where;
	return (where.OR as Array<{ scope: string }>).map((c) => c.scope).sort();
};

beforeEach(() => {
	bindingFindMany.mockReset();
	bindingFindMany.mockResolvedValue([]);
	// Reset here too: two cases below read `calls[0]`, and a carried-over call
	// from the previous test is a passing assertion about the wrong query.
	promptFindMany.mockReset();
	promptFindMany.mockResolvedValue([]);
	promptCount.mockReset();
	promptCount.mockResolvedValue(0);
});

describe("getBindingStatusForPrompts scope isolation", () => {
	it("asks for all three tiers inside an organization", async () => {
		// FR3: a personal default wins for the person who set it, even inside
		// an organization — so the badge must be able to see one, or it would
		// name a tier the runtime is not going to use.
		await getBindingStatusForPrompts({
			promptIds: ["p-1"],
			documentType: "GENERAL",
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(scopesAskedFor()).toEqual(["ORG", "SYSTEM", "USER"]);
	});

	it("scopes the personal condition to the caller", async () => {
		// The isolation that still matters absolutely: between two users.
		await getBindingStatusForPrompts({
			promptIds: ["p-1"],
			documentType: "GENERAL",
			userId: "user-1",
			organizationId: "org-1",
		});

		const where = bindingFindMany.mock.calls[0][0].where;
		expect(where.OR).toContainEqual({ scope: "USER", userId: "user-1" });
	});

	it("asks for SYSTEM and USER in personal context, never ORG", async () => {
		await getBindingStatusForPrompts({
			promptIds: ["p-1"],
			documentType: "GENERAL",
			userId: "user-1",
		});

		expect(scopesAskedFor()).toEqual(["SYSTEM", "USER"]);
	});

	it("scopes the ORG condition to the caller's own organization", async () => {
		await getBindingStatusForPrompts({
			promptIds: ["p-1"],
			documentType: "GENERAL",
			userId: "user-1",
			organizationId: "org-1",
		});

		const where = bindingFindMany.mock.calls[0][0].where;
		expect(where.OR).toContainEqual({
			scope: "ORG",
			organizationId: "org-1",
			projectId: null,
		});
	});

	it("returns nothing without asking when there are no prompts", async () => {
		const result = await getBindingStatusForPrompts({
			promptIds: [],
			documentType: "GENERAL",
			userId: "user-1",
		});

		expect(result.size).toBe(0);
		expect(bindingFindMany).not.toHaveBeenCalled();
	});

	it("badges the personal override over the organization's, inside an organization", async () => {
		// End to end through the real ranking: this is FR4's stated precedence,
		// Personal > Org > Universal, and it is now reachable because the query
		// returns all three.
		bindingFindMany.mockResolvedValue([
			{
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				scope: "ORG",
				isDefault: true,
				promptVersion: { promptId: "p-org" },
			},
			{
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				scope: "USER",
				isDefault: true,
				promptVersion: { promptId: "p-personal" },
			},
		]);

		const status = await getBindingStatusForPrompts({
			promptIds: ["p-org", "p-personal"],
			documentType: "GENERAL",
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(status.get("p-personal")?.defaultScope).toBe("USER");
		// The shadowed one must stop claiming to be the default, or the library
		// shows two prompts both badged "Default".
		expect(status.get("p-org")?.isDefault).toBe(false);
	});
});

/**
 * The same XOR rule, on the other query that filters by document type.
 *
 * `listPrompts({ boundToDocumentType })` narrows the library to prompts that
 * have a *visible* binding for that type. It pushed both the ORG and USER
 * conditions unconditionally, so inside an organization a prompt whose only
 * binding for that type was the caller's own personal one still passed —
 * advertising it as bound for a context where the runtime never consults it.
 *
 * Not a tenant leak (it is the caller's own row), which is exactly why it
 * survived: nothing about it looks dangerous, and every sibling function had
 * already been written the other way.
 */
describe("listPrompts document-type filter scope isolation", () => {
	it("considers personal bindings inside an organization", async () => {
		promptFindMany.mockResolvedValue([]);
		promptCount.mockResolvedValue(0);

		await listPrompts({
			userId: "user-1",
			organizationId: "org-1",
			boundToDocumentType: "GENERAL",
		});

		const where = promptFindMany.mock.calls[0][0].where;
		const scopes = where.versions.some.bindings.some.OR.map(
			(c: { scope: string }) => c.scope,
		).sort();
		expect(scopes).toEqual(["ORG", "SYSTEM", "USER"]);
	});

	it("uses personal bindings in personal context", async () => {
		promptFindMany.mockResolvedValue([]);
		promptCount.mockResolvedValue(0);

		await listPrompts({
			userId: "user-1",
			boundToDocumentType: "GENERAL",
		});

		const where = promptFindMany.mock.calls[0][0].where;
		const scopes = where.versions.some.bindings.some.OR.map(
			(c: { scope: string }) => c.scope,
		).sort();
		expect(scopes).toEqual(["SYSTEM", "USER"]);
	});
});
