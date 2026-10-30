/**
 * The preview failures of `updateDocumentWithContextProcedure` carry a
 * `data.code` (Fizzy #2946), so the editor can say them in the reader's
 * language instead of a generic failure:
 *
 * - no AI provider for the organization: `AI_PROVIDER_NOT_CONFIGURED`, the
 *   code background jobs already record for the same condition;
 * - a response cut off at the model's output limit: `CONTEXT_UPDATE_TRUNCATED`;
 * - a failed model call: `CONTEXT_UPDATE_FAILED`, apart from the provider
 *   one, since the settings are not at fault.
 *
 * Each keeps its oRPC code and its message. The last block pins whose model
 * the preview drafts with, and whose context it retrieves: the project's
 * owning organization's.
 *
 * Mocks mirror `update-with-context-phase2.test.ts`, with the context-update
 * error classes added so the handler can tell them apart.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mocks,
	ContextUpdateTruncatedError,
	ContextUpdateFailedError,
} = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		hasProjectAccess: vi.fn(),
		getDocumentById: vi.fn(),
		fetchProjectContextSources: vi.fn(),
		runContextUpdate: vi.fn(),
	};
	class ContextUpdateTruncatedError extends Error {}
	class ContextUpdateFailedError extends Error {}
	return {
		handlers,
		mocks,
		ContextUpdateTruncatedError,
		ContextUpdateFailedError,
	};
});

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	getDocumentById: mocks.getDocumentById,
	updateDocument: vi.fn(),
	isProposalClientDocument: vi.fn(),
	DocumentVersionConflictError: class extends Error {},
	DocumentGenerationInProgressError: class extends Error {},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../../../lib/document-side-effects", () => ({
	applyDocumentUpdateSideEffects: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	fetchProjectContextSources: mocks.fetchProjectContextSources,
	runContextUpdate: mocks.runContextUpdate,
	ContextUpdateTruncatedError,
	ContextUpdateFailedError,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.updateWithContext = fn;
			return { _handler: fn };
		},
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

await import("../update-with-context");

function previewInput() {
	return {
		input: {
			projectId: "project-1",
			id: "doc-1",
			organizationId: "org-1",
			preview: true,
			currentContent: "# Spec\n\nExisting body.",
		},
		context: {
			user: { id: "user-1" },
			session: { id: "s-1", activeOrganizationId: "org-1" },
		},
	};
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getDocumentById.mockResolvedValue({
		id: "doc-1",
		projectId: "project-1",
		title: "PRD",
		content: "# Spec\n\nExisting body.",
		version: 5,
		createdAt: new Date("2026-05-01T00:00:00.000Z"),
		updatedAt: new Date("2026-05-02T00:00:00.000Z"),
	});
	mocks.fetchProjectContextSources.mockResolvedValue({
		contextItems: [],
		transcriptCount: 0,
		teamsCount: 0,
		slackCount: 0,
		huddleNotesCount: 0,
	});
});

describe("updateDocumentWithContextProcedure — preview failures a person can act on (Fizzy #2946)", () => {
	it("codes the missing AI provider, keeping its oRPC code and message", async () => {
		// `runContextUpdate` answers null for exactly one thing: no provider.
		mocks.runContextUpdate.mockResolvedValue(null);

		await expect(
			handlers.updateWithContext(previewInput()),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message:
				"No AI provider is configured for this organization. Add one in AI settings, then try again.",
			data: { code: "AI_PROVIDER_NOT_CONFIGURED" },
		});
	});

	it("codes a response cut off at the model's output limit, keeping its oRPC code and message", async () => {
		mocks.runContextUpdate.mockRejectedValue(
			new ContextUpdateTruncatedError("truncated"),
		);

		await expect(
			handlers.updateWithContext(previewInput()),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message:
				"The document is too large for the configured AI model's output limit — the update was truncated before completion. Try a model with a larger output limit or split the document.",
			data: { code: "CONTEXT_UPDATE_TRUNCATED" },
		});
	});

	it("codes a failed model call apart from the provider, keeping its oRPC code and its own message", async () => {
		mocks.runContextUpdate.mockRejectedValue(
			new ContextUpdateFailedError(
				"The AI could not complete the update.",
			),
		);

		await expect(
			handlers.updateWithContext(previewInput()),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "The AI could not complete the update.",
			data: { code: "CONTEXT_UPDATE_FAILED" },
		});
	});

	it("leaves any other failure uncoded", async () => {
		mocks.runContextUpdate.mockRejectedValue(new Error("socket hang up"));

		const error = await (
			handlers.updateWithContext(previewInput()) as Promise<unknown>
		).catch((e: unknown) => e);

		expect(error).toMatchObject({ message: "socket hang up" });
		expect((error as { data?: { code?: unknown } }).data?.code).toBe(
			undefined,
		);
	});
});

describe("updateDocumentWithContextProcedure — the preview's model", () => {
	it("is resolved for the project's owning organization, not the caller's", async () => {
		// A guest working from their own organization: the session and the
		// request name it, while the project belongs to another.
		mocks.getDocumentById.mockResolvedValue({
			...(await mocks.getDocumentById()),
			project: { organizationId: "org-owner" },
		});
		mocks.runContextUpdate.mockResolvedValue({
			hasRelevantContext: false,
			updatedDocument: "# Spec\n\nExisting body.",
			needsHumanResolution: false,
			summary: "No context sources found for this project.",
		});
		const call = previewInput();
		call.input.organizationId = "org-guest";
		call.context.session.activeOrganizationId = "org-guest";

		await handlers.updateWithContext(call);

		expect(mocks.runContextUpdate).toHaveBeenCalledTimes(1);
		expect(mocks.runContextUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-owner",
				userId: "user-1",
				projectId: "project-1",
			}),
		);
		// The context it drafts from is retrieved there too, so the model
		// and the sources never come from two organizations.
		expect(mocks.fetchProjectContextSources).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-owner",
				userId: "user-1",
				projectId: "project-1",
			}),
		);
	});
});
