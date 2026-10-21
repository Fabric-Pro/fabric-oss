/**
 * The optional base on `updateDocumentProcedure`: `expectedVersion`
 * (Fizzy #2589) and `expectedContentHash` (Fizzy #2946).
 *
 * The in-editor assistant accept sends the version when a visual slot is
 * involved, and a save from a collaborative editor room sends both halves
 * from the room's stamp, so a save that raced another writer leaves the
 * document untouched instead of overwriting it with an older body:
 *  - given     ⇒ passed through to `updateDocument`;
 *  - conflict  ⇒ CONFLICT with a fixed message, and no side effect runs;
 *  - absent    ⇒ the exact unguarded call every other save makes, except a
 *                content-bearing save of a client-document Proposal while the
 *                room flag is on, which is refused with a reload code;
 *  - the response names the saved body's identity beside its version;
 *  - a save that ended a stalled Proposal run stops the run's generation
 *    child in the background;
 *  - authorization and the document-to-project binding still come first.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockHasProjectAccess,
	mockUpdateDocument,
	mockApplySideEffects,
	mockProjectDocumentFindUnique,
	mockFanOutDocumentMention,
	mockFanOutSubscriptionUpdate,
	mockIsProposalClientDocument,
	mockIsFeatureEnabled,
	mockLoggerInfo,
	mockRunInBackground,
	mockCancelStalledGenerationRun,
	DocumentVersionConflictErrorMock,
	DocumentGenerationInProgressErrorMock,
} = vi.hoisted(() => {
	class DocumentGenerationInProgressErrorMock extends Error {
		constructor(readonly documentId: string) {
			super(
				`Document ${documentId} is being written by a generation run.`,
			);
			this.name = "DocumentGenerationInProgressError";
		}
	}
	class DocumentVersionConflictErrorMock extends Error {
		constructor(
			readonly documentId: string,
			readonly expectedVersion: number,
			readonly actualVersion: number,
			readonly reason: "version" | "content" = "version",
		) {
			super(
				`Document ${documentId} moved from version ${expectedVersion} to ${actualVersion} while the update was being prepared.`,
			);
			this.name = "DocumentVersionConflictError";
		}
	}
	return {
		handlers: {} as Record<string, (...args: unknown[]) => unknown>,
		mockHasProjectAccess: vi.fn(),
		mockUpdateDocument: vi.fn(),
		mockApplySideEffects: vi.fn(),
		mockProjectDocumentFindUnique: vi.fn(),
		mockFanOutDocumentMention: vi.fn(),
		mockFanOutSubscriptionUpdate: vi.fn(),
		mockIsProposalClientDocument: vi.fn(),
		mockIsFeatureEnabled: vi.fn(),
		mockLoggerInfo: vi.fn(),
		mockRunInBackground: vi.fn(),
		mockCancelStalledGenerationRun: vi.fn(),
		DocumentVersionConflictErrorMock,
		DocumentGenerationInProgressErrorMock,
	};
});

vi.mock("@repo/database", () => ({
	DocumentVersionConflictError: DocumentVersionConflictErrorMock,
	DocumentGenerationInProgressError: DocumentGenerationInProgressErrorMock,
	IntegrationContractStatusManagedError: class extends Error {},
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
	isProposalClientDocument: (...args: unknown[]) =>
		mockIsProposalClientDocument(...args),
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
	buildDocumentLink: (args: { projectId: string; documentId: string }) =>
		`projects/${args.projectId}/documents/${args.documentId}`,
	db: {
		projectDocument: {
			findUnique: (...args: unknown[]) =>
				mockProjectDocumentFindUnique(...args),
		},
	},
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: (...args: unknown[]) => mockLoggerInfo(...args),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("@repo/database/prisma/zod", () => ({
	ProjectDocumentStatusSchema: {
		optional: () => ({}),
	},
}));

vi.mock("../../../../lib/document-side-effects", () => ({
	applyDocumentUpdateSideEffects: (...args: unknown[]) =>
		mockApplySideEffects(...args),
}));

vi.mock("../../../../lib/notification-service", () => ({
	fanOut: {
		documentMention: (...args: unknown[]) =>
			mockFanOutDocumentMention(...args),
		subscriptionUpdate: (...args: unknown[]) =>
			mockFanOutSubscriptionUpdate(...args),
	},
}));

vi.mock("../../../weave/lib/run-in-background", () => ({
	runInBackground: (...args: unknown[]) => mockRunInBackground(...args),
}));

vi.mock("../../lib/cancel-stalled-generation-run", () => ({
	cancelStalledGenerationRun: (...args: unknown[]) =>
		mockCancelStalledGenerationRun(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.updateDocument = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

// Side-effect: register the handler.
import "../update-document";

const ctx = {
	user: { id: "actor_1", name: "Alice" },
	session: { id: "session-1", activeOrganizationId: "org_1" },
};

const SLOTTED = `## Phases\n\nOne, then two.\n\n<visual-slot id="slot-a" kind="timeline"></visual-slot>`;

const input = {
	projectId: "proj_1",
	id: "doc_1",
	organizationId: "org_1",
	content: SLOTTED,
};

async function flushPromises() {
	// Let any fire-and-forget fan-out settle so it never leaks into a later
	// test (and so a test asserting "no fan-out" sees the final count).
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockApplySideEffects.mockResolvedValue(undefined);
	mockFanOutDocumentMention.mockResolvedValue(undefined);
	mockFanOutSubscriptionUpdate.mockResolvedValue(undefined);
	mockIsProposalClientDocument.mockResolvedValue(false);
	mockIsFeatureEnabled.mockResolvedValue(false);
	mockCancelStalledGenerationRun.mockResolvedValue(undefined);
	mockProjectDocumentFindUnique.mockResolvedValue({
		projectId: "proj_1",
		content: "## Phases\n\nOne.",
		title: "Business case",
		status: "DRAFT",
		type: "BUSINESS_CASE",
		version: 3,
		project: { organizationId: "org_1" },
	});
	mockUpdateDocument.mockResolvedValue({
		id: "doc_1",
		title: "Business case",
		content: SLOTTED,
		version: 4,
	});
});

describe("updateDocumentProcedure — optional expectedVersion guard", () => {
	it("passes expectedVersion through to updateDocument when given", async () => {
		const result = (await handlers.updateDocument({
			input: { ...input, expectedVersion: 3 },
			context: ctx,
		})) as { document: { version: number } };
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({
				content: SLOTTED,
				expectedVersion: 3,
				userId: "actor_1",
				organizationId: "org_1",
			}),
		);
		expect(result.document.version).toBe(4);
		expect(mockApplySideEffects).toHaveBeenCalledTimes(1);
	});

	it("maps a version conflict to CONFLICT with a fixed message and runs no side effect", async () => {
		mockUpdateDocument.mockRejectedValue(
			new DocumentVersionConflictErrorMock("doc_1", 3, 5),
		);

		const error = await (
			handlers.updateDocument({
				input: { ...input, expectedVersion: 3 },
				context: ctx,
			}) as Promise<unknown>
		).catch((e: unknown) => e);
		await flushPromises();

		expect(error).toMatchObject({
			code: "CONFLICT",
			message:
				"The document changed while your changes were being saved, so nothing was saved. Review the latest version and apply your changes again.",
		});
		// The internal version numbers stay out of the client-facing message.
		expect((error as Error).message).not.toMatch(/moved from version/);
		expect(mockApplySideEffects).not.toHaveBeenCalled();
		expect(mockFanOutDocumentMention).not.toHaveBeenCalled();
		expect(mockFanOutSubscriptionUpdate).not.toHaveBeenCalled();
	});

	it("without expectedVersion makes exactly the unguarded call it always made", async () => {
		await handlers.updateDocument({ input, context: ctx });
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
		const [, data] = mockUpdateDocument.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(data).not.toHaveProperty("expectedVersion");
		expect(data).toEqual({
			title: undefined,
			content: SLOTTED,
			status: undefined,
			lastEditedBy: "actor_1",
			changeDescription: undefined,
			userId: "actor_1",
			organizationId: "org_1",
			skipVersionBump: undefined,
			// The editor's plain content save is the one write exempt from
			// the query's live-run refusal (Fizzy #2946).
			allowDuringLiveRun: "editor-content-save",
		});
	});

	it("still refuses a caller without project access before any write", async () => {
		mockHasProjectAccess.mockResolvedValue(false);

		await expect(
			handlers.updateDocument({
				input: { ...input, expectedVersion: 3 },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mockUpdateDocument).not.toHaveBeenCalled();
	});

	it("still refuses a document from another project before any write", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			projectId: "proj_other",
			content: "",
			title: "Elsewhere",
			status: "DRAFT",
			type: "BUSINESS_CASE",
			version: 3,
		});

		await expect(
			handlers.updateDocument({
				input: { ...input, expectedVersion: 3 },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockUpdateDocument).not.toHaveBeenCalled();
	});
});

describe("updateDocumentProcedure — the body half of the base", () => {
	const ROOM_HASH = "a".repeat(64);

	it("passes expectedContentHash through beside expectedVersion", async () => {
		await handlers.updateDocument({
			input: {
				...input,
				expectedVersion: 3,
				expectedContentHash: ROOM_HASH,
			},
			context: ctx,
		});
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({
				expectedVersion: 3,
				expectedContentHash: ROOM_HASH,
			}),
		);
	});

	it("returns the saved body's identity beside its version", async () => {
		const result = (await handlers.updateDocument({
			input: {
				...input,
				expectedVersion: 3,
				expectedContentHash: ROOM_HASH,
			},
			context: ctx,
		})) as { document: { version: number; contentHash: string } };
		await flushPromises();

		expect(result.document.version).toBe(4);
		expect(result.document.contentHash).toBe(
			createHash("sha256").update(SLOTTED, "utf8").digest("hex"),
		);
	});

	it("maps a body changed at the same version to the same CONFLICT, and runs no side effect", async () => {
		mockUpdateDocument.mockRejectedValue(
			new DocumentVersionConflictErrorMock("doc_1", 3, 3, "content"),
		);

		const error = await (
			handlers.updateDocument({
				input: {
					...input,
					expectedVersion: 3,
					expectedContentHash: ROOM_HASH,
				},
				context: ctx,
			}) as Promise<unknown>
		).catch((e: unknown) => e);
		await flushPromises();

		expect(error).toMatchObject({ code: "CONFLICT" });
		expect(mockApplySideEffects).not.toHaveBeenCalled();
		expect(mockFanOutSubscriptionUpdate).not.toHaveBeenCalled();
	});
});

describe("updateDocumentProcedure — the base a client-document Proposal requires", () => {
	const PROPOSAL_PRIOR = {
		projectId: "proj_1",
		content: "## Scope\n\nThe body before the run.",
		title: "Proposal",
		status: "COMPLETE",
		type: "PROPOSAL",
		version: 3,
		// The OWNING organization, deliberately not the session's.
		project: { organizationId: "org_owner" },
	};

	beforeEach(() => {
		mockProjectDocumentFindUnique.mockResolvedValue(PROPOSAL_PRIOR);
		mockIsProposalClientDocument.mockImplementation(
			async (args: { documentType: string }) =>
				args.documentType === "PROPOSAL",
		);
		mockIsFeatureEnabled.mockResolvedValue(true);
	});

	it("refuses a content-bearing save without a base, with the reload code, and writes nothing", async () => {
		const error = await (
			handlers.updateDocument({ input, context: ctx }) as Promise<unknown>
		).catch((e: unknown) => e);
		await flushPromises();

		expect(error).toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { code: "DOCUMENT_SAVE_BASE_REQUIRED" },
		});
		expect(mockUpdateDocument).not.toHaveBeenCalled();
		expect(mockApplySideEffects).not.toHaveBeenCalled();
		// Judged for the project's owning organization, never the session's.
		expect(mockIsProposalClientDocument).toHaveBeenCalledWith({
			organizationId: "org_owner",
			documentType: "PROPOSAL",
		});
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"DOCUMENT_ROOM_CONVERGENCE",
			"org_owner",
		);
	});

	it("refuses a save that names only half of its base", async () => {
		for (const half of [
			{ expectedVersion: 3 },
			{ expectedContentHash: "b".repeat(64) },
		]) {
			mockUpdateDocument.mockClear();
			const error = await (
				handlers.updateDocument({
					input: { ...input, ...half },
					context: ctx,
				}) as Promise<unknown>
			).catch((e: unknown) => e);

			expect(error).toMatchObject({
				code: "PRECONDITION_FAILED",
				data: { code: "DOCUMENT_SAVE_BASE_REQUIRED" },
			});
			expect(mockUpdateDocument).not.toHaveBeenCalled();
		}
	});

	it("refuses the no-bump revert without a base too", async () => {
		const error = await (
			handlers.updateDocument({
				input: { ...input, skipVersionBump: true },
				context: ctx,
			}) as Promise<unknown>
		).catch((e: unknown) => e);

		expect(error).toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { code: "DOCUMENT_SAVE_BASE_REQUIRED" },
		});
		expect(mockUpdateDocument).not.toHaveBeenCalled();
	});

	it("accepts a save that names its whole base, without reading the flag", async () => {
		await handlers.updateDocument({
			input: {
				...input,
				expectedVersion: 3,
				expectedContentHash: "c".repeat(64),
			},
			context: ctx,
		});
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
	});

	it("accepts a save without a base when the room flag is off for the owning organization", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		await handlers.updateDocument({ input, context: ctx });
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"DOCUMENT_ROOM_CONVERGENCE",
			"org_owner",
		);
	});

	it("never requires a base for a title-only or status-only save", async () => {
		for (const metadataOnly of [
			{ title: "Proposal for example-org" },
			{ status: "REVIEW" },
			{ completeDraft: true },
		]) {
			await handlers.updateDocument({
				input: { projectId: "proj_1", id: "doc_1", ...metadataOnly },
				context: ctx,
			});
		}
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledTimes(3);
		// None of them asks whether this is a client Proposal (the status
		// save's run guard is decided by type) or reads the room flag.
		expect(mockIsProposalClientDocument).not.toHaveBeenCalled();
		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
	});

	it("accepts a PRD without a base and logs it with ids and the caller surface only", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			...PROPOSAL_PRIOR,
			title: "PRD",
			type: "PRD",
		});

		mockIsFeatureEnabled.mockResolvedValue(true);

		await handlers.updateDocument({ input, context: ctx });
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
		const baseLog = mockLoggerInfo.mock.calls.find(
			([, message]) =>
				message ===
				"[update-document] content-bearing save without a base",
		);
		expect(baseLog?.[0]).toEqual({
			documentId: "doc_1",
			projectId: "proj_1",
			organizationId: "org_owner",
			documentType: "PRD",
			surface: "projects.documents.update",
			hasExpectedVersion: false,
			hasExpectedContentHash: false,
			skipVersionBump: false,
			completeDraft: false,
		});
		// No body, of either side, reaches the log.
		expect(JSON.stringify(baseLog)).not.toContain("Phases");
	});

	it("logs nothing for a save without a base while the room flag is off", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			...PROPOSAL_PRIOR,
			title: "PRD",
			type: "PRD",
		});
		mockIsFeatureEnabled.mockResolvedValue(false);

		await handlers.updateDocument({ input, context: ctx });
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
		expect(
			mockLoggerInfo.mock.calls.some(
				([, message]) =>
					message ===
					"[update-document] content-bearing save without a base",
			),
		).toBe(false);
	});
});

describe("updateDocumentProcedure — a Proposal's status under a run", () => {
	function proposalPrior(status: string) {
		return {
			projectId: "proj_1",
			content: "## Scope\n\nThe body a run is writing.",
			title: "Proposal",
			status,
			type: "PROPOSAL",
			version: 3,
			project: { organizationId: "org_owner" },
		};
	}

	beforeEach(() => {
		mockIsProposalClientDocument.mockImplementation(
			async (args: { documentType: string }) =>
				args.documentType === "PROPOSAL",
		);
		mockIsFeatureEnabled.mockResolvedValue(true);
	});

	// QUEUED and GENERATING are set by generation dispatch with the run's
	// workflow id and start time. A row a caller moves to either status has
	// neither, so the run guard would refuse every later write and the
	// watchdog could never move it on (Fizzy #2946).
	it.each([
		["COMPLETE", "QUEUED"],
		["COMPLETE", "GENERATING"],
		["GENERATING", "GENERATING"],
	])(
		"refuses a client move of a %s Proposal to the generation-owned status %s, and writes nothing",
		async (prior, status) => {
			mockProjectDocumentFindUnique.mockResolvedValue(
				proposalPrior(prior),
			);

			const error = await (
				handlers.updateDocument({
					input: { projectId: "proj_1", id: "doc_1", status },
					context: ctx,
				}) as Promise<unknown>
			).catch((e: unknown) => e);
			await flushPromises();

			expect(error).toMatchObject({
				code: "BAD_REQUEST",
				data: { code: "DOCUMENT_STATUS_GENERATION_OWNED" },
			});
			expect(mockUpdateDocument).not.toHaveBeenCalled();
			expect(mockApplySideEffects).not.toHaveBeenCalled();
		},
	);

	it("refuses a client move of any document type to QUEUED", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			...proposalPrior("COMPLETE"),
			type: "PRD",
		});

		const error = await (
			handlers.updateDocument({
				input: { projectId: "proj_1", id: "doc_1", status: "QUEUED" },
				context: ctx,
			}) as Promise<unknown>
		).catch((e: unknown) => e);

		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			data: { code: "DOCUMENT_STATUS_GENERATION_OWNED" },
		});
		expect(mockUpdateDocument).not.toHaveBeenCalled();
	});

	it("still moves a COMPLETE Proposal back to DRAFT", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue(
			proposalPrior("COMPLETE"),
		);

		await handlers.updateDocument({
			input: { projectId: "proj_1", id: "doc_1", status: "DRAFT" },
			context: ctx,
		});
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({ status: "DRAFT" }),
		);
	});

	it.each(["QUEUED", "GENERATING"])(
		"refuses a status change while the run is %s, with the live-run code, and writes nothing",
		async (status) => {
			mockProjectDocumentFindUnique.mockResolvedValue(
				proposalPrior(status),
			);

			const error = await (
				handlers.updateDocument({
					input: {
						projectId: "proj_1",
						id: "doc_1",
						status: "COMPLETE",
					},
					context: ctx,
				}) as Promise<unknown>
			).catch((e: unknown) => e);
			await flushPromises();

			expect(error).toMatchObject({
				code: "CONFLICT",
				data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
			});
			expect(mockUpdateDocument).not.toHaveBeenCalled();
			expect(mockApplySideEffects).not.toHaveBeenCalled();
			// Decided by type: the rollout gate is not consulted.
			expect(mockIsProposalClientDocument).not.toHaveBeenCalled();
		},
	);

	it.each(["QUEUED", "GENERATING"])(
		"still refuses a status change and the Reject fallback's rewind while the run is %s after the Proposal gate is turned off",
		async (status) => {
			// The gate rolled back mid-run: the run keeps writing, so its
			// hold on the status and the body must not lapse with the gate.
			mockIsProposalClientDocument.mockResolvedValue(false);
			mockIsFeatureEnabled.mockResolvedValue(false);
			mockProjectDocumentFindUnique.mockResolvedValue(
				proposalPrior(status),
			);

			for (const write of [
				{ status: "COMPLETE" },
				{
					...input,
					skipVersionBump: true,
					expectedVersion: 3,
					expectedContentHash: "c".repeat(64),
				},
			]) {
				const error = await (
					handlers.updateDocument({
						input: { projectId: "proj_1", id: "doc_1", ...write },
						context: ctx,
					}) as Promise<unknown>
				).catch((e: unknown) => e);
				expect(error).toMatchObject({
					code: "CONFLICT",
					data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
				});
			}
			await flushPromises();

			expect(mockUpdateDocument).not.toHaveBeenCalled();
		},
	);

	it("leaves a finished Proposal's status change to the write's live-run refusal with the gate off", async () => {
		mockIsProposalClientDocument.mockResolvedValue(false);
		mockIsFeatureEnabled.mockResolvedValue(false);
		mockProjectDocumentFindUnique.mockResolvedValue(
			proposalPrior("REVIEW"),
		);

		await handlers.updateDocument({
			input: { projectId: "proj_1", id: "doc_1", status: "COMPLETE" },
			context: ctx,
		});
		await flushPromises();

		// The query refuses a status write under a run by default; the
		// procedure must not exempt it.
		expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
		expect(mockUpdateDocument.mock.calls[0][1]).toMatchObject({
			status: "COMPLETE",
		});
		expect(mockUpdateDocument.mock.calls[0][1]).not.toHaveProperty(
			"allowDuringLiveRun",
		);
	});

	it("maps the write's refusal of a run queued after the read to the live-run code", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue(
			proposalPrior("REVIEW"),
		);
		mockUpdateDocument.mockRejectedValue(
			new DocumentGenerationInProgressErrorMock("doc_1"),
		);

		const error = await (
			handlers.updateDocument({
				input: { projectId: "proj_1", id: "doc_1", status: "COMPLETE" },
				context: ctx,
			}) as Promise<unknown>
		).catch((e: unknown) => e);
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({ status: "COMPLETE" }),
		);
		expect(mockUpdateDocument.mock.calls[0][1]).not.toHaveProperty(
			"allowDuringLiveRun",
		);
		expect(error).toMatchObject({
			code: "CONFLICT",
			data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
		});
		expect(mockApplySideEffects).not.toHaveBeenCalled();
	});

	// The editor's opt-out cannot be told apart from any other caller's
	// content save, so the row decides: only a run silent past the ten-minute
	// ceiling the editor itself stops treating as writing may be written over.
	const writtenAgo = (ms: number) => new Date(Date.now() - ms);
	const STALLED_FOR_MS = 11 * 60 * 1000;

	it.each([
		["QUEUED", "with a base", 0, true],
		["QUEUED", "without a base", 60 * 60 * 1000, false],
		["GENERATING", "with a base", 0, true],
		["GENERATING", "without a base", 9 * 60 * 1000, false],
	])(
		"refuses a content-only save while the run is %s and still writing (%s), and writes nothing",
		async (status, _label, silentForMs, withBase) => {
			mockProjectDocumentFindUnique.mockResolvedValue({
				...proposalPrior(status as string),
				updatedAt: writtenAgo(silentForMs as number),
			});

			const error = await (
				handlers.updateDocument({
					input: {
						...input,
						...(withBase
							? {
									expectedVersion: 3,
									expectedContentHash: "c".repeat(64),
								}
							: {}),
					},
					context: ctx,
				}) as Promise<unknown>
			).catch((e: unknown) => e);
			await flushPromises();

			// The live-run code, ahead of the base requirement: a save
			// without a base is told a run holds the document, not to reload.
			expect(error).toMatchObject({
				code: "CONFLICT",
				data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
			});
			expect(mockUpdateDocument).not.toHaveBeenCalled();
			expect(mockApplySideEffects).not.toHaveBeenCalled();
		},
	);

	it("reads the run's clock with the document", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue(
			proposalPrior("COMPLETE"),
		);

		await handlers.updateDocument({
			input: { projectId: "proj_1", id: "doc_1", title: "Renamed" },
			context: ctx,
		});

		expect(mockProjectDocumentFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				select: expect.objectContaining({
					status: true,
					generationStartedAt: true,
					updatedAt: true,
					workflowId: true,
				}),
			}),
		);
	});

	it("exempts the editor's content save over a stalled run from the live-run refusal, as a stalled run must not block it", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			...proposalPrior("GENERATING"),
			updatedAt: writtenAgo(STALLED_FOR_MS),
		});

		await handlers.updateDocument({
			input: {
				...input,
				expectedVersion: 3,
				expectedContentHash: "c".repeat(64),
				completeDraft: true,
			},
			context: ctx,
		});
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
		expect(mockUpdateDocument.mock.calls[0][1]).toMatchObject({
			expectedVersion: 3,
			expectedContentHash: "c".repeat(64),
			allowDuringLiveRun: "editor-content-save",
		});
	});

	it("answers a save that ended a stalled run with the completed document, and nudges the other tabs", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			...proposalPrior("GENERATING"),
			updatedAt: writtenAgo(STALLED_FOR_MS),
		});
		// The write ended the run: the row it returns is COMPLETE.
		mockUpdateDocument.mockResolvedValue({
			id: "doc_1",
			title: "Proposal",
			type: "PROPOSAL",
			content: SLOTTED,
			version: 4,
			status: "COMPLETE",
		});

		const result = (await handlers.updateDocument({
			input: {
				...input,
				expectedVersion: 3,
				expectedContentHash: "c".repeat(64),
			},
			context: ctx,
		})) as { document: { status: string; version: number } };
		await flushPromises();

		// The editor takes COMPLETE from this answer into its cache, so it
		// stops treating the document as held by a run.
		expect(result.document).toMatchObject({
			status: "COMPLETE",
			version: 4,
		});
		// The `document_change` nudge and the re-embed of a COMPLETE body.
		expect(mockApplySideEffects).toHaveBeenCalledWith(
			expect.objectContaining({
				document: expect.objectContaining({ status: "COMPLETE" }),
				skipEmbed: false,
			}),
		);
	});

	it.each([
		["a title-only save", { title: "Renamed" }],
		["a completeDraft-only save", { completeDraft: true }],
	])(
		"lets %s through under a run with no exemption, as the query never refuses it",
		async (_label, write) => {
			mockProjectDocumentFindUnique.mockResolvedValue(
				proposalPrior("GENERATING"),
			);

			await handlers.updateDocument({
				input: { projectId: "proj_1", id: "doc_1", ...write },
				context: ctx,
			});
			await flushPromises();

			expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
			expect(mockUpdateDocument.mock.calls[0][1]).toMatchObject({
				content: undefined,
				status: undefined,
			});
			expect(mockUpdateDocument.mock.calls[0][1]).not.toHaveProperty(
				"allowDuringLiveRun",
			);
		},
	);

	it.each(["QUEUED", "GENERATING"])(
		"refuses the Reject fallback's rewind while the run is %s, writing nothing",
		async (status) => {
			mockProjectDocumentFindUnique.mockResolvedValue(
				proposalPrior(status),
			);

			const error = await (
				handlers.updateDocument({
					input: {
						...input,
						skipVersionBump: true,
						expectedVersion: 3,
						expectedContentHash: "c".repeat(64),
					},
					context: ctx,
				}) as Promise<unknown>
			).catch((e: unknown) => e);
			await flushPromises();

			expect(error).toMatchObject({
				code: "CONFLICT",
				data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
			});
			expect(mockUpdateDocument).not.toHaveBeenCalled();
		},
	);

	it("leaves the Reject fallback's rewind after a finished run to the write's live-run refusal", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue(
			proposalPrior("COMPLETE"),
		);

		await handlers.updateDocument({
			input: {
				...input,
				skipVersionBump: true,
				expectedVersion: 3,
				expectedContentHash: "c".repeat(64),
			},
			context: ctx,
		});
		await flushPromises();

		expect(mockUpdateDocument).toHaveBeenCalledWith(
			"doc_1",
			expect.objectContaining({ skipVersionBump: true }),
		);
		expect(mockUpdateDocument.mock.calls[0][1]).not.toHaveProperty(
			"allowDuringLiveRun",
		);
	});

	it("leaves a status change to a non-Proposal document under a run unguarded", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			...proposalPrior("GENERATING"),
			type: "PRD",
		});

		await handlers.updateDocument({
			input: { projectId: "proj_1", id: "doc_1", status: "COMPLETE" },
			context: ctx,
		});
		await flushPromises();

		// Not refused here: the query's live-run refusal is for Proposals.
		expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
		expect(mockUpdateDocument.mock.calls[0][1]).toMatchObject({
			status: "COMPLETE",
		});
	});

	// A save that ended a stalled run also stops the run's generation child,
	// after the response and best effort; no other save schedules anything.
	describe("stopping the run a save ended", () => {
		const RUN_WORKFLOW_ID =
			"project-document-generation-doc_1-0123456789abcdef";
		const stalledRun = (overrides: Record<string, unknown> = {}) => ({
			...proposalPrior("GENERATING"),
			updatedAt: writtenAgo(STALLED_FOR_MS),
			workflowId: RUN_WORKFLOW_ID,
			...overrides,
		});
		const savedRow = (status: string, type = "PROPOSAL") => ({
			id: "doc_1",
			title: "Proposal",
			type,
			content: SLOTTED,
			version: 4,
			status,
		});
		const editorSave = {
			...input,
			expectedVersion: 3,
			expectedContentHash: "c".repeat(64),
		};

		it("schedules the cancel of the run's child, by the row's workflow id, when the save ended a stalled run", async () => {
			mockProjectDocumentFindUnique.mockResolvedValue(stalledRun());
			mockUpdateDocument.mockResolvedValue(savedRow("COMPLETE"));
			const cancelling = Promise.resolve();
			mockCancelStalledGenerationRun.mockReturnValue(cancelling);

			await handlers.updateDocument({ input: editorSave, context: ctx });
			await flushPromises();

			expect(mockCancelStalledGenerationRun).toHaveBeenCalledTimes(1);
			expect(mockCancelStalledGenerationRun).toHaveBeenCalledWith({
				documentId: "doc_1",
				workflowId: RUN_WORKFLOW_ID,
			});
			// Handed to the background runner, never awaited by the save.
			expect(mockRunInBackground).toHaveBeenCalledTimes(1);
			expect(mockRunInBackground).toHaveBeenCalledWith(cancelling);
		});

		it.each([
			[
				"an ordinary save of a complete Proposal",
				{ ...proposalPrior("COMPLETE"), workflowId: RUN_WORKFLOW_ID },
				editorSave,
				savedRow("COMPLETE"),
			],
			[
				"a save of a non-Proposal document that was generating",
				stalledRun({ type: "PRD" }),
				editorSave,
				savedRow("COMPLETE", "PRD"),
			],
			[
				"a save over a run whose row names no workflow",
				stalledRun({ workflowId: null }),
				editorSave,
				savedRow("COMPLETE"),
			],
			[
				"a title-only save that found the run finished",
				stalledRun(),
				{ projectId: "proj_1", id: "doc_1", title: "Renamed" },
				savedRow("COMPLETE"),
			],
			[
				"a save over a run the watchdog failed in between",
				stalledRun(),
				editorSave,
				savedRow("FAILED"),
			],
		])("schedules nothing for %s", async (_label, prior, write, saved) => {
			mockProjectDocumentFindUnique.mockResolvedValue(prior);
			mockUpdateDocument.mockResolvedValue(saved);

			await handlers.updateDocument({ input: write, context: ctx });
			await flushPromises();

			expect(mockUpdateDocument).toHaveBeenCalledTimes(1);
			expect(mockCancelStalledGenerationRun).not.toHaveBeenCalled();
			expect(mockRunInBackground).not.toHaveBeenCalled();
		});

		it.each([
			[
				"refused under a live run",
				{ updatedAt: writtenAgo(0) },
				undefined,
			],
			[
				"refused by the write, as the run woke in between",
				{},
				new DocumentGenerationInProgressErrorMock("doc_1"),
			],
			[
				"refused by the write, as its base moved",
				{},
				new DocumentVersionConflictErrorMock("doc_1", 3, 4),
			],
		])(
			"schedules nothing for a save %s",
			async (_label, priorOverrides, writeError) => {
				mockProjectDocumentFindUnique.mockResolvedValue(
					stalledRun(priorOverrides),
				);
				if (writeError) {
					mockUpdateDocument.mockRejectedValue(writeError);
				}

				const error = await (
					handlers.updateDocument({
						input: editorSave,
						context: ctx,
					}) as Promise<unknown>
				).catch((e: unknown) => e);
				await flushPromises();

				expect(error).toMatchObject({ code: "CONFLICT" });
				expect(mockCancelStalledGenerationRun).not.toHaveBeenCalled();
				expect(mockRunInBackground).not.toHaveBeenCalled();
			},
		);
	});
});
