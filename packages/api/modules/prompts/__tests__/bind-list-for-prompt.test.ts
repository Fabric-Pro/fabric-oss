/**
 * Reading which actions an edit will reach.
 *
 * Editing a prompt edits shared content, so every action bound to it takes the
 * change together. The editor asks this before saving so the reach is stated
 * rather than discovered.
 *
 * The identity comes from the session, never from the input — the same rule the
 * write path follows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { listActionsForPrompt } = vi.hoisted(() => ({
	listActionsForPrompt: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listPromptDefaultAudience: vi.fn().mockResolvedValue([]),
	markOwnOverrides: vi.fn().mockResolvedValue([]),
	listActionsForPrompt,
	bindPromptVersion: vi.fn(),
	clearPromptBinding: vi.fn(),
	listPromptsForStages: vi.fn(),
	db: { promptVersion: { findUnique: vi.fn() } },
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));

// Binding announces the change to whoever is subject to it; not under test here.
vi.mock("../../../lib/notification-service", () => ({
	fanOut: { promptDefaultUpdated: vi.fn() },
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_READ: "prompt:read", PROMPT_UPDATE: "prompt:update" },
	requirePermission: () => (n: unknown) => n,
	requireInputOrgPermission: () => (n: unknown) => n,
	requireOrganizationAdmin: vi.fn(),
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

import { bindProcedures } from "../procedures/bind";

const call = (organizationId: string | null) =>
	(bindProcedures.listForPrompt as (a: unknown) => Promise<unknown>)({
		input: { promptId: "p-1", organizationId },
		context: { user: { id: "user-1", role: null }, session: {} },
	});

describe("prompts.bind.listForPrompt", () => {
	beforeEach(() => {
		listActionsForPrompt.mockReset();
		listActionsForPrompt.mockResolvedValue([]);
	});

	it("asks with the caller's own identity, not one from the input", async () => {
		await call("org-1");
		expect(listActionsForPrompt).toHaveBeenCalledWith({
			promptId: "p-1",
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("passes no organization in personal context", async () => {
		await call(null);
		expect(listActionsForPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: undefined }),
		);
	});

	it("returns the actions for the editor to name", async () => {
		listActionsForPrompt.mockResolvedValue([
			{
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				scope: "ORG",
				isDefault: true,
			},
		]);

		const result = (await call("org-1")) as { actions: unknown[] };
		expect(result.actions).toHaveLength(1);
	});

	it("returns an empty list for a prompt bound to nothing", async () => {
		const result = (await call("org-1")) as { actions: unknown[] };
		expect(result.actions).toEqual([]);
	});
});
