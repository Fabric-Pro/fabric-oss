/**
 * Document Status Update Activity Tests
 *
 * Tests to ensure document status updates properly throw errors
 * instead of silently swallowing them (which caused RAG to appear stuck).
 *
 * Run with: pnpm --filter @repo/temporal test
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the database module - must use factory with no external references
vi.mock("@repo/database", () => ({
	db: {
		chatDocument: {
			update: vi.fn(),
		},
		workspaceDocument: {
			update: vi.fn(),
		},
	},
	updateWorkspaceDocument: vi.fn(),
	// Registry hook called by @repo/payments at module init.
	setAiUsageRecorder: vi.fn(),
	// Provider constants needed by @repo/ai gateway-config.ts at import time
	GATEWAY_PROVIDERS: [
		"VERCEL_GATEWAY",
		"OPENROUTER",
		"CLOUDFLARE_AI",
	] as const,
	DIRECT_PROVIDERS: ["OPENAI_DIRECT", "ANTHROPIC_DIRECT", "GROQ"] as const,
	AI_PROVIDER_METADATA: {},
	isGatewayProvider: () => false,
	isDirectProvider: () => false,
	getProviderDisplayName: (p: string) => p,
	getProviderMetadata: () => undefined,
}));

// Import after mocking
import { db, updateWorkspaceDocument } from "@repo/database";
import { updateDocumentStatus } from "../src/activities/document-processing";
import { updateWorkspaceDocumentStatus } from "../src/activities/workspace-document-activities";

// Get mocked functions for assertions
const mockChatDocumentUpdate = vi.mocked(db.chatDocument.update);
const mockWorkspaceDocumentUpdate = vi.mocked(updateWorkspaceDocument);

describe("Document Status Update Activities", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("updateDocumentStatus (chat documents)", () => {
		it("should successfully update document status", async () => {
			// Mock returns partial data (full type not needed for this test)
			mockChatDocumentUpdate.mockResolvedValueOnce({
				id: "test-doc-id",
				status: "READY",
			} as never);

			await expect(
				updateDocumentStatus("test-doc-id", "READY", "COMPLETED"),
			).resolves.toBeUndefined();

			expect(mockChatDocumentUpdate).toHaveBeenCalledWith({
				where: { id: "test-doc-id" },
				data: expect.objectContaining({
					status: "READY",
					workflowStatus: "COMPLETED",
				}),
			});
		});

		it("should THROW error when database update fails", async () => {
			mockChatDocumentUpdate.mockRejectedValueOnce(
				new Error("Database connection failed"),
			);

			// This is the critical behavior - errors must be thrown, not swallowed
			await expect(
				updateDocumentStatus("test-doc-id", "READY", "COMPLETED"),
			).rejects.toThrow(
				"Failed to update document test-doc-id status to READY",
			);
		});

		it("should include original error message in thrown error", async () => {
			mockChatDocumentUpdate.mockRejectedValueOnce(
				new Error("Record not found"),
			);

			await expect(
				updateDocumentStatus("test-doc-id", "READY", "COMPLETED"),
			).rejects.toThrow("Record not found");
		});
	});

	describe("updateWorkspaceDocumentStatus (workspace documents)", () => {
		it("should successfully update workspace document status", async () => {
			// Mock returns partial data (full type not needed for this test)
			mockWorkspaceDocumentUpdate.mockResolvedValueOnce({
				id: "test-ws-doc-id",
				status: "READY",
			} as never);

			await expect(
				updateWorkspaceDocumentStatus("test-ws-doc-id", "READY"),
			).resolves.toBeUndefined();

			expect(mockWorkspaceDocumentUpdate).toHaveBeenCalledWith(
				"test-ws-doc-id",
				expect.objectContaining({
					status: "READY",
				}),
			);
		});

		it("should THROW error when database update fails", async () => {
			mockWorkspaceDocumentUpdate.mockRejectedValueOnce(
				new Error("Database connection failed"),
			);

			// This is the critical behavior - errors must be thrown, not swallowed
			await expect(
				updateWorkspaceDocumentStatus("test-ws-doc-id", "READY"),
			).rejects.toThrow(
				"Failed to update workspace document test-ws-doc-id status to READY",
			);
		});

		it("should include original error message in thrown error", async () => {
			mockWorkspaceDocumentUpdate.mockRejectedValueOnce(
				new Error("Unique constraint violation"),
			);

			await expect(
				updateWorkspaceDocumentStatus("test-ws-doc-id", "EXTRACTING"),
			).rejects.toThrow("Unique constraint violation");
		});
	});
});
