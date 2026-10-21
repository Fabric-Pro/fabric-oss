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
	mockApplySideEffects,
	DocumentGenerationInProgressErrorMock,
	DocumentVersionConflictErrorMock,
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
	return {
		mockApplySideEffects: vi.fn(),
		DocumentGenerationInProgressErrorMock,
		DocumentVersionConflictErrorMock,
	};
});

vi.mock("@repo/database", () => ({
	DocumentGenerationInProgressError: DocumentGenerationInProgressErrorMock,
	DocumentVersionConflictError: DocumentVersionConflictErrorMock,
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
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
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
import { rejectRegenerationProcedure } from "../reject-regeneration";

const handler = (
	rejectRegenerationProcedure as unknown as {
		handler: (opts: {
			input: {
				projectId: string;
				id: string;
				organizationId: string | null;
			};
			context: unknown;
		}) => Promise<{ document: { id: string; version: number } }>;
	}
).handler;

const ctx = {
	user: { id: "u1", name: "Alice", email: "dev@example.com" },
	session: {},
};
const input = { projectId: "p1", id: "doc-1", organizationId: "org-1" };
const REVERTED = { id: "doc-1", version: 1, content: "## Scope\n\nBefore." };

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
	it("rewinds a document that is not a Proposal without the live-run guard", async () => {
		vi.mocked(getDocumentById).mockResolvedValue({
			...proposal("GENERATING"),
			type: "PRD",
		} as never);

		const result = await handler({ input, context: ctx });

		expect(rejectDocumentRegeneration).toHaveBeenCalledWith("doc-1", {
			userId: "u1",
			organizationId: "org-1",
		});
		expect(result.document).toEqual(REVERTED);
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
		});
		expect(result.document).toEqual(REVERTED);
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

	it("answers CONFLICT when a write lands between the read and the rewind", async () => {
		vi.mocked(getDocumentById).mockResolvedValue(
			proposal("COMPLETE") as never,
		);
		vi.mocked(rejectDocumentRegeneration).mockRejectedValue(
			new DocumentVersionConflictErrorMock("doc-1"),
		);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mockApplySideEffects).not.toHaveBeenCalled();
	});
});
