/**
 * An MCP client built by `createMcpClient` sends no request that can change
 * anything on the server (any method but GET or HEAD — every JSON-RPC call,
 * a `tools/call` among them) once the Advisor chat turn it runs in has
 * stopped. The check sits in the transport's `fetch`, the last code that runs
 * before a request leaves: the MCP client and its transport await their own
 * preparation (an OAuth token, a retry's back-off) after the caller's last
 * check, so a check at the tool call's call site does not cover them.
 *
 * Runs the real AI SDK MCP client over the real Streamable HTTP transport;
 * only the server is simulated, by the `fetch` the client is given.
 */

import {
	isDispatchDeadlinePassedError,
	runWithDispatchDeadline,
} from "@repo/utils/dispatch-deadline";
import {
	type DispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	getMcpConfigById: vi.fn(),
	getValidAccessToken: vi.fn(),
	getMcpConfigByIdInternal: vi.fn(),
	getMcpOAuthGrantGeneration: vi.fn(),
	canConnectOrganizationMcpConfigs: async () => true,
	canReadOrganizationMcpConfigs: async () => true,
	isOrganizationMember: async () => true,
}));

// The destination check resolves DNS; not under test here.
vi.mock("../server-url-guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("../server-url-guard")>()),
	assertMcpServerUrlResolved: async () => undefined,
}));

import { createMcpClient, refuseWritesAfterDispatchStop } from "../client";

const STOP = new Error("the chat turn stopped");

function turnGuard(stopped: () => boolean): DispatchGuard {
	return {
		key: "turn-example-1",
		assertDispatchable: async () => undefined,
		abortSignal: () => undefined,
		rethrowIfStopped: () => {
			if (stopped()) {
				throw STOP;
			}
		},
		throwIfStopped: () => {
			if (stopped()) {
				throw STOP;
			}
		},
	};
}

/** JSON-RPC methods the simulated server received, in order. */
let received: string[] = [];

/** A minimal Streamable HTTP MCP server with one tool. */
const serverFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
	if ((init?.method ?? "GET").toUpperCase() !== "POST") {
		return new Response(null, { status: 405 });
	}
	const message = JSON.parse(String(init?.body)) as {
		id?: number;
		method: string;
		params?: { protocolVersion?: string };
	};
	received.push(message.method);
	if (message.id === undefined) {
		return new Response(null, { status: 202 });
	}
	const result =
		message.method === "initialize"
			? {
					protocolVersion: message.params?.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "example", version: "1.0.0" },
				}
			: message.method === "tools/list"
				? {
						tools: [
							{
								name: "create_item",
								description: "Creates an item",
								inputSchema: { type: "object", properties: {} },
							},
						],
					}
				: message.method === "tools/call"
					? { content: [{ type: "text", text: "created" }] }
					: {};
	return new Response(
		JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
});

beforeEach(() => {
	received = [];
	serverFetch.mockClear();
});

type Execute = (
	args: Record<string, unknown>,
	options: { toolCallId: string; messages: unknown[] },
) => Promise<unknown>;

async function connect() {
	const client = await createMcpClient({
		serverUrl: "https://mcp.example.com/mcp",
		transport: "HTTP",
		fetch: serverFetch,
	});
	const tools = (await client.tools()) as unknown as Record<
		string,
		{ execute: Execute }
	>;
	return { client, tools };
}

describe("an MCP tool call inside a chat turn", () => {
	it("reaches the server when nothing stops the turn", async () => {
		const { client, tools } = await connect();
		const output = await runWithDispatchGuard(
			turnGuard(() => false),
			() =>
				tools.create_item.execute(
					{},
					{ toolCallId: "c1", messages: [] },
				),
		);
		expect(output).toMatchObject({
			content: [{ type: "text", text: "created" }],
		});
		expect(received).toContain("tools/call");
		await client.close();
	});

	it("never reaches the server once the turn has stopped, and fails with the stop", async () => {
		const { client, tools } = await connect();
		const outcome = await runWithDispatchGuard(
			turnGuard(() => true),
			() =>
				tools.create_item.execute(
					{},
					{ toolCallId: "c1", messages: [] },
				),
		).then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);
		expect(received).not.toContain("tools/call");
		expect(String((outcome as Error)?.message ?? outcome)).toContain(
			"the chat turn stopped",
		);
		await client.close();
	});
});

describe("refuseWritesAfterDispatchStop", () => {
	it("refuses a POST in a stopped turn without sending it, and lets a GET through", async () => {
		const base = vi.fn(async () => new Response("ok"));
		const guarded = refuseWritesAfterDispatchStop(base);
		await runWithDispatchGuard(
			turnGuard(() => true),
			async () => {
				await expect(
					guarded("https://mcp.example.com/mcp", { method: "POST" }),
				).rejects.toBe(STOP);
				await expect(
					guarded("https://mcp.example.com/mcp", {
						method: "DELETE",
					}),
				).rejects.toBe(STOP);
				await guarded("https://mcp.example.com/mcp", { method: "GET" });
			},
		);
		expect(base).toHaveBeenCalledTimes(1);
		expect(base).toHaveBeenCalledWith("https://mcp.example.com/mcp", {
			method: "GET",
		});
	});

	it("is the given fetch outside a chat turn", async () => {
		const base = vi.fn(async () => new Response("ok"));
		await refuseWritesAfterDispatchStop(base)(
			"https://mcp.example.com/mcp",
			{ method: "POST" },
		);
		expect(base).toHaveBeenCalledTimes(1);
	});
});

describe("a tool call past the send deadline of the code sending it (a PM create's)", () => {
	// The monotonic clock the deadline is read on, held still.
	const NOW = 1_000_000;
	beforeEach(() => {
		vi.spyOn(performance, "now").mockReturnValue(NOW);
	});
	afterEach(() => {
		vi.mocked(performance.now).mockRestore();
	});
	const PASSED = NOW;
	const AHEAD = NOW + 50_000;

	it("never reaches the server over the real MCP client and transport, and fails as not sent", async () => {
		const { client, tools } = await connect();
		const outcome = await runWithDispatchDeadline(PASSED, () =>
			tools.create_item.execute({}, { toolCallId: "c1", messages: [] }),
		).then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);
		expect(received).not.toContain("tools/call");
		expect(isDispatchDeadlinePassedError(outcome)).toBe(true);
		await client.close();
	});

	it("reaches the server while the deadline is ahead", async () => {
		const { client, tools } = await connect();
		await runWithDispatchDeadline(AHEAD, () =>
			tools.create_item.execute({}, { toolCallId: "c1", messages: [] }),
		);
		expect(received).toContain("tools/call");
		await client.close();
	});

	it("refuses only tool calls: the handshake, the tool list, notifications and responses still go out", async () => {
		const base = vi.fn(async () => new Response("ok"));
		const guarded = refuseWritesAfterDispatchStop(base);
		const post = (body: unknown) =>
			guarded("https://mcp.example.com/mcp", {
				method: "POST",
				body,
			} as RequestInit);
		await runWithDispatchDeadline(PASSED, async () => {
			await post(
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
			);
			await post(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "notifications/initialized",
				}),
			);
			await post(
				JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
			);
			// A response to a request from the server (e.g. a ping).
			await post(JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} }));
			await post(new URLSearchParams({ grant_type: "refresh_token" }));
			await guarded("https://mcp.example.com/mcp", { method: "GET" });
			expect(base).toHaveBeenCalledTimes(6);

			for (const body of [
				JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call" }),
				JSON.stringify([
					{ jsonrpc: "2.0", id: 4, method: "tools/list" },
					{ jsonrpc: "2.0", id: 5, method: "tools/call" },
				]),
				// A body that cannot be read as JSON-RPC is refused too.
				"not json",
				new Blob(["x"]),
			]) {
				const refused = await post(body).then(
					() => null,
					(error: unknown) => error,
				);
				expect(isDispatchDeadlinePassedError(refused)).toBe(true);
			}
		});
		expect(base).toHaveBeenCalledTimes(6);
	});

	it("is the given fetch outside a deadline scope", async () => {
		const base = vi.fn(async () => new Response("ok"));
		await refuseWritesAfterDispatchStop(base)(
			"https://mcp.example.com/mcp",
			{
				method: "POST",
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 3,
					method: "tools/call",
				}),
			},
		);
		expect(base).toHaveBeenCalledTimes(1);
	});
});
