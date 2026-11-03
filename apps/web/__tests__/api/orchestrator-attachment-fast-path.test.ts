import {
	applyAiChatTextBudget,
	buildAiChatAttachmentEntry,
} from "@repo/utils/ai-chat-attachment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const getAIModelWithMetadataMock = vi.fn();
const getTemporalClientMock = vi.fn();
const getHandleMock = vi.fn();
const startWorkflowMock = vi.fn();
const mintActingGrantForTurnMock = vi.fn(() => "grant-token-example");
const aiChatFindFirstMock = vi.fn();
const chatDocumentFindManyMock = vi.fn();

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => getSessionMock(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...args: unknown[]) =>
		getAIModelWithMetadataMock(...args),
}));

vi.mock("@repo/agent-core/backend", () => ({
	getDefaultEnabledMcpConfigIds: vi.fn(async () => []),
}));

vi.mock("@repo/api/lib/agent-service-auth", () => ({
	mintActingGrantForTurn: (...args: unknown[]) =>
		mintActingGrantForTurnMock(...args),
}));

vi.mock("@repo/observability", () => ({
	metricsTracker: { trackAiLimitSignal: vi.fn() },
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: () => getTemporalClientMock(),
}));

vi.mock("@repo/database", async () => ({
	...(
		await import("./_helpers/conversation-turn-db-mocks")
	).conversationTurnDbMocks(),
	CARRIED_OVER_MARKER_PREFIX: "[carried-over]",
	db: {
		agentConversation: { findFirst: vi.fn(async () => null) },
		member: { findFirst: vi.fn(async () => ({ id: "member-1" })) },
		aiChat: {
			findFirst: (...args: unknown[]) => aiChatFindFirstMock(...args),
		},
		chatDocument: {
			findMany: (...args: unknown[]) => chatDocumentFindManyMock(...args),
		},
	},
	getConversationWorkspaces: vi.fn(async () => []),
	getConversationProject: vi.fn(async () => null),
	hasProjectAccess: vi.fn(async () => true),
}));

const SESSION_USER_ID = "user-attachment-1";
const ORG_ID = "org-example-1";
const EXECUTION_ID = "orch-11111111-2222-4333-8444-555555555555";

function postBody(body: Record<string, unknown>) {
	return {
		json: async () => body,
	} as never;
}

describe("Orchestrator attachment fast path & reattach ordering", () => {
	const originalCacheHost = process.env.CACHE_HOST;
	const originalRedisUrl = process.env.REDIS_URL;

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.CACHE_HOST;
		delete process.env.REDIS_URL;

		getSessionMock.mockResolvedValue({
			user: { id: SESSION_USER_ID, email: "dev@example.com" },
			session: { activeOrganizationId: ORG_ID },
		});
		getAIModelWithMetadataMock.mockResolvedValue({
			trackUsage: vi.fn(),
		});

		aiChatFindFirstMock.mockResolvedValue({
			id: "chat-example-1",
			organizationId: ORG_ID,
		});
		chatDocumentFindManyMock.mockResolvedValue([
			{
				id: "doc-example-1",
				mimeType: "application/pdf",
			},
		]);

		getHandleMock.mockReturnValue({
			workflowId: EXECUTION_ID,
			describe: async () => ({
				status: { name: "COMPLETED" },
				memo: { userId: SESSION_USER_ID, organizationId: ORG_ID },
			}),
			query: async () => {
				throw new Error("workflow closed");
			},
			result: async () => ({
				status: "completed",
				response: "Grounded answer",
				toolCalls: [],
				totalDurationMs: 1,
			}),
		});

		startWorkflowMock.mockImplementation(async (workflowName: string) => {
			if (workflowName === "ragContextRetrievalWorkflow") {
				return {
					workflowId: "rag-1",
					result: async () => ({
						success: true,
						context: "Retrieved RAG chunk text",
					}),
				};
			}
			return {
				workflowId: EXECUTION_ID,
				describe: async () => ({
					status: { name: "COMPLETED" },
					memo: { userId: SESSION_USER_ID, organizationId: ORG_ID },
				}),
				query: async () => {
					throw new Error("workflow closed");
				},
				result: async () => ({
					status: "completed",
					response: "Grounded answer",
					toolCalls: [],
					totalDurationMs: 1,
				}),
			};
		});

		getTemporalClientMock.mockResolvedValue({
			workflow: {
				getHandle: (...args: unknown[]) => getHandleMock(...args),
				start: (...args: unknown[]) => startWorkflowMock(...args),
			},
		});
	});

	afterEach(() => {
		if (originalCacheHost !== undefined) {
			process.env.CACHE_HOST = originalCacheHost;
		}
		if (originalRedisUrl !== undefined) {
			process.env.REDIS_URL = originalRedisUrl;
		}
	});

	it("skips ragContextRetrievalWorkflow when inline extraction covers all non-image attachments and separates rawUserMessage", async () => {
		const {
			buildOrchestratorWorkflowInput,
			resolveOrchestratorTurnRequest,
		} = await import(
			"@/app/api/agents/fabric-ai/orchestrator-temporal/orchestrator-turn"
		);

		const inlineDoc = buildAiChatAttachmentEntry(
			"statement-of-work.pdf",
			"Deliverable 1: API Design due November 15.",
		);

		const resolved = await resolveOrchestratorTurnRequest({
			session: {
				user: { id: SESSION_USER_ID, email: "dev@example.com" },
				session: { activeOrganizationId: ORG_ID },
			} as never,
			body: {
				message: "what does this document say?",
				chatId: "chat-example-1",
				attachedDocumentIds: ["doc-example-1"],
				inlineAttachmentContexts: [inlineDoc],
				surface: "loom-orchestrator",
			},
		});
		expect(resolved instanceof Response).toBe(false);
		if (resolved instanceof Response) {
			return;
		}

		const temporalClient = await getTemporalClientMock();
		const workflowInput = await buildOrchestratorWorkflowInput({
			request: resolved,
			workspaceIds: [],
			executionId: EXECUTION_ID,
			temporalClient,
		});

		expect(startWorkflowMock).not.toHaveBeenCalledWith(
			"ragContextRetrievalWorkflow",
			expect.anything(),
		);
		expect(workflowInput.rawUserMessage).toBe(
			"what does this document say?",
		);
		expect(workflowInput.hasCompleteInlineAttachments).toBe(true);
		expect(workflowInput.attachmentManifest).toEqual([
			{ name: "statement-of-work.pdf", status: "extracted" },
		]);
		expect(workflowInput.message).toContain("## Files Attached This Turn");
		expect(workflowInput.message).toContain("statement-of-work.pdf");
		expect(workflowInput.message).toContain(
			"Deliverable 1: API Design due November 15.",
		);
	});

	it("runs ragContextRetrievalWorkflow with rawUserMessage when inline text is truncated", async () => {
		const {
			buildOrchestratorWorkflowInput,
			resolveOrchestratorTurnRequest,
		} = await import(
			"@/app/api/agents/fabric-ai/orchestrator-temporal/orchestrator-turn"
		);

		const truncated = applyAiChatTextBudget("x".repeat(4_000), 1_000);
		const inlineDoc = buildAiChatAttachmentEntry(
			"large-spec.pdf",
			truncated.text,
		);

		const resolved = await resolveOrchestratorTurnRequest({
			session: {
				user: { id: SESSION_USER_ID, email: "dev@example.com" },
				session: { activeOrganizationId: ORG_ID },
			} as never,
			body: {
				message: "find the appendix SLA target",
				chatId: "chat-example-1",
				attachedDocumentIds: ["doc-example-1"],
				inlineAttachmentContexts: [inlineDoc],
				surface: "loom-orchestrator",
			},
		});
		expect(resolved instanceof Response).toBe(false);
		if (resolved instanceof Response) {
			return;
		}

		const temporalClient = await getTemporalClientMock();
		const workflowInput = await buildOrchestratorWorkflowInput({
			request: resolved,
			workspaceIds: [],
			executionId: EXECUTION_ID,
			temporalClient,
		});

		expect(startWorkflowMock).toHaveBeenCalledWith(
			"ragContextRetrievalWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						query: "find the appendix SLA target",
						documentIds: ["doc-example-1"],
					}),
				],
			}),
		);
		expect(workflowInput.hasCompleteInlineAttachments).toBeUndefined();
		expect(workflowInput.attachmentManifest).toEqual([
			{ name: "large-spec.pdf", status: "truncated" },
		]);
		expect(workflowInput.message).toContain("Retrieved RAG chunk text");
	});

	it("does not run RAG or mint acting grants when reattaching to an existing executionId", async () => {
		const { POST } = await import(
			"@/app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
		);

		const response = await POST(
			postBody({
				executionId: EXECUTION_ID,
				message: "what does this document say?",
				chatId: "chat-example-1",
				attachedDocumentIds: ["doc-example-1"],
			}),
		);

		expect(response.status).toBe(200);
		await response.text();
		expect(startWorkflowMock).not.toHaveBeenCalled();
		expect(mintActingGrantForTurnMock).not.toHaveBeenCalled();
	});
});
