/**
 * `AtlasService.chat()` — loss-proof persistence.
 *
 * Locks the contract:
 *  - the USER turn (with first-turn title, 60-char cap) is appended BEFORE
 *    `streamText` is invoked; a failed pre-stream append throws
 *    `PERSISTENCE_FAILED` and starts no stream;
 *  - the ASSISTANT turn is appended exactly once across every completion
 *    path — finish, explicit abort, error, AND consumer cancellation
 *    (`iterator.return()`, how a client disconnect actually surfaces);
 *  - interrupted partials persist with `interrupted: true`; empty partials
 *    append nothing; usage is recorded for completed turns only;
 *  - a post-stream append failure resolves `persistOutcome.persisted: false`
 *    (the procedure's "turn not saved" sentinel source).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListProjectRepositories = vi.fn();
const mockFindAnalysis = vi.fn();
const mockGetConversation = vi.fn();
const mockCreateConversation = vi.fn();
const mockAppendMessages = vi.fn();
const mockBuildSystemPrompt = vi.fn();
const mockGetAIModelWithMetadata = vi.fn();
const mockStreamText = vi.fn();
const mockTrackUsage = vi.fn();
const mockRecordAtlasUsage = vi.fn();
const mockRecordAudit = vi.fn();
const callOrder: string[] = [];

vi.mock("../queries", () => ({
	listProjectRepositories: (...args: unknown[]) =>
		mockListProjectRepositories(...args),
	findAnalysis: (...args: unknown[]) => mockFindAnalysis(...args),
	findLatestAnalysisForProject: vi.fn(),
	getConversation: (...args: unknown[]) => mockGetConversation(...args),
	createConversation: (...args: unknown[]) => mockCreateConversation(...args),
	appendMessages: (...args: unknown[]) => {
		callOrder.push("appendMessages");
		return mockAppendMessages(...args);
	},
}));

vi.mock("../chat", () => ({
	buildSystemPrompt: (...args: unknown[]) => mockBuildSystemPrompt(...args),
}));

vi.mock("../credentials", () => ({
	ensureFreshRepoCredentials: vi.fn(),
}));

vi.mock("../usage", () => ({
	recordAtlasUsage: (...args: unknown[]) => mockRecordAtlasUsage(...args),
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {},
	generateObject: vi.fn(),
	getAIModelWithMetadata: (...args: unknown[]) =>
		mockGetAIModelWithMetadata(...args),
	logModelUsageAsync: vi.fn(),
	streamText: (...args: unknown[]) => {
		callOrder.push("streamText");
		return mockStreamText(...args);
	},
}));

vi.mock("@repo/database", () => ({
	recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("simple-git", () => ({ default: vi.fn() }));

import { AtlasService } from "../service";

const ctx = { userId: "user-1", organizationId: "org-1" };

interface StreamTextOptions {
	messages: { role: string; content: string }[];
	onFinish: (event: {
		text: string;
		usage: Record<string, number>;
	}) => Promise<void>;
	onAbort: (event: { steps: unknown[] }) => Promise<void>;
	onError: (event: { error: unknown }) => Promise<void>;
}

/** The options `chat()` passed to the (mocked) AI SDK, for hook driving. */
let streamTextOptions: StreamTextOptions;

function stubStream(deltas: string[]) {
	mockStreamText.mockImplementation((options: StreamTextOptions) => {
		streamTextOptions = options;
		return {
			textStream: (async function* () {
				for (const delta of deltas) {
					yield delta;
				}
			})(),
		};
	});
}

function makeConversation(overrides: Record<string, unknown> = {}) {
	return {
		id: "c1",
		mode: "TECHNICAL",
		projectId: "p1",
		repositoryIntegrationId: "int-1",
		title: "New conversation",
		visibility: "PRIVATE",
		userId: "user-1",
		isOwner: true,
		messages: [] as { role: string; content: string }[],
		createdAt: "2026-06-01T00:00:00.000Z",
		updatedAt: "2026-06-01T00:00:00.000Z",
		...overrides,
	};
}

const chatInput = {
	projectId: "p1",
	repositoryIntegrationId: "int-1",
	mode: "TECHNICAL" as const,
	conversationId: "c1",
	messages: [{ role: "user" as const, content: "How does auth work?" }],
};

beforeEach(() => {
	vi.clearAllMocks();
	callOrder.length = 0;
	mockListProjectRepositories.mockResolvedValue([
		{
			repositoryIntegrationId: "int-1",
			provider: "GITHUB",
			authMethod: "OAUTH",
			repositoryName: "widgets",
			repositoryUrl: "https://github.com/acme/widgets",
			defaultBranch: "main",
			status: "ACTIVE",
			isDefault: true,
		},
	]);
	mockFindAnalysis.mockResolvedValue({
		id: "an-1",
		status: "READY",
		repositoryName: "widgets",
	});
	mockGetConversation.mockResolvedValue(makeConversation());
	mockCreateConversation.mockResolvedValue(makeConversation());
	mockAppendMessages.mockResolvedValue(1);
	mockBuildSystemPrompt.mockResolvedValue("SYSTEM PROMPT");
	mockGetAIModelWithMetadata.mockResolvedValue({
		model: { id: "model-1" },
		metadata: { provider: "test" },
		trackUsage: mockTrackUsage,
	});
	stubStream(["Hello", " world"]);
});

async function consumeAll(stream: AsyncGenerator<string>): Promise<string> {
	let text = "";
	for await (const delta of stream) {
		text += delta;
	}
	return text;
}

describe("chat — user turn persisted before streaming", () => {
	it("appends the user message BEFORE streamText is invoked", async () => {
		const service = new AtlasService(ctx);
		await service.chat(chatInput);

		expect(callOrder.indexOf("appendMessages")).toBeGreaterThanOrEqual(0);
		expect(callOrder.indexOf("appendMessages")).toBeLessThan(
			callOrder.indexOf("streamText"),
		);
		const [conversationId, messages] = mockAppendMessages.mock.calls[0];
		expect(conversationId).toBe("c1");
		expect(messages).toEqual([
			expect.objectContaining({
				role: "user",
				content: "How does auth work?",
			}),
		]);
	});

	it("derives the first-turn title pre-stream, capped at 60 chars with an ellipsis", async () => {
		const longQuestion = "x".repeat(100);
		const service = new AtlasService(ctx);
		await service.chat({
			...chatInput,
			messages: [{ role: "user", content: longQuestion }],
		});

		const title = mockAppendMessages.mock.calls[0][2];
		expect(title).toBe(`${"x".repeat(60)}…`);
		expect(title.length).toBe(61);
	});

	it("does not re-derive the title for an existing conversation with history", async () => {
		mockGetConversation.mockResolvedValue(
			makeConversation({
				title: "How does auth work?",
				messages: [
					{ role: "user", content: "How does auth work?" },
					{ role: "assistant", content: "Via better-auth." },
				],
			}),
		);

		const service = new AtlasService(ctx);
		await service.chat(chatInput);

		expect(mockAppendMessages.mock.calls[0][2]).toBeUndefined();
	});

	it("snapshots prior turns before the append — the model input includes the new turn exactly once", async () => {
		mockGetConversation.mockResolvedValue(
			makeConversation({
				messages: [
					{ role: "user", content: "earlier question" },
					{ role: "assistant", content: "earlier answer" },
				],
			}),
		);

		const service = new AtlasService(ctx);
		await service.chat(chatInput);

		const modelMessages = streamTextOptions.messages;
		expect(modelMessages).toHaveLength(3);
		expect(
			modelMessages.filter((m) => m.content === "How does auth work?"),
		).toHaveLength(1);
	});

	it("throws PERSISTENCE_FAILED and starts no stream when the pre-stream append reports 0 rows", async () => {
		mockAppendMessages.mockResolvedValue(0);

		const service = new AtlasService(ctx);
		await expect(service.chat(chatInput)).rejects.toMatchObject({
			code: "PERSISTENCE_FAILED",
		});
		expect(mockStreamText).not.toHaveBeenCalled();
	});

	it("throws PERSISTENCE_FAILED when the pre-stream append rejects", async () => {
		mockAppendMessages.mockRejectedValueOnce(new Error("db down"));

		const service = new AtlasService(ctx);
		await expect(service.chat(chatInput)).rejects.toMatchObject({
			code: "PERSISTENCE_FAILED",
		});
		expect(mockStreamText).not.toHaveBeenCalled();
	});
});

describe("chat — assistant persistence across completion paths", () => {
	it("onFinish appends the assistant message only (the user turn is never re-appended)", async () => {
		const service = new AtlasService(ctx);
		const { textStream, persistOutcome } = await service.chat(chatInput);

		await consumeAll(textStream);
		await streamTextOptions.onFinish({
			text: "Hello world",
			usage: { totalTokens: 10 },
		});

		expect(mockAppendMessages).toHaveBeenCalledTimes(2);
		const [, assistantMessages] = mockAppendMessages.mock.calls[1];
		expect(assistantMessages).toEqual([
			expect.objectContaining({
				role: "assistant",
				content: "Hello world",
			}),
		]);
		expect(assistantMessages[0].interrupted).toBeUndefined();
		await expect(persistOutcome).resolves.toEqual({
			persisted: true,
			interrupted: false,
		});
	});

	it("onAbort salvages the accumulated partial with interrupted: true", async () => {
		const service = new AtlasService(ctx);
		const { textStream, persistOutcome } = await service.chat(chatInput);

		// Pull both deltas (they accumulate server-side), then abort.
		const iterator = textStream[Symbol.asyncIterator]();
		await iterator.next();
		await iterator.next();
		await streamTextOptions.onAbort({ steps: [] });

		const [, assistantMessages] = mockAppendMessages.mock.calls[1];
		expect(assistantMessages).toEqual([
			expect.objectContaining({
				role: "assistant",
				content: "Hello world",
				interrupted: true,
			}),
		]);
		await expect(persistOutcome).resolves.toEqual({
			persisted: true,
			interrupted: true,
		});
	});

	it("CONSUMER CANCEL (iterator.return — how a client disconnect surfaces) fires the salvage", async () => {
		const service = new AtlasService(ctx);
		const { textStream, persistOutcome } = await service.chat(chatInput);

		const iterator = textStream[Symbol.asyncIterator]();
		const first = await iterator.next();
		expect(first.value).toBe("Hello");
		// No AbortSignal, no onAbort — the consumer just goes away.
		await iterator.return?.(undefined);

		expect(mockAppendMessages).toHaveBeenCalledTimes(2);
		const [, assistantMessages] = mockAppendMessages.mock.calls[1];
		expect(assistantMessages).toEqual([
			expect.objectContaining({
				role: "assistant",
				content: "Hello",
				interrupted: true,
			}),
		]);
		await expect(persistOutcome).resolves.toEqual({
			persisted: true,
			interrupted: true,
		});
	});

	it("a mid-stream error salvages the partial via onError, then onFinish (SDK fires it after onError) only meters usage", async () => {
		const service = new AtlasService(ctx);
		const { textStream, persistOutcome } = await service.chat(chatInput);

		const iterator = textStream[Symbol.asyncIterator]();
		await iterator.next();
		await streamTextOptions.onError({ error: new Error("provider 500") });
		// AI SDK v6 still fires onFinish after onError (tokens were consumed);
		// the one-shot guard keeps the interrupted persist authoritative.
		await streamTextOptions.onFinish({
			text: "Hello",
			usage: { totalTokens: 5 },
		});

		expect(mockAppendMessages).toHaveBeenCalledTimes(2);
		const [, assistantMessages] = mockAppendMessages.mock.calls[1];
		expect(assistantMessages[0]).toMatchObject({
			role: "assistant",
			content: "Hello",
			interrupted: true,
		});
		expect(mockRecordAtlasUsage).toHaveBeenCalledTimes(1);
		await expect(persistOutcome).resolves.toEqual({
			persisted: true,
			interrupted: true,
		});
	});

	it("an error BEFORE the first token resolves interrupted (no append, no endless spinner)", async () => {
		// The SDK converts provider errors into error parts and closes the
		// text stream NORMALLY — the only signal the live client can get is
		// the interrupted outcome, even though there is nothing to persist.
		const service = new AtlasService(ctx);
		const { persistOutcome } = await service.chat(chatInput);

		await streamTextOptions.onError({ error: new Error("provider down") });

		// Only the pre-stream user append happened.
		expect(mockAppendMessages).toHaveBeenCalledTimes(1);
		await expect(persistOutcome).resolves.toEqual({
			persisted: true,
			interrupted: true,
		});
	});

	it("skips the assistant append entirely for an empty partial (abort before first token)", async () => {
		const service = new AtlasService(ctx);
		const { persistOutcome } = await service.chat(chatInput);

		await streamTextOptions.onAbort({ steps: [] });

		// Only the pre-stream user append happened.
		expect(mockAppendMessages).toHaveBeenCalledTimes(1);
		// Nothing to save is not a persistence failure — but it IS still an
		// interruption from the client's point of view.
		await expect(persistOutcome).resolves.toEqual({
			persisted: true,
			interrupted: true,
		});
	});

	it("a double-fire of onFinish + onAbort appends the assistant message exactly once", async () => {
		const service = new AtlasService(ctx);
		const { textStream } = await service.chat(chatInput);

		await consumeAll(textStream);
		await streamTextOptions.onFinish({
			text: "Hello world",
			usage: { totalTokens: 10 },
		});
		await streamTextOptions.onAbort({ steps: [] });

		expect(mockAppendMessages).toHaveBeenCalledTimes(2);
		const [, assistantMessages] = mockAppendMessages.mock.calls[1];
		expect(assistantMessages[0].interrupted).toBeUndefined();
	});
});

describe("chat — usage recording (whenever the SDK reports finish)", () => {
	it("records usage exactly once on finish", async () => {
		const service = new AtlasService(ctx);
		const { textStream } = await service.chat(chatInput);

		await consumeAll(textStream);
		await streamTextOptions.onFinish({
			text: "Hello world",
			usage: { totalTokens: 10 },
		});

		expect(mockRecordAtlasUsage).toHaveBeenCalledTimes(1);
		expect(mockTrackUsage).toHaveBeenCalledTimes(1);
	});

	it("records no usage for aborted/disconnected turns (the SDK never reaches finish)", async () => {
		const service = new AtlasService(ctx);
		const { textStream } = await service.chat(chatInput);

		const iterator = textStream[Symbol.asyncIterator]();
		await iterator.next();
		await streamTextOptions.onAbort({ steps: [] });

		expect(mockRecordAtlasUsage).not.toHaveBeenCalled();
		expect(mockTrackUsage).not.toHaveBeenCalled();
	});
});

describe("chat — post-stream persistence failure surfaces via persistOutcome", () => {
	it("resolves persisted: false when the assistant append rejects (sentinel source)", async () => {
		mockAppendMessages
			.mockResolvedValueOnce(1) // pre-stream user write succeeds
			.mockRejectedValueOnce(new Error("db down")); // assistant write fails

		const service = new AtlasService(ctx);
		const { textStream, persistOutcome } = await service.chat(chatInput);

		await consumeAll(textStream);
		await streamTextOptions.onFinish({
			text: "Hello world",
			usage: { totalTokens: 10 },
		});

		await expect(persistOutcome).resolves.toEqual({
			persisted: false,
			interrupted: false,
		});
	});
});

describe("chat — conversation scoping", () => {
	it("creates new conversations without passing a graph mode (canonical TECHNICAL is written by the query)", async () => {
		const service = new AtlasService(ctx);
		await service.chat({ ...chatInput, conversationId: undefined });

		expect(mockCreateConversation).toHaveBeenCalledTimes(1);
		const [, createInput] = mockCreateConversation.mock.calls[0];
		expect(createInput).not.toHaveProperty("mode");
	});

	it("self-creates with the RAW input repo selector so the history list (same raw scoping) sees it", async () => {
		// Client passed null (default-repo context); resolveRepoOption falls
		// back to "int-1" for the analysis lookup — but the conversation must
		// store the value the list queries with.
		const service = new AtlasService(ctx);
		await service.chat({
			...chatInput,
			conversationId: undefined,
			repositoryIntegrationId: null,
		});

		const [, createInput] = mockCreateConversation.mock.calls[0];
		expect(createInput.repositoryIntegrationId).toBeNull();
	});

	it("loads an existing conversation bound to the permission-checked project", async () => {
		const service = new AtlasService(ctx);
		await service.chat(chatInput);

		expect(mockGetConversation).toHaveBeenCalledWith(expect.anything(), {
			conversationId: "c1",
			projectId: "p1",
		});
	});

	it("rejects NOT_FOUND when the conversation belongs to another project", async () => {
		// The project-bound query returns null for a cross-project id — even
		// a SHARED conversation of a sibling project must not load.
		mockGetConversation.mockResolvedValue(null);

		const service = new AtlasService(ctx);
		await expect(service.chat(chatInput)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mockStreamText).not.toHaveBeenCalled();
	});
});
