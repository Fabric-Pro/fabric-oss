/**
 * Fizzy #2527: `addMessageToChat` injects RAG context by `unshift`-ing a
 * `role: "system"` UIMessage onto `messages` (both the pending-documents
 * workflow branch and the inline-retrieval branch), then handed the whole
 * array — system rows and all — to `streamText` with no `system` option.
 * `ai` 6.0.170+ warns on a `role: "system"` row inside `messages`, and AI SDK
 * 7 will reject the call outright.
 *
 * These tests pin the fix: any system-role row present in `messages` when
 * `streamText` is called is collected into the `system` option (joined with
 * a blank line, in array order) and stripped from `messages`, and the
 * non-RAG path is unchanged (no `system` option, `messages` untouched).
 *
 * The oRPC procedure base is stubbed so the handler can be invoked directly,
 * following the pattern in
 * packages/api/modules/projects/procedures/stories/__tests__/generate-tasks.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		getAiChatByIdForOwner: vi.fn(),
		getChatDocumentsByChatIdForOwner: vi.fn(),
		hasPendingDocuments: vi.fn(),
		hasReadyDocuments: vi.fn(),
		updateAiChat: vi.fn(),
		convertToModelMessages: vi.fn(),
		generateChatTitle: vi.fn(),
		getAggressiveStreamingConfig: vi.fn(),
		getAIModelWithMetadata: vi.fn(),
		getRAGProviderConfig: vi.fn(),
		logModelUsageAsync: vi.fn(),
		streamText: vi.fn(),
		toUIMessageStream: vi.fn(),
		formatContextForLLM: vi.fn(),
		retrieveContext: vi.fn(),
		getTemporalClient: vi.fn(),
		verifyOrganizationMembership: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@orpc/client", () => ({
	ORPCError: class extends Error {
		code: string;
		constructor(code: string, opts?: { message?: string }) {
			super(opts?.message ?? code);
			this.code = code;
		}
	},
	streamToEventIterator: vi.fn((x: unknown) => x),
}));

vi.mock("@repo/ai", () => ({
	convertToModelMessages: mocks.convertToModelMessages,
	generateChatTitle: mocks.generateChatTitle,
	getAggressiveStreamingConfig: mocks.getAggressiveStreamingConfig,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	getRAGProviderConfig: mocks.getRAGProviderConfig,
	logModelUsageAsync: mocks.logModelUsageAsync,
	streamText: mocks.streamText,
	toUIMessageStream: mocks.toUIMessageStream,
}));

vi.mock("@repo/database", () => ({
	getAiChatByIdForOwner: mocks.getAiChatByIdForOwner,
	getChatDocumentsByChatIdForOwner: mocks.getChatDocumentsByChatIdForOwner,
	hasPendingDocuments: mocks.hasPendingDocuments,
	hasReadyDocuments: mocks.hasReadyDocuments,
	updateAiChat: mocks.updateAiChat,
}));

vi.mock("@repo/rag", () => ({
	formatContextForLLM: mocks.formatContextForLLM,
	retrieveContext: mocks.retrieveContext,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (x: unknown) => x,
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.verifyOrganizationMembership,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.addMessage = fn;
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
		requirePermission: () => (c: unknown) => c,
	};
});

await import("../add-message-to-chat");

const ctx = { user: { id: "user-1" } };

function userMessage(id: string, text: string) {
	return { id, role: "user" as const, parts: [{ type: "text", text }] };
}

function systemMessage(id: string, text: string) {
	return { id, role: "system" as const, parts: [{ type: "text", text }] };
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}

	mocks.getAiChatByIdForOwner.mockResolvedValue({
		id: "chat-1",
		organizationId: null,
		projectId: null,
		title: "Existing chat title",
	});
	mocks.getChatDocumentsByChatIdForOwner.mockResolvedValue([]);
	mocks.hasPendingDocuments.mockResolvedValue(false);
	mocks.hasReadyDocuments.mockResolvedValue(false);
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: { __mockModel: true },
		metadata: { modelString: "test-model", selectionSource: "default" },
		trackUsage: vi.fn(),
	});
	mocks.getAggressiveStreamingConfig.mockReturnValue({ aiConfig: {} });
	// Identity pass-through: lets assertions inspect exactly what streamText
	// received for `messages`.
	mocks.convertToModelMessages.mockImplementation(
		async (msgs: unknown) => msgs,
	);
	// AI SDK 7: the handler reads `result.stream` and pipes it through the
	// stateless `toUIMessageStream({ stream })` helper rather than calling the
	// deprecated `result.toUIMessageStream()` method.
	mocks.streamText.mockReturnValue({ stream: {} });
	mocks.toUIMessageStream.mockImplementation(
		({ stream }: { stream: unknown }) => stream,
	);
});

describe("addMessageToChat — non-RAG path is unchanged", () => {
	it("passes no `system` option and leaves `messages` untouched when there is no RAG context", async () => {
		const messages = [userMessage("m1", "Hello there")];

		await handlers.addMessage({
			input: { chatId: "chat-1", messages },
			context: ctx,
		});

		expect(mocks.streamText).toHaveBeenCalledTimes(1);
		const callArgs = mocks.streamText.mock.calls[0][0] as {
			instructions?: unknown;
			messages: unknown[];
		};
		expect(callArgs.instructions).toBeUndefined();
		expect(callArgs.messages).toEqual(messages);
	});
});

describe("addMessageToChat — inline RAG retrieval (ready documents)", () => {
	beforeEach(() => {
		mocks.hasReadyDocuments.mockResolvedValue(true);
		mocks.getRAGProviderConfig.mockResolvedValue({ apiKey: "key-1" });
		mocks.retrieveContext.mockResolvedValue([{ id: "chunk-1" }]);
		mocks.formatContextForLLM.mockReturnValue("RAG_CONTEXT_TEXT");
	});

	it("routes the retrieved context through `system` and strips it from `messages`", async () => {
		const originalUserMessage = userMessage(
			"m1",
			"What does the report say?",
		);
		const messages = [originalUserMessage];

		await handlers.addMessage({
			input: { chatId: "chat-1", messages },
			context: ctx,
		});

		expect(mocks.streamText).toHaveBeenCalledTimes(1);
		const callArgs = mocks.streamText.mock.calls[0][0] as {
			instructions?: string;
			messages: Array<{ role: string }>;
		};
		expect(callArgs.instructions).toBe("RAG_CONTEXT_TEXT");
		expect(callArgs.messages.some((m) => m.role === "system")).toBe(false);
		// `messages` is mutated in place by the handler's `unshift` (an
		// existing behaviour, unrelated to this fix) — assert against the
		// captured original message rather than `messages[0]` post-call.
		expect(callArgs.messages).toEqual([originalUserMessage]);
	});

	it("joins a pre-existing client system row with the injected context, in order", async () => {
		// A `role: "system"` row already in the client-sent messages (the
		// schema allows it) plus the RAG-injected one that `unshift`s to the
		// front — both must reach `system`, joined with a blank line, in the
		// final array order (RAG-injected first).
		const messages = [
			systemMessage("sys-pre", "PRE_EXISTING_SYSTEM"),
			userMessage("m1", "question"),
		];

		await handlers.addMessage({
			input: { chatId: "chat-1", messages },
			context: ctx,
		});

		const callArgs = mocks.streamText.mock.calls[0][0] as {
			instructions?: string;
			messages: Array<{ role: string }>;
		};
		expect(callArgs.instructions).toBe(
			"RAG_CONTEXT_TEXT\n\nPRE_EXISTING_SYSTEM",
		);
		expect(callArgs.messages.some((m) => m.role === "system")).toBe(false);
	});
});

describe("addMessageToChat — pending-documents workflow RAG path", () => {
	it("routes the workflow-retrieved context through `system` and strips it from `messages`", async () => {
		mocks.hasPendingDocuments.mockResolvedValue(true);
		mocks.getTemporalClient.mockResolvedValue({
			workflow: {
				start: vi.fn().mockResolvedValue({
					result: vi.fn().mockResolvedValue({
						success: true,
						context: "WORKFLOW_RAG_CONTEXT",
						chunkCount: 2,
						documentsReady: true,
					}),
				}),
			},
		});

		const originalUserMessage = userMessage(
			"m1",
			"What does the report say?",
		);
		const messages = [originalUserMessage];

		await handlers.addMessage({
			input: { chatId: "chat-1", messages },
			context: ctx,
		});

		expect(mocks.streamText).toHaveBeenCalledTimes(1);
		const callArgs = mocks.streamText.mock.calls[0][0] as {
			instructions?: string;
			messages: Array<{ role: string }>;
		};
		expect(callArgs.instructions).toBe("WORKFLOW_RAG_CONTEXT");
		expect(callArgs.messages.some((m) => m.role === "system")).toBe(false);
		// `messages` is mutated in place by the handler's `unshift` (an
		// existing behaviour, unrelated to this fix) — assert against the
		// captured original message rather than `messages[0]` post-call.
		expect(callArgs.messages).toEqual([originalUserMessage]);
	});
});
