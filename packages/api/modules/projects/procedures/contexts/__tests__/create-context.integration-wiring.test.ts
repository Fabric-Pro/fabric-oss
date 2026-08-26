/**
 * Regression tests for the metadata-only INTEGRATION wiring (PR after #1298).
 *
 * Before this fix: empty-content INTEGRATION rows (Teams chat, Teams channel,
 * Slack channel) sat on the default `PENDING` extraction status forever and
 * the chat/channel messages never actually flowed into the project's RAG
 * store — the row existed only as a visible card in the context list. A
 * prior PR flipped the pill to `COMPLETED` without ever creating the
 * `ProjectLinkedTeams*Chat` / `ProjectLinkedSlackChannel` row the monitor
 * workflows read from, so the "Ready" pill was a lie.
 *
 * After this fix: `createContextProcedure` calls the matching `linkXxx`
 * helper to insert the linked-row, then flips status to `COMPLETED` on
 * success (or `FAILED` with `extractionError` on linking errors). The
 * wizard's `createIntegrationContexts` is what finally calls `enable*Monitor`
 * to start the workflow polling, but that lives in a different file — these
 * tests cover the per-row linking contract that has to happen at create time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockCreateContext,
	mockUpdateContextExtractionStatus,
	mockCountContextsByType,
	mockLinkTeamsChat,
	mockLinkTeamsChannel,
	mockLinkSlackChannel,
	mockTemporalStart,
	mockGetTemporalClient,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockCreateContext: vi.fn(),
	mockUpdateContextExtractionStatus: vi.fn(),
	mockCountContextsByType: vi.fn(),
	mockLinkTeamsChat: vi.fn(),
	mockLinkTeamsChannel: vi.fn(),
	mockLinkSlackChannel: vi.fn(),
	mockTemporalStart: vi.fn(),
	mockGetTemporalClient: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectDocument: { findFirst: vi.fn(), create: vi.fn() },
		documentVersion: { create: vi.fn() },
	},
	hasProjectAccess: mockHasProjectAccess,
	createContext: mockCreateContext,
	updateContextExtractionStatus: mockUpdateContextExtractionStatus,
	countContextsByType: mockCountContextsByType,
	linkTeamsChatToProject: mockLinkTeamsChat,
	linkTeamsChannelToProject: mockLinkTeamsChannel,
	linkSlackChannelToProject: mockLinkSlackChannel,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mockGetTemporalClient,
}));

vi.mock("../../../../../lib/realtime", () => ({
	emitActivity: vi.fn(),
	emitContextChange: vi.fn(),
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(x: T) => x,
}));

vi.mock("@repo/database/prisma/zod", () => ({
	ProjectContextTypeSchema: { parse: <T>(v: T) => v },
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => {
			if (input) {
				return input;
			}
			if (input === null) {
				return undefined;
			}
			return session?.activeOrganizationId ?? undefined;
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: {
		projectId: string;
		type: string;
		content: string;
		metadata?: Record<string, unknown>;
		organizationId?: string | null;
	};
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../create-context");
	return (mod.createContextProcedure as unknown as { handler: Handler })
		.handler;
}

const personalCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: undefined },
};

const orgCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockCountContextsByType.mockResolvedValue({});
	mockCreateContext.mockResolvedValue({
		id: "ctx-new",
		projectId: "proj-1",
		type: "INTEGRATION",
		extractionStatus: "PENDING",
		content: "",
		metadata: {},
	});
	mockUpdateContextExtractionStatus.mockResolvedValue({ id: "ctx-new" });
	mockLinkTeamsChat.mockResolvedValue({ id: "linked-chat-1" });
	mockLinkTeamsChannel.mockResolvedValue({ id: "linked-channel-1" });
	mockLinkSlackChannel.mockResolvedValue({ id: "linked-slack-1" });
	mockGetTemporalClient.mockResolvedValue({
		workflow: { start: mockTemporalStart },
	});
});

describe("createContextProcedure — INTEGRATION linking (Teams group chat)", () => {
	it("links the chat into ProjectLinkedTeamsChat then marks COMPLETED", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "proj-1",
				type: "INTEGRATION",
				content: "",
				metadata: {
					provider: "MICROSOFT_TEAMS",
					chatType: "group",
					chatId: "19:abc@thread.skype",
					chatTopic: "AI R&D",
					mcpConfigId: "mcp-1",
				},
			},
			context: personalCtx,
		});

		expect(mockLinkTeamsChat).toHaveBeenCalledTimes(1);
		expect(mockLinkTeamsChat).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				chatId: "19:abc@thread.skype",
				chatTopic: "AI R&D",
				backfillMode: "from-now",
				userId: "user-1",
			}),
		);
		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-new",
			"COMPLETED",
		);
		expect(mockTemporalStart).not.toHaveBeenCalled();
	});

	it("marks the context FAILED with extractionError when linkChat throws", async () => {
		mockLinkTeamsChat.mockRejectedValueOnce(
			new Error("MS Graph 403 forbidden"),
		);
		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "proj-1",
				type: "INTEGRATION",
				content: "",
				metadata: {
					provider: "MICROSOFT_TEAMS",
					chatType: "group",
					chatId: "19:def@thread.skype",
				},
			},
			context: personalCtx,
		});
		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-new",
			"FAILED",
			expect.objectContaining({
				extractionError: expect.stringContaining(
					"MS Graph 403 forbidden",
				),
			}),
		);
	});

	it("passes through organizationId for org-context linking", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "proj-1",
				organizationId: "org-1",
				type: "INTEGRATION",
				content: "",
				metadata: {
					provider: "MICROSOFT_TEAMS",
					chatType: "group",
					chatId: "19:xyz@thread.skype",
				},
			},
			context: orgCtx,
		});
		expect(mockLinkTeamsChat).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				userId: "user-1",
			}),
		);
	});
});

describe("createContextProcedure — INTEGRATION linking (Teams channel)", () => {
	it("links the channel via linkTeamsChannelToProject then marks COMPLETED", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "proj-1",
				type: "INTEGRATION",
				content: "",
				metadata: {
					provider: "MICROSOFT_TEAMS",
					chatType: "channel",
					teamId: "team-uuid",
					channelId: "channel-uuid",
					teamName: "Fabric Action Team",
					channelName: "fabric-test-reqs-channel",
				},
			},
			context: personalCtx,
		});
		expect(mockLinkTeamsChannel).toHaveBeenCalledWith(
			expect.objectContaining({
				teamId: "team-uuid",
				channelId: "channel-uuid",
				teamName: "Fabric Action Team",
				channelName: "fabric-test-reqs-channel",
				backfillMode: "from-now",
			}),
		);
		expect(mockLinkTeamsChat).not.toHaveBeenCalled();
		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-new",
			"COMPLETED",
		);
	});
});

describe("createContextProcedure — Slack INTENTIONALLY not linked server-side", () => {
	it("does NOT call linkSlackChannelToProject server-side (handled client-side by the wizard)", async () => {
		// `linkSlackChannelToProject` requires `slackTeamId` which the
		// wizard's Slack picker doesn't surface. The wizard's
		// `createIntegrationContexts` calls the `slackChannelMonitor.linkChannel`
		// oRPC procedure instead — which resolves slackTeamId via
		// Slack `auth.test`. So this procedure leaves Slack rows alone:
		// the context row is created PENDING, and the client-side link +
		// enable calls handle the actual ingest wiring.
		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "proj-1",
				type: "INTEGRATION",
				content: "",
				metadata: {
					provider: "SLACK",
					channelId: "C12345",
					channelName: "general",
					mcpConfigId: "mcp-2",
				},
			},
			context: personalCtx,
		});
		expect(mockLinkSlackChannel).not.toHaveBeenCalled();
		expect(mockLinkTeamsChat).not.toHaveBeenCalled();
		expect(mockLinkTeamsChannel).not.toHaveBeenCalled();
		// Status stays PENDING (the wizard client-side flow will mark
		// it COMPLETED via a follow-up procedure when one is added).
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
	});
});

describe("createContextProcedure — INTEGRATION rows we don't link", () => {
	it("leaves CONFLUENCE rows PENDING (no monitor exists yet)", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "proj-1",
				type: "INTEGRATION",
				content: "",
				metadata: {
					provider: "CONFLUENCE",
					pageId: "p-1",
					sourceTitle: "Some page",
				},
			},
			context: personalCtx,
		});
		expect(mockLinkTeamsChat).not.toHaveBeenCalled();
		expect(mockLinkTeamsChannel).not.toHaveBeenCalled();
		expect(mockLinkSlackChannel).not.toHaveBeenCalled();
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
	});

	it("leaves backlog (BACKLOG provider, kind:backlog) PENDING — has its own ingest flow", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "proj-1",
				type: "INTEGRATION",
				content: "",
				metadata: {
					provider: "AZURE_DEVOPS",
					kind: "backlog",
					containerId: "Sandbox",
				},
			},
			context: personalCtx,
		});
		expect(mockLinkTeamsChat).not.toHaveBeenCalled();
		expect(mockLinkTeamsChannel).not.toHaveBeenCalled();
		expect(mockLinkSlackChannel).not.toHaveBeenCalled();
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
	});

	it("INTEGRATION row with content (Notion page body) skips linking, takes embedding-workflow path", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "proj-1",
				type: "INTEGRATION",
				content: "# Notion page body\n\nReal fetched content.",
				metadata: { provider: "notion", notionPageId: "p-1" },
			},
			context: personalCtx,
		});
		expect(mockLinkTeamsChat).not.toHaveBeenCalled();
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
		expect(mockTemporalStart).toHaveBeenCalledTimes(1);
		expect(mockTemporalStart).toHaveBeenCalledWith(
			"contextEmbeddingWorkflow",
			expect.objectContaining({
				args: expect.arrayContaining([
					expect.objectContaining({ contextId: "ctx-new" }),
				]),
			}),
		);
	});
});

describe("createContextProcedure — non-INTEGRATION types untouched", () => {
	it("LINK type bypasses all linking + status flips here", async () => {
		mockCreateContext.mockResolvedValueOnce({
			id: "ctx-link",
			projectId: "proj-1",
			type: "LINK",
			extractionStatus: "PENDING",
			content: "",
		});
		const handler = await loadHandler();
		await handler({
			input: {
				projectId: "proj-1",
				type: "LINK",
				content: "",
				metadata: { sourceUrl: "https://example.com" },
			},
			context: personalCtx,
		});
		expect(mockLinkTeamsChat).not.toHaveBeenCalled();
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
	});
});
