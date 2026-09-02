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
 * Mocked at the database and fan-out boundary rather than at
 * `announce-default-change`, so the action filter, the per-action recipient
 * lookup and the link the reader receives are all exercised for real. Mocking
 * the announcer would leave every one of those free to be wrong.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/version-announces-edit.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getPromptById,
	createPromptVersion,
	listActionsForPrompt,
	listPromptDefaultRecipients,
	findUnique,
	promptDefaultUpdated,
	resolveOrgBasePath,
} = vi.hoisted(() => ({
	getPromptById: vi.fn(),
	createPromptVersion: vi.fn(),
	listActionsForPrompt: vi.fn(),
	listPromptDefaultRecipients: vi.fn(),
	findUnique: vi.fn(),
	promptDefaultUpdated: vi.fn(),
	resolveOrgBasePath: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getPromptById,
	createPromptVersion,
	listActionsForPrompt,
	listPromptDefaultRecipients,
	db: { promptVersion: { findUnique } },
}));

vi.mock("../../../lib/notification-service", () => ({
	fanOut: { promptDefaultUpdated },
}));

vi.mock("../lib/org-base-path", () => ({ resolveOrgBasePath }));

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

const SYSTEM_PROMPT = {
	id: "p-sys",
	scope: "SYSTEM",
	organizationId: null,
	userId: null,
	format: "PLAIN_TEXT",
};

const action = (targetKey: string, over: Record<string, unknown> = {}) => ({
	targetKey,
	documentType: "GENERAL",
	storyKind: null,
	scope: "ORG",
	isDefault: true,
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	createPromptVersion.mockResolvedValue({ id: "pv-2" });
	listActionsForPrompt.mockResolvedValue([]);
	listPromptDefaultRecipients.mockResolvedValue([
		{ userId: "member-1", organizationId: "org-a", hasOwnOverride: false },
	]);
	findUnique.mockResolvedValue({
		changeNote: "tightened the wording",
		prompt: { id: "p-1", name: "QA Strategy" },
	});
	resolveOrgBasePath.mockResolvedValue("/app/acme");
	promptDefaultUpdated.mockResolvedValue(undefined);
});

describe("editing a bound default announces the change (FR6)", () => {
	it("tells the people subject to it, once per action it wins", async () => {
		getPromptById.mockResolvedValue(ORG_PROMPT);
		listActionsForPrompt.mockResolvedValue([
			action("test_case_drafter"),
			action("pr_review_qa"),
		]);

		await createVersion(ORG_PROMPT);

		expect(promptDefaultUpdated).toHaveBeenCalledTimes(2);
		expect(promptDefaultUpdated).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "ORG",
				promptId: "p-1",
				promptName: "QA Strategy",
				targetKey: "test_case_drafter",
				changeNote: "tightened the wording",
				actorUserId: "admin-1",
			}),
		);
	});

	it("resolves the version and the link base once, not once per action", async () => {
		// The prompt's name, its change note and the catalog base path are the
		// same for every action, so refetching them per action is pure cost on
		// the author's save.
		getPromptById.mockResolvedValue(ORG_PROMPT);
		listActionsForPrompt.mockResolvedValue([
			action("test_case_drafter"),
			action("pr_review_qa"),
			action("spec_writer"),
		]);

		await createVersion(ORG_PROMPT);

		expect(promptDefaultUpdated).toHaveBeenCalledTimes(3);
		expect(findUnique).toHaveBeenCalledTimes(1);
		expect(resolveOrgBasePath).toHaveBeenCalledTimes(1);
	});

	it("links an org change into that organization's own catalog (FR8)", async () => {
		getPromptById.mockResolvedValue(ORG_PROMPT);
		listActionsForPrompt.mockResolvedValue([action("test_case_drafter")]);

		await createVersion(ORG_PROMPT);

		expect(promptDefaultUpdated).toHaveBeenCalledWith(
			expect.objectContaining({
				link: expect.stringContaining(
					"/app/acme/prompts/catalog?action=",
				),
			}),
		);
	});

	it("announces a system-tier edit, and keeps it off any org's path", async () => {
		// The tier whose failure motivated the fix, and the one the first
		// revision of this file never exercised: a narrowing of the scope check
		// to ORG would have stayed green.
		getPromptById.mockResolvedValue(SYSTEM_PROMPT);
		listActionsForPrompt.mockResolvedValue([
			action("test_case_drafter", { scope: "SYSTEM" }),
		]);

		await createVersion(SYSTEM_PROMPT);

		expect(promptDefaultUpdated).toHaveBeenCalledTimes(1);
		expect(promptDefaultUpdated).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "SYSTEM",
				link: expect.stringContaining("/app/prompts/catalog?action="),
			}),
		);
		// A system change spans every organization, so it must not resolve one.
		expect(resolveOrgBasePath).not.toHaveBeenCalled();
	});

	it("ignores a binding at a tier this edit did not repoint", async () => {
		// `createPromptVersion` repoints same-scope bindings only. An ORG-tier
		// binding on a SYSTEM prompt still points at the old version, so its
		// readers are running unchanged text and must not be told otherwise.
		getPromptById.mockResolvedValue(SYSTEM_PROMPT);
		listActionsForPrompt.mockResolvedValue([
			action("test_case_drafter", { scope: "ORG" }),
		]);

		await createVersion(SYSTEM_PROMPT);

		expect(promptDefaultUpdated).not.toHaveBeenCalled();
	});

	it("stays silent for an action where this prompt is merely available", async () => {
		// Bound but not the winner: editing it changes nobody's runtime, so a
		// notification would be noise about a prompt they do not use.
		getPromptById.mockResolvedValue(ORG_PROMPT);
		listActionsForPrompt.mockResolvedValue([
			action("test_case_drafter", { isDefault: false }),
		]);

		await createVersion(ORG_PROMPT);

		expect(promptDefaultUpdated).not.toHaveBeenCalled();
	});

	it("stays silent for a personal prompt", async () => {
		// A personal default affects exactly the person who set it, and telling
		// them what they just typed is noise.
		getPromptById.mockResolvedValue({
			id: "p-2",
			scope: "USER",
			organizationId: null,
			userId: "admin-1",
			format: "PLAIN_TEXT",
		});

		await createVersion({ id: "p-2" });

		expect(promptDefaultUpdated).not.toHaveBeenCalled();
		expect(listActionsForPrompt).not.toHaveBeenCalled();
	});

	it("says nothing when the action has no one left to tell", async () => {
		getPromptById.mockResolvedValue(ORG_PROMPT);
		listActionsForPrompt.mockResolvedValue([action("test_case_drafter")]);
		listPromptDefaultRecipients.mockResolvedValue([]);

		await createVersion(ORG_PROMPT);

		expect(promptDefaultUpdated).not.toHaveBeenCalled();
	});

	it("still returns the new version when the announcement throws", async () => {
		// Best effort: the author's save must not fail because a notification
		// could not be written.
		getPromptById.mockResolvedValue(ORG_PROMPT);
		listActionsForPrompt.mockResolvedValue([action("test_case_drafter")]);
		promptDefaultUpdated.mockRejectedValue(new Error("bell is down"));

		await expect(createVersion(ORG_PROMPT)).resolves.toMatchObject({
			id: "pv-2",
		});
	});

	it("still announces later actions when one announcement fails", async () => {
		getPromptById.mockResolvedValue(ORG_PROMPT);
		listActionsForPrompt.mockResolvedValue([
			action("test_case_drafter"),
			action("pr_review_qa"),
		]);
		promptDefaultUpdated
			.mockRejectedValueOnce(new Error("bell is down"))
			.mockResolvedValueOnce(undefined);

		await expect(createVersion(ORG_PROMPT)).resolves.toMatchObject({
			id: "pv-2",
		});
		expect(promptDefaultUpdated).toHaveBeenCalledTimes(2);
	});

	it("still returns the new version when the action lookup throws", async () => {
		getPromptById.mockResolvedValue(ORG_PROMPT);
		listActionsForPrompt.mockRejectedValue(new Error("db down"));

		await expect(createVersion(ORG_PROMPT)).resolves.toMatchObject({
			id: "pv-2",
		});
	});
});
