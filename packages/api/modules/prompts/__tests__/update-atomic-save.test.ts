/**
 * Fizzy #2250: a rename and a body edit submitted together must either both
 * land or both fail. Before this, `PromptDetails.updateMutation` called
 * `prompts.update` (metadata) and `prompts.version.create` (content) as two
 * separate requests — a rename could succeed while the body it was submitted
 * with was rejected, and the toast ("Failed to update prompt") gave no hint
 * that half the save had already persisted.
 *
 * `assertSavablePromptContent` and `assertValidTemplate` run for real here —
 * only the database write and the announcement are mocked — so the length
 * and blank-body guards are exercised as the procedure actually calls them,
 * not as a mock stands in for them.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/update-atomic-save.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	getPromptById,
	updatePromptWithVersion,
	announceDefaultChangeForWinningActions,
} = vi.hoisted(() => ({
	getPromptById: vi.fn(),
	updatePromptWithVersion: vi.fn(),
	announceDefaultChangeForWinningActions: vi.fn(),
}));

vi.mock("@repo/database", () => ({ getPromptById, updatePromptWithVersion }));

vi.mock("../lib/announce-default-change", () => ({
	announceDefaultChangeForWinningActions,
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue({ role: "admin" }),
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_UPDATE: "prompt:update" },
	requirePermission: () => (next: unknown) => next,
	// Permissive builder: each link returns itself, so the chain works
	// whatever combination of route/input/output the procedure uses.
	tenantProtectedProcedure: (() => {
		const link: Record<string, unknown> = {};
		for (const key of ["use", "route", "input", "output"]) {
			link[key] = () => link;
		}
		link.handler = (fn: unknown) => fn;
		return link;
	})(),
}));

import { updateProcedure } from "../procedures/update";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string; role?: string | null } };
}) => Promise<{ prompt: unknown; version: { id: string } | null }>;

const callUpdate = (input: Record<string, unknown>) =>
	(updateProcedure as unknown as Handler)({
		input: { id: "p-1", ...input },
		context: { user: { id: "admin-1", role: "admin" } },
	});

const ORG_PROMPT_HANDLEBARS = {
	id: "p-1",
	scope: "ORG",
	organizationId: "org-a",
	userId: null,
	format: "HANDLEBARS",
	versions: [{ id: "v-1", version: 1, content: "Hi {{{name}}}" }],
};

beforeEach(() => {
	vi.clearAllMocks();
	updatePromptWithVersion.mockResolvedValue({
		prompt: { id: "p-1", name: "Renamed" },
		version: null,
	});
	announceDefaultChangeForWinningActions.mockResolvedValue(undefined);
});

describe("update: a blank body refuses the whole save", () => {
	it("rejects with BAD_REQUEST and never reaches the database write", async () => {
		getPromptById.mockResolvedValue(ORG_PROMPT_HANDLEBARS);

		await expect(
			callUpdate({ name: "Renamed", content: "   " }),
		).rejects.toThrow(/Prompt content cannot be empty/);

		expect(updatePromptWithVersion).not.toHaveBeenCalled();
	});
});

describe("update: a body over the length limit refuses the whole save", () => {
	it("rejects with the too-long message and never reaches the database write", async () => {
		getPromptById.mockResolvedValue(ORG_PROMPT_HANDLEBARS);
		const tooLong = "x".repeat(50_001);

		await expect(
			callUpdate({ name: "Renamed", content: tooLong }),
		).rejects.toThrow(
			/Prompt content is 50,001 characters; the maximum is 50,000\./,
		);

		expect(updatePromptWithVersion).not.toHaveBeenCalled();
	});
});

describe("update: a rename with a valid body saves atomically", () => {
	it("writes metadata and content in one call and announces the change", async () => {
		getPromptById.mockResolvedValue(ORG_PROMPT_HANDLEBARS);
		updatePromptWithVersion.mockResolvedValue({
			prompt: { id: "p-1", name: "Renamed" },
			version: { id: "v-2" },
		});

		await callUpdate({
			name: "Renamed",
			content: "Hi {{{name}}}, updated",
		});

		expect(updatePromptWithVersion).toHaveBeenCalledTimes(1);
		expect(updatePromptWithVersion).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "p-1",
				name: "Renamed",
				content: "Hi {{{name}}}, updated",
			}),
		);
		expect(announceDefaultChangeForWinningActions).toHaveBeenCalledWith(
			expect.objectContaining({
				promptId: "p-1",
				scope: "ORG",
				organizationId: "org-a",
				promptVersionId: "v-2",
				actorUserId: "admin-1",
			}),
		);
	});
});

describe("update: a format change together with a body fix", () => {
	it("validates the NEW body against the NEW format, not the old body being replaced", async () => {
		// The existing latest body is Handlebars and would fail under Liquid —
		// if the old ordering bug were still in place (validate the OLD body
		// against the NEW format before even looking at the submitted content),
		// this save would be rejected for a body the user already replaced.
		getPromptById.mockResolvedValue(ORG_PROMPT_HANDLEBARS);
		updatePromptWithVersion.mockResolvedValue({
			prompt: { id: "p-1", format: "LIQUID" },
			version: { id: "v-2" },
		});

		await expect(
			callUpdate({
				format: "LIQUID",
				content: "{{ name }}",
			}),
		).resolves.toMatchObject({ prompt: { format: "LIQUID" } });

		expect(updatePromptWithVersion).toHaveBeenCalledWith(
			expect.objectContaining({
				format: "LIQUID",
				content: "{{ name }}",
			}),
		);
	});
});

describe("update: metadata-only save of a prompt whose latest body exceeds the limit", () => {
	it("still succeeds — a legacy over-limit body must not block an unrelated rename", async () => {
		const overLimitBody = "x".repeat(60_000);
		getPromptById.mockResolvedValue({
			...ORG_PROMPT_HANDLEBARS,
			versions: [{ id: "v-1", version: 1, content: overLimitBody }],
		});

		await expect(
			callUpdate({ name: "Renamed only" }),
		).resolves.toMatchObject({ prompt: { id: "p-1" } });

		expect(updatePromptWithVersion).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Renamed only",
				content: undefined,
			}),
		);
		// No version was created, so nothing to announce.
		expect(announceDefaultChangeForWinningActions).not.toHaveBeenCalled();
	});
});
