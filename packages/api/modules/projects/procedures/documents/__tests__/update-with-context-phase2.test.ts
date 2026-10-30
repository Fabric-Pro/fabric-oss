/**
 * Phase-2 backstop for `updateDocumentWithContextProcedure`.
 *
 * `updateDocument` skips the content write and version bump when the confirmed
 * content is normalized-identical to the current document. This suite locks the
 * backstop that turns that silent no-op into an informative `applied: false`
 * response, and confirms a real version bump still returns `applied: true` with
 * the new version.
 *
 * Mocks `@repo/database`, `@repo/logs`, the side-effects helper, the shared
 * context-update core, and the oRPC procedure base so the handler can be
 * invoked directly (mirrors `stories/__tests__/update-with-context-attachment-guard`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mocks,
	DocumentVersionConflictError,
	DocumentGenerationInProgressError,
} = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		hasProjectAccess: vi.fn(),
		getDocumentById: vi.fn(),
		updateDocument: vi.fn(),
		applyDocumentUpdateSideEffects: vi.fn(),
		fetchProjectContextSources: vi.fn(),
		runContextUpdate: vi.fn(),
		loggerInfo: vi.fn(),
		isProposalClientDocument: vi.fn(),
		isFeatureEnabled: vi.fn(),
	};
	class DocumentVersionConflictError extends Error {}
	class DocumentGenerationInProgressError extends Error {}
	return {
		handlers,
		mocks,
		DocumentVersionConflictError,
		DocumentGenerationInProgressError,
	};
});

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	getDocumentById: mocks.getDocumentById,
	updateDocument: mocks.updateDocument,
	isProposalClientDocument: mocks.isProposalClientDocument,
	isFeatureEnabled: mocks.isFeatureEnabled,
	DocumentVersionConflictError,
	DocumentGenerationInProgressError,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfo,
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../../../../lib/document-side-effects", () => ({
	applyDocumentUpdateSideEffects: mocks.applyDocumentUpdateSideEffects,
}));

vi.mock("@repo/temporal", () => ({
	fetchProjectContextSources: mocks.fetchProjectContextSources,
	runContextUpdate: mocks.runContextUpdate,
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

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

const PROJECT_ID = "project-1";
const DOCUMENT_ID = "doc-1";

function makeDocument(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: DOCUMENT_ID,
		projectId: PROJECT_ID,
		title: "PRD",
		content: "# Spec\n\nExisting body.",
		version: 5,
		createdAt: new Date("2026-05-01T00:00:00.000Z"),
		...overrides,
	};
}

function phase2Input(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		input: {
			projectId: PROJECT_ID,
			id: DOCUMENT_ID,
			organizationId: null,
			preview: false,
			confirmedContent: "# Spec\n\nExisting body.",
			...overrides,
		},
		context: ctx,
	};
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		if (typeof (m as { mockReset?: unknown }).mockReset === "function") {
			(m as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.applyDocumentUpdateSideEffects.mockResolvedValue(undefined);
	mocks.isProposalClientDocument.mockResolvedValue(false);
	mocks.isFeatureEnabled.mockResolvedValue(false);
});

describe("updateWithContextProcedure — phase-2 no-op backstop", () => {
	it("returns applied:false + info summary when the version did not bump", async () => {
		mocks.getDocumentById.mockResolvedValue(makeDocument({ version: 5 }));
		// updateDocument no-oped: the same version comes back.
		mocks.updateDocument.mockResolvedValue(makeDocument({ version: 5 }));

		const result = (await handlers.updateWithContext(phase2Input())) as {
			applied: boolean;
			summary: string;
			documentVersion: number;
		};

		expect(result.applied).toBe(false);
		expect(result.summary).toBe(
			"No changes were applied — the confirmed content matches the current document.",
		);
		expect(result.documentVersion).toBe(5);
		expect(mocks.loggerInfo).toHaveBeenCalledTimes(1);
	});

	it("returns applied:true + the new version when the version bumped", async () => {
		mocks.getDocumentById.mockResolvedValue(makeDocument({ version: 5 }));
		mocks.updateDocument.mockResolvedValue(
			makeDocument({ version: 6, content: "# Spec\n\nUpdated body." }),
		);

		const result = (await handlers.updateWithContext(
			phase2Input({ confirmedContent: "# Spec\n\nUpdated body." }),
		)) as {
			applied: boolean;
			summary: string;
			documentVersion: number;
		};

		expect(result.applied).toBe(true);
		expect(result.summary).toBe("Context update applied successfully.");
		expect(result.documentVersion).toBe(6);
		expect(mocks.loggerInfo).not.toHaveBeenCalled();
	});
});

describe("updateWithContextProcedure — the confirm names its base (Fizzy #2946)", () => {
	const PREVIEW_BODY = "# Proposal\n\nThe body the preview was drafted from.";
	const GENERATED_BODY =
		"# Proposal\n\nA generated body saved at the same version.";
	// Stand-in for a hash of the preview's body: the query layer compares it.
	const PREVIEW_HASH = "hash-of-preview-body";

	/** What the query layer holds; its guard compares the base against it. */
	let stored: { content: string; version: number; hash: string };

	function proposalDocument() {
		return makeDocument({
			type: "PROPOSAL",
			content: stored.content,
			version: stored.version,
			status: "COMPLETE",
			project: { organizationId: "org-owner" },
		});
	}

	beforeEach(() => {
		stored = { content: PREVIEW_BODY, version: 5, hash: PREVIEW_HASH };
		mocks.getDocumentById.mockImplementation(async () =>
			proposalDocument(),
		);
		mocks.updateDocument.mockImplementation(
			async (
				_id: string,
				data: {
					content: string;
					expectedVersion?: number;
					expectedContentHash?: string;
				},
			) => {
				if (
					(data.expectedVersion !== undefined &&
						data.expectedVersion !== stored.version) ||
					(data.expectedContentHash !== undefined &&
						data.expectedContentHash !== stored.hash)
				) {
					throw new DocumentVersionConflictError();
				}
				stored = {
					content: data.content,
					version: stored.version + 1,
					hash: "hash-of-written-body",
				};
				return makeDocument({ version: stored.version });
			},
		);
	});

	it("passes both halves of the base to the write", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(true);

		const result = (await handlers.updateWithContext(
			phase2Input({
				confirmedContent: "# Proposal\n\nUpdated from context.",
				expectedVersion: 5,
				expectedContentHash: PREVIEW_HASH,
			}),
		)) as { applied: boolean };

		expect(result.applied).toBe(true);
		expect(mocks.updateDocument).toHaveBeenCalledWith(
			DOCUMENT_ID,
			expect.objectContaining({
				expectedVersion: 5,
				expectedContentHash: PREVIEW_HASH,
			}),
		);
		// A confirm is never exempt from the write's live-run refusal.
		expect(mocks.updateDocument.mock.calls[0][1]).not.toHaveProperty(
			"allowDuringLiveRun",
		);
	});

	it("refuses a confirm whose body changed at the same version, and writes nothing", async () => {
		// A run's final save landed between preview and confirm: same
		// version, different body.
		stored = {
			content: GENERATED_BODY,
			version: 5,
			hash: "hash-of-generated-body",
		};

		await expect(
			handlers.updateWithContext(
				phase2Input({
					confirmedContent: "# Proposal\n\nUpdated from context.",
					expectedVersion: 5,
					expectedContentHash: PREVIEW_HASH,
				}),
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(stored.content).toBe(GENERATED_BODY);
		expect(mocks.applyDocumentUpdateSideEffects).not.toHaveBeenCalled();
	});

	it("keeps a PRD confirm without a base on the version-only guard", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(true);
		mocks.getDocumentById.mockImplementation(async () => ({
			...proposalDocument(),
			type: "PRD",
		}));

		await handlers.updateWithContext(
			phase2Input({ confirmedContent: "# Proposal\n\nUpdated." }),
		);

		const [, data] = mocks.updateDocument.mock.calls[0];
		expect(data.expectedVersion).toBe(5);
		expect(data).not.toHaveProperty("expectedContentHash");
	});

	it("leaves a Proposal confirm to the write's live-run refusal with the Proposal gate off, without requiring a base", async () => {
		// The gate rolled back mid-run: the run keeps writing, so the confirm
		// must still be refused under it. Only the base requirement follows
		// the gate.
		mocks.isProposalClientDocument.mockResolvedValue(false);
		mocks.isFeatureEnabled.mockResolvedValue(true);

		await handlers.updateWithContext(
			phase2Input({ confirmedContent: "# Proposal\n\nUpdated." }),
		);

		const [, data] = mocks.updateDocument.mock.calls[0];
		expect(data.expectedVersion).toBe(5);
		expect(data).not.toHaveProperty("expectedContentHash");
		expect(data).not.toHaveProperty("allowDuringLiveRun");
	});

	it("rejects half a base before writing", async () => {
		await expect(
			handlers.updateWithContext(
				phase2Input({
					confirmedContent: "# Updated",
					expectedVersion: 5,
				}),
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("answers CONFLICT when a generation run holds the Proposal", async () => {
		mocks.updateDocument.mockRejectedValue(
			new DocumentGenerationInProgressError(),
		);

		await expect(
			handlers.updateWithContext(
				phase2Input({
					confirmedContent: "# Updated",
					expectedVersion: 5,
					expectedContentHash: PREVIEW_HASH,
				}),
			),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
		});
		expect(mocks.applyDocumentUpdateSideEffects).not.toHaveBeenCalled();
	});
});

describe("updateWithContextProcedure — a client-document Proposal is not rewritten whole (Fizzy #2946)", () => {
	function proposalDocument(type = "PROPOSAL") {
		return makeDocument({
			type,
			status: "COMPLETE",
			project: { organizationId: "org-owner" },
		});
	}

	it.each([
		["preview", { preview: true, currentContent: "# Proposal" }],
		[
			"confirm",
			{
				confirmedContent: "# Proposal\n\nRewritten.",
				expectedVersion: 5,
				expectedContentHash: "hash-of-preview-body",
			},
		],
	])(
		"refuses the %s, running no model and writing nothing",
		async (_phase, overrides) => {
			mocks.getDocumentById.mockResolvedValue(proposalDocument());
			mocks.isProposalClientDocument.mockResolvedValue(true);

			await expect(
				handlers.updateWithContext(phase2Input(overrides)),
			).rejects.toMatchObject({
				code: "PRECONDITION_FAILED",
				data: { code: "PROPOSAL_USE_CHAT_OR_REGENERATE" },
			});
			expect(mocks.fetchProjectContextSources).not.toHaveBeenCalled();
			expect(mocks.runContextUpdate).not.toHaveBeenCalled();
			expect(mocks.updateDocument).not.toHaveBeenCalled();
			expect(mocks.applyDocumentUpdateSideEffects).not.toHaveBeenCalled();
		},
	);

	it("judges the Proposal by the project's owning organization, not the caller's", async () => {
		mocks.getDocumentById.mockResolvedValue(proposalDocument());
		// The gate is on for the owning organization only.
		mocks.isProposalClientDocument.mockImplementation(
			async (args: { organizationId: string | null }) =>
				args.organizationId === "org-owner",
		);

		await expect(
			handlers.updateWithContext(
				phase2Input({
					organizationId: "org-session",
					confirmedContent: "# Proposal\n\nRewritten.",
				}),
			),
		).rejects.toMatchObject({
			data: { code: "PROPOSAL_USE_CHAT_OR_REGENERATE" },
		});
		expect(mocks.isProposalClientDocument).toHaveBeenCalledWith({
			organizationId: "org-owner",
			documentType: "PROPOSAL",
		});
		expect(mocks.isProposalClientDocument).not.toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-session" }),
		);
	});

	it("still updates a Proposal with the gate off", async () => {
		mocks.getDocumentById.mockResolvedValue(proposalDocument());
		mocks.updateDocument.mockResolvedValue(makeDocument({ version: 6 }));

		const result = (await handlers.updateWithContext(
			phase2Input({ confirmedContent: "# Proposal\n\nRewritten." }),
		)) as { applied: boolean };

		expect(result.applied).toBe(true);
		expect(mocks.updateDocument).toHaveBeenCalledTimes(1);
	});

	it("still previews a Technical Spec in an organization with the gate on", async () => {
		mocks.getDocumentById.mockResolvedValue(
			proposalDocument("TECHNICAL_SPEC"),
		);
		mocks.isProposalClientDocument.mockImplementation(
			async (args: { documentType: string }) =>
				args.documentType === "PROPOSAL",
		);
		mocks.fetchProjectContextSources.mockResolvedValue({
			contextItems: [],
			transcriptCount: 0,
			teamsCount: 0,
			slackCount: 0,
			huddleNotesCount: 0,
		});
		mocks.runContextUpdate.mockResolvedValue({
			hasRelevantContext: true,
			summary: "Added the new endpoint.",
			needsHumanResolution: false,
			updatedDocument: "# Spec\n\nWith the new endpoint.",
		});

		const result = (await handlers.updateWithContext(
			phase2Input({ preview: true, currentContent: "# Spec" }),
		)) as { proposedContent: string | null };

		expect(result.proposedContent).toBe("# Spec\n\nWith the new endpoint.");
		expect(mocks.runContextUpdate).toHaveBeenCalledTimes(1);
	});
});

describe("updateWithContextProcedure — the confirm's organization", () => {
	it("writes the version and re-embeds in the project's owning organization, not the caller's", async () => {
		// A caller whose request names another organization than the
		// project's. In a router call the project permission check refuses
		// that; the handler must not depend on it.
		mocks.getDocumentById.mockResolvedValue(
			makeDocument({ project: { organizationId: "org-owner" } }),
		);
		const updated = makeDocument({ version: 6 });
		mocks.updateDocument.mockResolvedValue(updated);

		const result = (await handlers.updateWithContext(
			phase2Input({
				organizationId: "org-guest",
				confirmedContent: "# Spec\n\nUpdated body.",
			}),
		)) as { applied: boolean };

		expect(result.applied).toBe(true);
		expect(mocks.updateDocument).toHaveBeenCalledWith(
			DOCUMENT_ID,
			expect.objectContaining({
				organizationId: "org-owner",
				userId: "user-1",
			}),
		);
		expect(mocks.applyDocumentUpdateSideEffects).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT_ID,
				document: updated,
				organizationId: "org-owner",
			}),
		);
	});
});
