import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "@/app/api/chat/route";
import { auth } from "@/lib/auth";
import { getFabricToolSession } from "@/lib/fabric-tools";
import { createMCPClient } from "@ai-sdk/mcp";
import { streamText, convertToModelMessages } from "ai";

// 1. Mock Auth (Fabric auth compatibility layer)
vi.mock("@/lib/auth", () => ({
	auth: vi.fn(),
}));

// 2. Mock Fabric tool router (otherwise route makes a real fetch in tests)
vi.mock("@/lib/fabric-tools", () => ({
	getFabricToolSession: vi.fn(),
}));

// 3. Mock MCP Client
vi.mock("@ai-sdk/mcp", () => ({
	createMCPClient: vi.fn(),
}));

vi.mock("@ai-sdk/openai", () => ({
	openai: vi.fn(() => "openai-model"),
}));

vi.mock("@ai-sdk/anthropic", () => ({
	anthropic: vi.fn(() => "anthropic-model"),
}));

vi.mock("@ai-sdk/google", () => ({
	google: vi.fn(() => "google-model"),
}));

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>();
	return {
		...actual,
		streamText: vi.fn(),
		convertToModelMessages: vi.fn(),
	};
});

describe("Chat API POST", () => {
	let mcpClient: {
		tools: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();

		// Setup Default Mock Implementations
		(getFabricToolSession as any).mockResolvedValue({
			mcp: {
				url: "http://mock-mcp.local/mcp",
				headers: { Authorization: "Bearer mock" },
			},
			sessionId: "mock-session",
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
		});

		mcpClient = {
			tools: vi.fn().mockResolvedValue([{ name: "test-tool" }]),
			close: vi.fn().mockResolvedValue(undefined),
		};
		(createMCPClient as any).mockResolvedValue(mcpClient);

		// AI SDK 7 removed the route's dependency on the `streamText` result
		// helpers: it now reads `result.stream` and pipes it through the
		// stateless `toUIMessageStream` / `createUIMessageStreamResponse`
		// pair, both of which stay unmocked here. The fake result therefore
		// only has to expose an empty, already-closed source stream, and the
		// Response the route returns is built by the real helpers.
		(streamText as any).mockReturnValue({
			stream: new ReadableStream({
				start(controller) {
					controller.close();
				},
			}),
		});

		(convertToModelMessages as any).mockReturnValue([]);
	});

	it("should return 401 Unauthorized if user is not logged in", async () => {
		(auth as any).mockResolvedValue(null);

		const req = new Request("http://localhost/api/chat", {
			method: "POST",
			body: JSON.stringify({ messages: [] }),
		});
		const res = await POST(req);

		expect(res.status).toBe(401);
	});

	it("should return 200 and a consumable SSE stream if user is logged in", async () => {
		(auth as any).mockResolvedValue({
			user: { id: "test-user-1" },
		});

		const req = new Request("http://localhost/api/chat", {
			method: "POST",
			body: JSON.stringify({
				messages: [{ role: "user", content: "Hello" }],
			}),
		});
		const res = await POST(req);

		if (res.status !== 200) {
			console.error("Error Status:", res.status);
		}
		expect(res.status).toBe(200);

		// The stateless helpers are what build this response, so assert the
		// headers they are documented to set rather than trusting that a
		// Response object came back at all.
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(res.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
		expect(res.headers.get("cache-control")).toBe("no-cache");

		// Drain the body. An empty source stream still has to produce a
		// well-formed SSE terminator, which is the difference between a
		// Response that was merely constructed and one a client can read.
		expect(res.body).not.toBeNull();
		const body = await res.text();
		expect(body).toBe("data: [DONE]\n\n");
	});

	it("closes the MCP client when the model run ends", async () => {
		// `vi.mocked` rather than the `as any` casts the older assertions in
		// this file use: it is typed, so it keeps the new coverage from adding
		// to the pre-existing `no-explicit-any` lint debt here.
		vi.mocked(auth).mockResolvedValue({
			user: { id: "test-user-onend" },
		});

		const req = new Request("http://localhost/api/chat", {
			method: "POST",
			body: JSON.stringify({
				messages: [{ role: "user", content: "Hello" }],
			}),
		});
		await POST(req);

		// `onEnd` is SDK 7's rename of `onFinish`; the route hangs MCP
		// teardown off it. Nothing in this test drives a real model run, so
		// capture the option the route passed and invoke it the way the SDK
		// would, then assert the session was actually torn down.
		const onEnd = vi.mocked(streamText).mock.calls[0][0].onEnd;
		expect(typeof onEnd).toBe("function");
		expect(mcpClient.close).not.toHaveBeenCalled();

		await onEnd?.({} as never);

		expect(mcpClient.close).toHaveBeenCalledTimes(1);
	});

	it("should return 500 Internal Server Error if upstream service fails", async () => {
		(auth as any).mockResolvedValue({
			user: { id: "test-user-error" },
		});

		// Override mock to simulate a crash in MCP client initialization
		(createMCPClient as any).mockRejectedValueOnce(
			new Error("MCP Service Down"),
		);

		const req = new Request("http://localhost/api/chat", {
			method: "POST",
			body: JSON.stringify({
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const res = await POST(req);

		expect(res.status).toBe(500);
		expect(await res.text()).toBe("Internal Server Error");
	});

	it("should return 500 if request body is invalid", async () => {
		(auth as any).mockResolvedValue({
			user: { id: "test-user-bad-input" },
		});

		// Malformed JSON body
		const req = new Request("http://localhost/api/chat", {
			method: "POST",
			body: "{ invalid-json: ",
		});

		const res = await POST(req);

		expect(res.status).toBe(500);
	});

	it("should return 429 Too Many Requests if limit exceeded", async () => {
		// Setup: Valid user
		(auth as any).mockResolvedValue({
			user: { id: "spam-user" },
		});

		const reqBody = JSON.stringify({
			messages: [{ role: "user", content: "Hello" }],
		});

		// Action: Call the API 10 times (the limit)
		for (let i = 0; i < 10; i++) {
			const req = new Request("http://localhost/api/chat", {
				method: "POST",
				body: reqBody,
			});
			const res = await POST(req);
			expect(res.status).toBe(200); // Should succeed
		}

		// Action: Call it the 11th time
		const req = new Request("http://localhost/api/chat", {
			method: "POST",
			body: reqBody,
		});
		const res = await POST(req);

		// Assertion: Should fail now
		expect(res.status).toBe(429);
	});
});
