/**
 * FR6, the half a binding-time announcement does not cover.
 *
 * `createPromptVersion` repoints a prompt's same-scope bindings at the new
 * version, so editing the body of a prompt that is already the default changes
 * what everyone subject to it runs — with no one having asked for it. From the
 * reader's side that is the same event as a new default being published, and
 * the card requires telling them either way. Nothing tested this: the notice
 * fired when a default was BOUND and was silent when one was EDITED.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/version-announces-edit.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getPromptById,
	createPromptVersion,
	listActionsForPrompt,
	announceDefaultChange,
} = vi.hoisted(() => ({
	getPromptById: vi.fn(),
	createPromptVersion: vi.fn(),
	listActionsForPrompt: vi.fn(),
	announceDefaultChange: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getPromptById,
	createPromptVersion,
	listActionsForPrompt,
}));

vi.mock("../lib/announce-default-change", () => ({ announceDefaultChange }));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue({ role: "admin" }),
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_CREATE: "prompt:create" },
	requirePermission: () => (next: unknown) => next,
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

import { versionProcedures } from "../procedures/version";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string; role?: string | null } };
}) => Promise<unknown>;

const createVersion = (
	prompt: Record<string, unknown>,
	user: { id?: string; role?: string | null } = {},
) =>
	(versionProcedures.create as unknown as Handler)({
		input: { id: prompt.id as string, content: "revised body" },
		context: {
			user: { id: user.id ?? "admin-1", role: user.role ?? "admin" },
		},
	});

const ORG_PROMPT = {
	id: "p-1",
	scope: "ORG",
	organizationId: "org-a",
	userId: null,
	format: "PLAIN_TEXT",
};

beforeEach(() => {
	getPromptById.mockReset();
	createPromptVersion.mockReset();
	listActionsForPrompt.mockReset();
	announceDefaultChange.mockReset();
	createPromptVersion.mockResolvedValue({ id: "pv-2" });
	listActionsForPrompt.mockResolvedValue([]);
});

describe("editing a bound default announces the change (FR6)", () => {
	it("tells the people subject to it, once per action it wins", async () => {
		getPromptById.mockResolvedValue(ORG_PROMPT);
		listActionsForPrompt.mockResolvedValue([
			{
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				scope: "ORG",
				isDefault: true,
			},
			{
				targetKey: "pr_review_qa",
				documentType: "GENERAL",
				storyKind: null,
				scope: "ORG",
				isDefault: true,
			},
		]);

		await createVersion(ORG_PROMPT);

		expect(announceDefaultChange).toHaveBeenCalledTimes(2);
		expect(announceDefaultChange).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "ORG",
				organizationId: "org-a",
				targetKey: "test_case_drafter",
				// The NEW version, not the one it replaced — the notice has to
				// describe what people are running now.
				promptVersionId: "pv-2",
				actorUserId: "admin-1",
			}),
		);
	});

	it("stays silent for an action where this prompt is merely available", async () => {
		// Bound but not the winner: editing it changes nobody's runtime, so a
		// notification would be noise about a prompt they do not use.
		getPromptById.mockResolvedValue(ORG_PROMPT);
		listActionsForPrompt.mockResolvedValue([
			{
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				scope: "ORG",
				isDefault: false,
			},
		]);

		await createVersion(ORG_PROMPT);

		expect(announceDefaultChange).not.toHaveBeenCalled();
	});

	it("stays silent for a personal prompt", async () => {
		// A personal default affects exactly the person who set it, and telling
		// them what they just typed is noise — the same rule announceDefaultChange
		// applies to USER scope.
		getPromptById.mockResolvedValue({
			id: "p-2",
			scope: "USER",
			organizationId: null,
			userId: "admin-1",
			format: "PLAIN_TEXT",
		});

		await createVersion({ id: "p-2" });

		expect(announceDefaultChange).not.toHaveBeenCalled();
		expect(listActionsForPrompt).not.toHaveBeenCalled();
	});

	it("still returns the new version when the announcement throws", async () => {
		// Best effort: the author's save must not fail because a notification
		// could not be written.
		getPromptById.mockResolvedValue(ORG_PROMPT);
		listActionsForPrompt.mockResolvedValue([
			{
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				scope: "ORG",
				isDefault: true,
			},
		]);
		announceDefaultChange.mockRejectedValue(new Error("bell is down"));

		await expect(createVersion(ORG_PROMPT)).resolves.toMatchObject({
			id: "pv-2",
		});
	});

	it("still announces later actions when one announcement fails", async () => {
		getPromptById.mockResolvedValue(ORG_PROMPT);
		listActionsForPrompt.mockResolvedValue([
			{
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				scope: "ORG",
				isDefault: true,
			},
			{
				targetKey: "pr_review_qa",
				documentType: "GENERAL",
				storyKind: null,
				scope: "ORG",
				isDefault: true,
			},
		]);
		announceDefaultChange
			.mockRejectedValueOnce(new Error("bell is down"))
			.mockResolvedValueOnce(undefined);

		await expect(createVersion(ORG_PROMPT)).resolves.toMatchObject({
			id: "pv-2",
		});
		expect(announceDefaultChange).toHaveBeenCalledTimes(2);
	});
});
