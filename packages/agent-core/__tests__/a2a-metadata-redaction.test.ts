import {
	afterEach,
	assert,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { type A2AAgentExecutor, A2AServer } from "../src/a2a/server";
import type { A2AMessage } from "../src/a2a/types";
import * as exchange from "../src/services/token-exchange";
import { createUnifiedServer } from "../src/unified-server";

const providerKey = "sk-example-provider-secret";
const aiToken = "example-ai-session-token";
const message: A2AMessage = {
	role: "user",
	parts: [{ type: "text", text: "hello" }],
	metadata: { nested: [{ Authorization: providerKey }], note: "keep" },
};
const metadata = {
	ai_api_key: providerKey,
	ai_token: aiToken,
	nested: [{ PASSWORD: providerKey }],
	reasoning: "keep reasoning",
};
function expectNoSecrets(text: string) {
	expect(text).not.toContain(providerKey);
	expect(text).not.toContain(aiToken);
}

beforeEach(() => {
	vi.stubEnv("AGENT_API_KEY", "");
	vi.stubEnv("AGENT_API_KEYS", "");
	vi.stubEnv("AGENT_HMAC_SECRET", "");
	vi.spyOn(exchange, "getAICredentialsFromHeaders").mockResolvedValue({
		apiKey: providerKey,
		provider: "openai",
		model: "example-model",
		expiresIn: 300,
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("A2A HTTP metadata redaction", () => {
	it.each([
		{ path: "/a2a/send", failed: false },
		{ path: "/a2a/send/stream", failed: false },
		{ path: "/a2a/send", failed: true },
		{ path: "/a2a/send/stream", failed: true },
	])(
		"protects response and stored task: $path failed=$failed",
		async ({ path, failed }) => {
			const invoke = vi.fn(async () => ({ response: "hello back" }));
			const { app } = createUnifiedServer(
				{
					name: "example-agent",
					description: "Example",
					baseUrl: "https://example.com",
					port: 3000,
					skills: [],
				},
				invoke,
				(output) =>
					failed
						? { response: "", error: "Example execution failed" }
						: { response: String(output.response), metadata },
			);
			const response = await app.request(path, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AI-Token": aiToken,
				},
				body: JSON.stringify({
					message,
					metadata: { reasoning: "keep reasoning" },
				}),
			});
			expect(response.status).toBe(200);
			const raw = await response.text();
			const firstEvent = raw
				.split("\n")
				.find((line) => line.startsWith("data: {"));
			if (path.endsWith("stream")) {
				assert(firstEvent);
			}
			const taskId: string = path.endsWith("stream")
				? JSON.parse(firstEvent?.slice(6) ?? "{}").taskId
				: JSON.parse(raw).task.id;
			const stored = await app.request(`/a2a/tasks/${taskId}`);
			expect(stored.status).toBe(200);
			const storedRaw = await stored.text();
			expect(invoke).toHaveBeenCalledWith(
				expect.objectContaining({
					ai_api_key: providerKey,
					ai_token: aiToken,
				}),
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			expect(JSON.parse(storedRaw).metadata.reasoning).toBe(
				"keep reasoning",
			);
			if (failed) {
				expect(JSON.parse(storedRaw).metadata.error).toBe(
					"Example execution failed",
				);
			}
			expectNoSecrets(raw);
			expectNoSecrets(storedRaw);
		},
	);
});

function server(executor: A2AAgentExecutor) {
	return new A2AServer(
		{
			name: "example-agent",
			description: "Example",
			url: "https://example.com",
			skills: [],
		},
		executor,
	);
}

describe("standalone A2AServer metadata redaction", () => {
	it.each([false, true])(
		"redacts initial and completed tasks; streaming=%s",
		async (streaming) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const execute = vi.fn<A2AAgentExecutor["execute"]>(async () => {
				await gate;
				return { response: "hello back", metadata, artifacts: [] };
			});
			const a2a = server({ execute });
			if (streaming) {
				const events = a2a.handleSendMessageStream(
					message,
					undefined,
					metadata,
				);
				const first = await events.next();
				assert(!first.done);
				expectNoSecrets(
					JSON.stringify(a2a.getTask(first.value.taskId)),
				);
				release();
				for await (const event of events) {
					expectNoSecrets(JSON.stringify(event));
				}
				expectNoSecrets(
					JSON.stringify(a2a.getTask(first.value.taskId)),
				);
			} else {
				const pending = a2a.handleSendMessage(
					message,
					undefined,
					metadata,
				);
				release();
				const task = await pending;
				expectNoSecrets(JSON.stringify(task));
				expect(task.messages[1].metadata?.reasoning).toBe(
					"keep reasoning",
				);
			}
			// Asserted here, not inside execute: the server's catch would
			// swallow a failure thrown from the executor.
			expect(execute).toHaveBeenCalledOnce();
			expect(execute.mock.calls[0][0]).toBe(message);
			expect(execute.mock.calls[0][2]).toBe(metadata);
			expect(metadata.ai_api_key).toBe(providerKey);
			expect(message.metadata?.nested).toEqual([
				{ Authorization: providerKey },
			]);
		},
	);

	it("redacts result metadata in fallback SSE message events", async () => {
		const a2a = server({
			execute: async () => ({ response: "hello back", metadata }),
		});
		const events = [];
		for await (const event of a2a.handleSendMessageStream(
			message,
			undefined,
			metadata,
		)) {
			events.push(event);
		}
		expect(
			events.find((event) => event.type === "message")?.message?.metadata
				?.reasoning,
		).toBe("keep reasoning");
		expectNoSecrets(JSON.stringify(events));
	});

	it("preserves content and original streaming executor inputs", async () => {
		const a2a = server({
			execute: vi.fn(),
			async *executeStream(
				receivedMessage,
				_contextId,
				receivedMetadata,
			) {
				expect(receivedMessage).toBe(message);
				expect(receivedMetadata).toBe(metadata);
				yield { type: "text", text: providerKey };
				yield {
					type: "artifact",
					artifact: {
						id: "example-artifact",
						parts: [{ type: "text", text: aiToken }],
					},
				};
			},
		});
		const events = [];
		for await (const event of a2a.handleSendMessageStream(
			message,
			undefined,
			metadata,
		)) {
			events.push(event);
		}
		const task = a2a.getTask(events[0].taskId);
		assert(task);
		expectNoSecrets(
			JSON.stringify({
				metadata: task.metadata,
				messages: task.messages.map((m) => m.metadata),
			}),
		);
		expect(task.messages[1].parts).toEqual([
			{ type: "text", text: providerKey },
		]);
		expect(task.artifacts[0].parts).toEqual([
			{ type: "text", text: aiToken },
		]);
	});

	it.each([false, true])(
		"redacts standalone failure metadata; streaming=%s",
		async (streaming) => {
			const a2a = server({
				execute: async () => {
					throw new Error("Example failure");
				},
			});
			const task = streaming
				? await (async () => {
						const events = [];
						for await (const event of a2a.handleSendMessageStream(
							message,
							undefined,
							metadata,
						)) {
							events.push(event);
						}
						expectNoSecrets(JSON.stringify(events));
						const task = a2a.getTask(events[0].taskId);
						assert(task);
						return task;
					})()
				: await a2a.handleSendMessage(message, undefined, metadata);
			expect(task.metadata?.error).toBe("Example failure");
			expect(task.metadata?.reasoning).toBe("keep reasoning");
			expectNoSecrets(JSON.stringify(task));
		},
	);
});
