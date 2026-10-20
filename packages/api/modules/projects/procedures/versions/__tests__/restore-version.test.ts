/**
 * Tests for `restoreVersionProcedure`.
 *
 * A restore rewrites the document body on the server, so open editors must
 * hear about it: they refetch on `document_change`, and a collaborative room
 * holding the body the restore replaced brings itself to the restored one
 * instead of saving the older body back (Fizzy #2946). The response names the
 * restored body's identity beside its version, the base of the next save.
 *
 * A client-document Proposal's body belongs to its generation run while the
 * run is queued or writing, so a restore under it is refused, both from the
 * procedure's read and by the guarded write when a run is queued in between.
 *
 * Run with:
 *   pnpm --filter @repo/api exec vitest run modules/projects/procedures/versions/__tests__/restore-version.test.ts
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockEmitDocumentChange,
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
		mockEmitDocumentChange: vi.fn(),
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
	restoreDocumentVersion: vi.fn(),
}));
vi.mock("../../../../../lib/realtime", () => ({
	emitDocumentChange: (...args: unknown[]) => mockEmitDocumentChange(...args),
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
	restoreDocumentVersion,
} from "@repo/database";
import { restoreVersionProcedure } from "../restore-version";

const handler = (
	restoreVersionProcedure as unknown as {
		handler: (opts: {
			input: {
				projectId: string;
				documentId: string;
				versionNumber: number;
				organizationId: string | null;
			};
			context: unknown;
		}) => Promise<{
			document: { version: number; contentHash: string };
		}>;
	}
).handler;

const ctx = {
	user: { id: "u1", name: "Alice", email: "dev@example.com" },
	session: {},
};
const input = {
	projectId: "p1",
	documentId: "doc-1",
	versionNumber: 2,
	organizationId: "org-1",
};
const RESTORED_BODY = "## Scope\n\nThe body of version 2.";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(hasProjectAccess).mockResolvedValue(true);
	vi.mocked(getDocumentById).mockResolvedValue({
		id: "doc-1",
		projectId: "p1",
	} as never);
	vi.mocked(isProposalClientDocument).mockResolvedValue(false);
	vi.mocked(restoreDocumentVersion).mockResolvedValue({
		id: "doc-1",
		projectId: "p1",
		type: "PROPOSAL",
		title: "Proposal",
		content: RESTORED_BODY,
		version: 6,
		// The embed-owned column: a short hash of another body.
		contentHash: "0123456789abcdef",
	} as never);
	mockEmitDocumentChange.mockResolvedValue(undefined);
});

describe("restoreVersionProcedure", () => {
	it("emits document_change once after the restore", async () => {
		await handler({ input, context: ctx });

		expect(mockEmitDocumentChange).toHaveBeenCalledTimes(1);
		expect(mockEmitDocumentChange).toHaveBeenCalledWith({
			projectId: "p1",
			documentId: "doc-1",
			action: "updated",
			userId: "u1",
			userName: "Alice",
			documentType: "PROPOSAL",
			documentTitle: "Proposal",
		});
	});

	it("returns the restored body's identity beside its version", async () => {
		const result = await handler({ input, context: ctx });

		expect(result.document.version).toBe(6);
		expect(result.document.contentHash).toBe(
			createHash("sha256").update(RESTORED_BODY, "utf8").digest("hex"),
		);
	});

	it("emits nothing when the restore fails", async () => {
		vi.mocked(restoreDocumentVersion).mockRejectedValue(
			new Error("Version not found"),
		);

		await expect(handler({ input, context: ctx })).rejects.toThrow(
			"Version not found",
		);
		expect(mockEmitDocumentChange).not.toHaveBeenCalled();
	});

	it("refuses a document from another project before restoring or emitting", async () => {
		vi.mocked(getDocumentById).mockResolvedValue({
			id: "doc-1",
			projectId: "p-other",
		} as never);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(restoreDocumentVersion).not.toHaveBeenCalled();
		expect(mockEmitDocumentChange).not.toHaveBeenCalled();
	});

	it("restores a document that is not a Proposal without the live-run guard", async () => {
		vi.mocked(getDocumentById).mockResolvedValue({
			id: "doc-1",
			projectId: "p1",
			type: "PRD",
			status: "GENERATING",
			project: { organizationId: "org-1" },
		} as never);

		await handler({ input, context: ctx });

		expect(restoreDocumentVersion).toHaveBeenCalledWith(
			"doc-1",
			2,
			"u1",
			{ userId: "u1", organizationId: "org-1" },
			{},
		);
	});
});

describe("restoreVersionProcedure on a Proposal", () => {
	const proposal = (status: string) => ({
		id: "doc-1",
		projectId: "p1",
		type: "PROPOSAL",
		status,
		project: { organizationId: "org-owner" },
	});

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
		"refuses a restore while the run is %s (Proposal gate on: %s), writing and emitting nothing",
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
			expect(restoreDocumentVersion).not.toHaveBeenCalled();
			expect(mockEmitDocumentChange).not.toHaveBeenCalled();
		},
	);

	it("guards a finished Proposal's restore with the Proposal gate off, without consulting it", async () => {
		vi.mocked(isProposalClientDocument).mockResolvedValue(false);
		vi.mocked(getDocumentById).mockResolvedValue(
			proposal("COMPLETE") as never,
		);

		await handler({ input, context: ctx });

		expect(isProposalClientDocument).not.toHaveBeenCalled();
		expect(restoreDocumentVersion).toHaveBeenCalledWith(
			"doc-1",
			2,
			"u1",
			{ userId: "u1", organizationId: "org-1" },
			{ refuseWhileGenerating: true },
		);
	});

	it("restores a finished Proposal through the guarded write", async () => {
		vi.mocked(getDocumentById).mockResolvedValue(
			proposal("COMPLETE") as never,
		);

		await handler({ input, context: ctx });

		expect(restoreDocumentVersion).toHaveBeenCalledWith(
			"doc-1",
			2,
			"u1",
			{ userId: "u1", organizationId: "org-1" },
			{ refuseWhileGenerating: true },
		);
		expect(mockEmitDocumentChange).toHaveBeenCalledTimes(1);
	});

	it("refuses a restore when a run is queued between the read and the write", async () => {
		vi.mocked(getDocumentById).mockResolvedValue(
			proposal("COMPLETE") as never,
		);
		vi.mocked(restoreDocumentVersion).mockRejectedValue(
			new DocumentGenerationInProgressErrorMock("doc-1"),
		);

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "DOCUMENT_GENERATION_IN_PROGRESS" },
		});
		expect(mockEmitDocumentChange).not.toHaveBeenCalled();
	});

	it("answers CONFLICT when a save lands between the read and the guarded write", async () => {
		vi.mocked(getDocumentById).mockResolvedValue(
			proposal("COMPLETE") as never,
		);
		vi.mocked(restoreDocumentVersion).mockRejectedValue(
			new DocumentVersionConflictErrorMock("doc-1"),
		);

		const error = await handler({ input, context: ctx }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toMatchObject({ code: "CONFLICT" });
		expect(
			(error as { data?: { code?: string } }).data?.code,
		).toBeUndefined();
		expect(mockEmitDocumentChange).not.toHaveBeenCalled();
	});
});
