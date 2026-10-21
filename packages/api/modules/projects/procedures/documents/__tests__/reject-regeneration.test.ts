/**
 * Tests for `rejectRegenerationProcedure`.
 *
 * A client-document Proposal's body belongs to its generation run while the
 * run is queued or writing (Fizzy #2946). A review dialog can still be open
 * when a newer run starts, so a Reject under a run is refused with a code the
 * client can tell apart from "no prior version", both from the procedure's
 * read and by the rewind itself when a run is queued in between.
 *
 * Run with:
 *   pnpm --filter @repo/api exec vitest run modules/projects/procedures/documents/__tests__/reject-regeneration.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	inputSchema,
	mockApplySideEffects,
	DocumentGenerationInProgressErrorMock,
	DocumentVersionConflictErrorMock,
	DocumentRegenerationReviewStaleErrorMock,
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
		constructor(readonly documentId: string) {
			super(
				`Document ${documentId} moved while the update was prepared.`,
			);
			this.name = "DocumentVersionConflictError";
		}
	}
	class DocumentRegenerationReviewStaleErrorMock extends Error {
		constructor(readonly documentId: string) {
			super(`Document ${documentId} is no longer the reviewed one.`);
			this.name = "DocumentRegenerationReviewStaleError";
		}
	}
	return {
		inputSchema: { current: null as unknown },
		mockApplySideEffects: vi.fn(),
		DocumentGenerationInProgressErrorMock,
		DocumentVersionConflictErrorMock,
		DocumentRegenerationReviewStaleErrorMock,
	};
});

vi.mock("@repo/database", () => ({
	DocumentGenerationInProgressError: DocumentGenerationInProgressErrorMock,
	DocumentVersionConflictError: DocumentVersionConflictErrorMock,
	DocumentRegenerationReviewStaleError:
		DocumentRegenerationReviewStaleErrorMock,
	getDocumentById: vi.fn(),
	hasProjectAccess: vi.fn(),
	isProposalClientDocument: vi.fn(),
	rejectDocumentRegeneration: vi.fn(),
}));
vi.mock("../../../../../lib/document-side-effects", () => ({
	applyDocumentUpdateSideEffects: (...args: unknown[]) =>
		mockApplySideEffects(...args),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "output"]) {
		chain[m] = () => chain;
	}
	chain.input = (schema: unknown) => {
		inputSchema.current = schema;
		return chain;
	};
	chain.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: () => () => chain,
		resolveOrganizationId: (orgId: unknown) => orgId ?? undefined,
		Permissions: { DOCUMENT_UPDATE: "document:update" },
	};
});

import {
	getDocumentById,
	hasProjectAccess,
	isProposalClientDocument,
	rejectDocumentRegeneration,
} from "@repo/database";
import { contentIdentity } from "@repo/utils/content-identity";
import { rejectRegenerationProcedure } from "../reject-regeneration";

const handler = (
	rejectRegenerationProcedure as unknown as {
		handler: (opts: {
			input: {
				projectId: string;
				id: string;
				organizationId: string | null;
				expectedVersion: number;
				expectedContentHash?: string;
				expectedGenerationStartedAt?: string;
			};
			context: unknown;
		}) => Promise<{ document: { id: string; version: number } }>;
	}
).handler;

const ctx = {
	user: { id: "u1", name: "Alice", email: "dev@example.com" },
	session: {},
};
const input = {
	projectId: "p1",
	id: "doc-1",
	organizationId: "org-1",
	expectedVersion: 2,
	expectedContentHash: "hash-of-reviewed-body",
};
const REVERTED = { id: "doc-1", version: 1, content: "## Scope\n\nBefore." };
// The answer names the rewound body's identity beside its version: the
// editor stamps its room with it (Fizzy #2946).
const REVERTED_ANSWER = {
	...REVERTED,
	contentHash: contentIdentity(REVERTED.content),
};

const proposal = (status: string) => ({
	id: "doc-1",
	projectId: "p1",
	type: "PROPOSAL",
	title: "Proposal",
	status,
	project: { organizationId: "org-owner" },
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(hasProjectAccess).mockResolvedValue(true);
	vi.mocked(isProposalClientDocument).mockResolvedValue(false);
	vi.mocked(rejectDocumentRegeneration).mockResolvedValue(REVERTED);
	mockApplySideEffects.mockResolvedValue(undefined);
});

describe("rejectRegenerationProcedure", () => {
	// A Reject must name the regeneration it reviewed (Fizzy #2946): one
	// without it, from an editor bundle that predates the check, is refused
	// at the boundary rather than rewinding whatever is newest.
	it("requires the reviewed version in its input", () => {
		const schema = inputSchema.current as {
			safeParse: (value: unknown) => { success: boolean };
		};
		const { expectedVersion: _omitted, ...withoutVersion } = input;

		expect(schema.safeParse(input).success).toBe(true);
		expect(schema.safeParse(withoutVersion).success).toBe(false);
	});

	// A newer run can write the very same body, so the reviewed run's own
	// identity travels with the Reject and the rewind compares it.
	it("passes the reviewed run's identity to the rewind", async () => {
		vi.mocked(getDocumentById).mockResolvedValue(
			proposal("COMPLETE") as never,
		);
		const startedAt = "2026-10-01T09:30:00.000Z";
		const schema = inputSchema.current as {
			safeParse: (value: unknown) => { success: boolean };
		};
		expect(
			schema.safeParse({
				...input,
				expectedGenerationStartedAt: startedAt,
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({
				...input,
				expectedGenerationStartedAt: "yesterday",
			}).success,
		).toBe(false);

		await handler({
			input: { ...input, expectedGenerationStartedAt: startedAt },
			context: ctx,
		});

		expect(rejectDocumentRegeneration).toHaveBeenCalledWith("doc-1", {
			userId: "u1",
			organizationId: "org-1",
			expectedVersion: 2,
			expectedContentHash: "hash-of-reviewed-body",
			expectedGenerationStartedAt: new Date(startedAt),
		});
	});

	it("rewinds a document that is not a Proposal without the live-run guard", async () => {
		vi.mocked(getDocumentById).mockResolvedValue({
			...proposal("GENERATING"),
			type: "PRD",
		} as never);

		const result = await handler({ input, context: ctx });

		expect(rejectDocumentRegeneration).toHaveBeenCalledWith("doc-1", {
			userId: "u1",
			organizationId: "org-1",
			expectedVersion: 2,
			expectedContentHash: "hash-of-reviewed-body",
		});
		expect(result.document).toEqual(REVERTED_ANSWER);
	});

	it("keeps answering CONFLICT without a code when there is no prior version", async () => {
		vi.mocked(getDocumentById).mockResolvedValue(
			proposal("COMPLETE") as never,
		);
		vi.mocked(rejectDocumentRegeneration).mockRejectedValue(
			new Error("NO_PRIOR_VERSION"),
		);

		const error = await handler({ input, context: ctx }).catch(
			(caught: unknown) => caught,
		);

		expect(error).toMatchObject({ code: "CONFLICT" });
		expect(
			(error as { data?: { code?: string } }).data?.code,
		).toBeUndefined();
	});
});

describe("rejectRegenerationProcedure on a Proposal", () => {
	beforeEach(() => {
		vi.mocked(isProposalClientDocument).mockResolvedValue(true);
	});

	// The gate's state must not matter: a run already in progress keeps
	// writing after the Proposal gate is turned off.
	it.each([
		["QUEUED", true],
		["GENERATING", true],
		["QUEUED", false],
		["GENERATING", false],
	])(
		"refuses while the run is %s (Proposal gate on: %s), rewinding and re-embedding nothing",
		async (status, gateOn) => {
			vi.mocked(isProposalClientDocument).mockResolvedValue(gateOn);
			vi.mocked(getDocumentById).mockResolvedValue(
				proposal(status) as never,
			);

			await expect(
				handler({ input, context: ctx }),
			).rejects.toMatchObject({
				code: "CONFLICT",
				data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
			});
			expect(rejectDocumentRegeneration).not.toHaveBeenCalled();
			expect(mockApplySideEffects).not.toHaveBeenCalled();
		},
	);

	// The rewind refuses a run queued after this read on its own: the
	// query's default for a Proposal, with no option to pass.
	it("rewinds a finished Proposal, without consulting the Proposal gate", async () => {
		vi.mocked(getDocumentById).mockResolvedValue(
			proposal("COMPLETE") as never,
		);

		const result = await handler({ input, context: ctx });

		expect(isProposalClientDocument).not.toHaveBeenCalled();
		expect(rejectDocumentRegeneration).toHaveBeenCalledWith("doc-1", {
			userId: "u1",
			organizationId: "org-1",
			expectedVersion: 2,
			expectedContentHash: "hash-of-reviewed-body",
		});
		expect(result.document).toEqual(REVERTED_ANSWER);
		expect(mockApplySideEffects).toHaveBeenCalledTimes(1);
	});

	it("refuses when a run is queued between the read and the rewind", async () => {
		vi.mocked(getDocumentById).mockResolvedValue(
			proposal("COMPLETE") as never,
		);
		vi.mocked(rejectDocumentRegeneration).mockRejectedValue(
			new DocumentGenerationInProgressErrorMock("doc-1"),
		);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
		});
		expect(mockApplySideEffects).not.toHaveBeenCalled();
	});

	it("answers the stale-review code when a write lands between the read and the rewind", async () => {
		vi.mocked(getDocumentById).mockResolvedValue(
			proposal("COMPLETE") as never,
		);
		vi.mocked(rejectDocumentRegeneration).mockRejectedValue(
			new DocumentVersionConflictErrorMock("doc-1"),
		);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "REJECT_REVIEW_STALE" },
		});
		expect(mockApplySideEffects).not.toHaveBeenCalled();
	});

	// A review dialog left open while a newer run completed (Fizzy #2946):
	// its Reject must not rewind the newer run.
	it("refuses a Reject whose reviewed version the document has moved past, with a code distinct from no prior version", async () => {
		vi.mocked(getDocumentById).mockResolvedValue(
			proposal("COMPLETE") as never,
		);
		vi.mocked(rejectDocumentRegeneration).mockRejectedValue(
			new DocumentRegenerationReviewStaleErrorMock("doc-1"),
		);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "REJECT_REVIEW_STALE" },
		});
		expect(mockApplySideEffects).not.toHaveBeenCalled();
	});
});
