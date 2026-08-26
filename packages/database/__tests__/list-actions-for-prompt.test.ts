/**
 * Which actions an edit to this prompt will reach.
 *
 * Editing a prompt edits shared content, so every action bound to it takes the
 * change at once. The two things worth pinning are that the question is asked
 * of the PROMPT rather than of one version — bindings advance to the newest
 * version, so asking per-version would silently narrow the answer — and that
 * tenant isolation matches every other read here.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/list-actions-for-prompt.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: { promptBinding: { findMany } },
	Prisma: {},
}));

import { listActionsForPrompt } from "../prisma/queries/prompts";

const whereOf = () => findMany.mock.calls[0][0].where;

describe("listActionsForPrompt", () => {
	beforeEach(() => {
		findMany.mockReset();
		findMany.mockResolvedValue([]);
	});

	it("asks by prompt, not by a single version", () => {
		listActionsForPrompt({ promptId: "p-1", userId: "u-1" });
		expect(whereOf().promptVersion).toEqual({ promptId: "p-1" });
	});

	it("sees SYSTEM and the org tier in organization context", () => {
		listActionsForPrompt({
			promptId: "p-1",
			userId: "u-1",
			organizationId: "org-1",
		});

		const scopes = whereOf().OR.map((c: any) => c.scope);
		expect(scopes).toContain("SYSTEM");
		expect(scopes).toContain("ORG");
		// A personal binding belongs to personal context and must not leak here.
		expect(scopes).not.toContain("USER");
	});

	it("sees SYSTEM and the personal tier in personal context", () => {
		listActionsForPrompt({ promptId: "p-1", userId: "u-1" });

		const scopes = whereOf().OR.map((c: any) => c.scope);
		expect(scopes).toContain("SYSTEM");
		expect(scopes).toContain("USER");
		expect(scopes).not.toContain("ORG");
	});

	it("returns the action identity and tier of each binding", async () => {
		findMany.mockResolvedValue([
			{
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				scope: "ORG",
				isDefault: true,
			},
		]);

		const actions = await listActionsForPrompt({
			promptId: "p-1",
			organizationId: "org-1",
		});

		expect(actions).toEqual([
			{
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				scope: "ORG",
				isDefault: true,
			},
		]);
	});

	it("returns nothing for a prompt bound to nothing", async () => {
		expect(
			await listActionsForPrompt({
				promptId: "p-unbound",
				userId: "u-1",
			}),
		).toEqual([]);
	});
});
