/**
 * QUEUED and GENERATING are generation-owned (Fizzy #2946).
 *
 * Generation dispatch writes either status together with the run's workflow
 * id and start time. A document an MCP caller puts in either status has
 * neither: the run guard then refuses every later write to it, and the
 * stale-generation watchdog, which needs those fields, can never move it on.
 * The tool enums leave both out, but nothing checks a call against its schema
 * before the handler runs, so `fabric_create_document` and
 * `fabric_update_document` refuse them themselves, for every document type.
 *
 * `@repo/database` is mocked the way platform-tool-write-permissions.test.ts
 * mocks it, because the handlers reach it through dynamic `await import(...)`.
 *
 * Run with: pnpm vitest run modules/saas/mcp/lib/gateway/__tests__/generation-owned-status.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveProjectAccess: vi.fn(),
	hasPermission: vi.fn(),
	createDocument: vi.fn(),
	updateDocument: vi.fn(),
	getDocumentById: vi.fn(),
	emitDocumentChange: vi.fn(),
	isProposalClientDocument: vi.fn(),
	getProjectAccessContext: vi.fn(),
}));

vi.mock("@repo/api/lib/realtime", () => ({
	emitDocumentChange: mocks.emitDocumentChange,
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({
	isProjectSoftDeleted: vi.fn().mockResolvedValue(false),
	resolveProjectAccess: mocks.resolveProjectAccess,
	hasPermission: mocks.hasPermission,
	Permissions: {
		PROJECT_UPDATE: "project:update",
		STORY_UPDATE: "story:update",
		CONTEXT_CREATE: "context:create",
		CONTEXT_UPDATE: "context:update",
	},
	createDocument: mocks.createDocument,
	updateDocument: mocks.updateDocument,
	getDocumentById: mocks.getDocumentById,
	isProposalClientDocument: mocks.isProposalClientDocument,
	getProjectAccessContext: mocks.getProjectAccessContext,
	IntegrationContractStatusManagedError: class extends Error {},
	DocumentVersionConflictError: class DocumentVersionConflictError extends Error {},
	DocumentGenerationInProgressError: class DocumentGenerationInProgressError extends Error {},
}));

import { executePlatformTool } from "../platform-tools";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org-1",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "personal-key",
	scopes: ["*"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

function storedDocument(type: string, status: string) {
	return {
		id: "doc-1",
		projectId: "proj-1",
		type,
		status,
		content: "# Proposal\n\nThe body.",
		version: 4,
	};
}

function errorText(result: { content: Array<{ text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolveProjectAccess.mockResolvedValue({
		organizationId: "org-1",
		source: "project-member",
		isVisible: true,
		permissions: ["project:update"],
	});
	mocks.hasPermission.mockImplementation(
		(permissions: string[], required: string) =>
			permissions.includes(required),
	);
	mocks.isProposalClientDocument.mockResolvedValue(false);
	mocks.createDocument.mockImplementation(
		async (data: { type: string; status: string }) => ({
			id: "doc-new",
			projectId: "proj-1",
			type: data.type,
			title: "Proposal",
			status: data.status,
			version: 1,
		}),
	);
	mocks.getDocumentById.mockResolvedValue(
		storedDocument("PROPOSAL", "COMPLETE"),
	);
	mocks.updateDocument.mockResolvedValue({
		id: "doc-1",
		title: "Proposal",
		status: "DRAFT",
		content: "# Proposal\n\nThe body.",
		version: 4,
	});
});

describe("fabric_create_document refuses a generation-owned status", () => {
	it.each([
		["PROPOSAL", "GENERATING"],
		["PROPOSAL", "QUEUED"],
		["PRD", "QUEUED"],
		["PRD", "GENERATING"],
	])(
		"refuses a %s created as %s and creates nothing",
		async (type, status) => {
			const result = await executePlatformTool(
				"fabric_create_document",
				{
					projectId: "proj-1",
					type,
					title: "Proposal",
					content: "# Proposal",
					status,
				},
				session,
			);

			expect(result.isError).toBe(true);
			expect(errorText(result)).toContain(
				"DOCUMENT_STATUS_GENERATION_OWNED",
			);
			expect(mocks.createDocument).not.toHaveBeenCalled();
		},
	);

	it.each(["DRAFT", "COMPLETE"])(
		"still creates a Proposal with status %s",
		async (status) => {
			const result = await executePlatformTool(
				"fabric_create_document",
				{
					projectId: "proj-1",
					type: "PROPOSAL",
					title: "Proposal",
					content: "# Proposal",
					status,
				},
				session,
			);

			expect(result.isError).toBeUndefined();
			expect(mocks.createDocument).toHaveBeenCalledWith(
				expect.objectContaining({ type: "PROPOSAL", status }),
			);
		},
	);
});

describe("fabric_update_document refuses a generation-owned status", () => {
	it.each([
		["PROPOSAL", "QUEUED"],
		["PROPOSAL", "GENERATING"],
		["PRD", "QUEUED"],
		["PRD", "GENERATING"],
	])(
		"refuses moving a COMPLETE %s to %s and writes nothing",
		async (type, status) => {
			mocks.getDocumentById.mockResolvedValue(
				storedDocument(type, "COMPLETE"),
			);

			const result = await executePlatformTool(
				"fabric_update_document",
				{ documentId: "doc-1", status },
				session,
			);

			expect(result.isError).toBe(true);
			expect(errorText(result)).toContain(
				"DOCUMENT_STATUS_GENERATION_OWNED",
			);
			expect(mocks.updateDocument).not.toHaveBeenCalled();
			expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
		},
	);

	it("still moves a COMPLETE Proposal back to DRAFT", async () => {
		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "doc-1", status: "DRAFT" },
			session,
		);

		expect(result.isError).toBeUndefined();
		expect(mocks.updateDocument).toHaveBeenCalledWith(
			"doc-1",
			expect.objectContaining({ status: "DRAFT" }),
		);
	});
});
