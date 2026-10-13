/**
 * `executeMcpTool` tells a failed call that did not take effect (`rejected`)
 * from one that may have (`indeterminate`), and with `sendAtMostOnce` never
 * resends a call that was already sent. The PM create claim releases only on
 * `rejected` (pm-create-claim.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	execute: vi.fn(),
	getClient: vi.fn(),
}));

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: h.getClient,
	invalidateMcpClientCache: vi.fn(async () => undefined),
	McpGitLabOriginMismatchError: class extends Error {},
	OAuthAuthorizationRequiredError: class extends Error {},
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "http://localhost:3000" }));
vi.mock("@repo/database", () => ({ db: {} }));
vi.mock("@repo/integrations/github", () => ({ executeGitHubTool: vi.fn() }));
vi.mock("@repo/integrations/slack", () => ({ executeSlackTool: vi.fn() }));
vi.mock("../../../letta-memory-activities", () => ({
	cacheToolResult: vi.fn(),
	getCachedToolResult: vi.fn(async () => ({ found: false })),
}));
vi.mock("../../../shared/frame-service", () => ({
	createFirstClassFrame: vi.fn(),
	getFirstClassFrame: vi.fn(),
	listFirstClassFrames: vi.fn(),
	shareFirstClassFrame: vi.fn(),
	updateFirstClassFrame: vi.fn(),
}));
vi.mock("../../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));
vi.mock("../../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(async () => null),
}));

function connected() {
	// A fresh client object per acquisition, as after a reconnect.
	h.getClient.mockImplementation(async () => ({
		client: {
			tools: async () => ({ create_card: { execute: h.execute } }),
		},
		serverName: "Fizzy",
		fromCache: false,
	}));
}

const call = {
	toolName: "create_card",
	args: { title: "Example" },
	userId: "u1",
	mcpConfigId: "cfg1",
	failureLogging: "caller" as const,
};

describe("executeMcpTool failureKind", () => {
	afterEach(() => {
		vi.useRealTimers();
		h.execute.mockReset();
		h.getClient.mockReset();
	});

	// An error result is the server's answer after the call was sent; it is
	// not evidence that nothing took effect. The first four are the review's
	// repro payloads, which used to come back `rejected` and release a PM
	// create claim.
	it.each([
		["an empty error result", { isError: true, content: [] }],
		[
			"a JSON 503 in the text",
			{
				isError: true,
				content: [
					{
						type: "text",
						text: '{"status":503,"error":"Upstream request failed"}',
					},
				],
			},
		],
		[
			"a structured 503",
			{ isError: true, error: "Upstream request failed", status: 503 },
		],
		[
			"a bare 500 in the text",
			{
				isError: true,
				content: [{ type: "text", text: "Error creating item: 500" }],
			},
		],
		[
			"a validation message",
			{
				isError: true,
				content: [{ type: "text", text: "Invalid board" }],
			},
		],
	])(
		"%s is an error_result, and never releases a create claim",
		async (_label, output) => {
			connected();
			h.execute.mockResolvedValueOnce(output);
			const { executeMcpTool } = await import("../execute-mcp-tool");
			const { isDefiniteMcpCreateRejection } = await import(
				"../../../pm-integration/pm-create-claim"
			);

			const res = await executeMcpTool(call);

			expect(res.success).toBe(false);
			expect(res.failureKind).toBe("error_result");
			expect(isDefiniteMcpCreateRejection(res)).toBe(false);
		},
	);

	it("a success carries no failureKind", async () => {
		connected();
		h.execute.mockResolvedValueOnce({ id: "1" });
		const { executeMcpTool } = await import("../execute-mcp-tool");

		const res = await executeMcpTool(call);

		expect(res.success).toBe(true);
		expect(res.failureKind).toBeUndefined();
	});

	it("a call that throws after it was sent is indeterminate", async () => {
		connected();
		h.execute.mockRejectedValueOnce(new Error("socket hang up"));
		const { executeMcpTool } = await import("../execute-mcp-tool");

		const res = await executeMcpTool(call);

		expect(res.success).toBe(false);
		expect(res.failureKind).toBe("indeterminate");
	});

	it("a connection that fails before the call is sent is rejected", async () => {
		h.getClient.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		const { executeMcpTool } = await import("../execute-mcp-tool");

		const res = await executeMcpTool(call);

		expect(res.success).toBe(false);
		expect(res.failureKind).toBe("rejected");
		expect(h.execute).not.toHaveBeenCalled();
	});

	it("a tool the server does not list is rejected", async () => {
		h.getClient.mockResolvedValue({
			client: { tools: async () => ({}) },
			serverName: "Fizzy",
			fromCache: true,
		});
		const { executeMcpTool } = await import("../execute-mcp-tool");

		const res = await executeMcpTool(call);

		expect(res.failureKind).toBe("rejected");
	});

	it("a call that times out is indeterminate", async () => {
		vi.useFakeTimers();
		connected();
		h.execute.mockImplementation(() => new Promise(() => {}));
		const { executeMcpTool } = await import("../execute-mcp-tool");

		const promise = executeMcpTool({ ...call, timeoutMs: 5_000 });
		await vi.advanceTimersByTimeAsync(5_000);
		const res = await promise;

		expect(res.success).toBe(false);
		expect(res.failureKind).toBe("indeterminate");
	});

	it("a call that times out aborts the signal it handed the tool (the MCP request), and is never a definite rejection", async () => {
		vi.useFakeTimers();
		connected();
		let seen: AbortSignal | undefined;
		h.execute.mockImplementation(
			(_args: unknown, ctx: { abortSignal?: AbortSignal }) => {
				seen = ctx.abortSignal;
				return new Promise(() => {});
			},
		);
		const { executeMcpTool } = await import("../execute-mcp-tool");
		const { isDefiniteMcpCreateRejection } = await import(
			"../../../pm-integration/pm-create-claim"
		);

		const promise = executeMcpTool({
			...call,
			sendAtMostOnce: true,
			timeoutMs: 5_000,
		});
		await vi.advanceTimersByTimeAsync(4_999);
		expect(seen?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		const res = await promise;

		// The STDIO wrapper sends its request with this signal, so it is
		// torn down when the ceiling passes. @ai-sdk/mcp hands it to the
		// request it makes, but the SDK's HTTP and SSE transports send with
		// their own signal: there, the send deadline's check in the
		// transport's fetch is what keeps a late request from leaving.
		expect(seen?.aborted).toBe(true);
		expect(res.failureKind).toBe("indeterminate");
		expect(isDefiniteMcpCreateRejection(res)).toBe(false);
	});

	it("a call whose time ran out before it was dispatched is never sent", async () => {
		vi.useFakeTimers();
		let release: () => void = () => {};
		h.getClient.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () =>
						resolve({
							client: {
								tools: async () => ({
									create_card: { execute: h.execute },
								}),
							},
							serverName: "Fizzy",
							fromCache: false,
						});
				}),
		);
		const { executeMcpTool } = await import("../execute-mcp-tool");

		const promise = executeMcpTool({ ...call, timeoutMs: 5_000 });
		await vi.advanceTimersByTimeAsync(5_000);
		const res = await promise;
		expect(res.failureKind).toBe("indeterminate");

		// The connection comes up after the caller was told it timed out.
		release();
		await vi.advanceTimersByTimeAsync(10);
		expect(h.execute).not.toHaveBeenCalled();
	});

	describe("a send deadline (dispatchDeadline, a PM create's)", () => {
		// The monotonic clock the deadline is read on, held still unless a
		// test moves it.
		let clock = 1_000_000;
		beforeEach(() => {
			clock = 1_000_000;
			vi.spyOn(performance, "now").mockImplementation(() => clock);
		});
		afterEach(() => {
			vi.mocked(performance.now).mockRestore();
		});
		// Only the timers: the clock above stays under the test's control.
		const fakeTimers = () =>
			vi.useFakeTimers({
				toFake: [
					"setTimeout",
					"clearTimeout",
					"setInterval",
					"clearInterval",
				],
			});

		it("already passed when the call starts (its claim was slow to take): nothing is connected or sent, and it is not-sent, not a rejection", async () => {
			connected();
			const { executeMcpTool } = await import("../execute-mcp-tool");
			const { isCreateSendDeadlinePassed, isDefiniteMcpCreateRejection } =
				await import("../../../pm-integration/pm-create-claim");

			const res = await executeMcpTool({
				...call,
				sendAtMostOnce: true,
				timeoutMs: 50_000,
				dispatchDeadline: clock - 1,
			});

			expect(h.getClient).not.toHaveBeenCalled();
			expect(h.execute).not.toHaveBeenCalled();
			expect(res).toMatchObject({
				success: false,
				failureKind: "deadline_passed",
			});
			expect(isCreateSendDeadlinePassed(res)).toBe(true);
			expect(isDefiniteMcpCreateRejection(res)).toBe(false);
		});

		it("passing while the connection is set up, before the abort timer has run (a stalled event loop): the clock check refuses the send", async () => {
			fakeTimers();
			// The connection takes 60s of real time, and no timer runs in
			// that time: the abort signal has not fired when it comes up.
			let seenSignal: AbortSignal | undefined;
			h.getClient.mockImplementation(async () => {
				clock += 60_000;
				return {
					client: {
						tools: async () => ({
							create_card: { execute: h.execute },
						}),
					},
					serverName: "Fizzy",
					fromCache: false,
				};
			});
			h.execute.mockImplementation(
				async (_args: unknown, ctx: { abortSignal?: AbortSignal }) => {
					seenSignal = ctx.abortSignal;
					return { id: "1" };
				},
			);
			const { executeMcpTool } = await import("../execute-mcp-tool");

			const res = await executeMcpTool({
				...call,
				sendAtMostOnce: true,
				timeoutMs: 50_000,
				dispatchDeadline: clock + 50_000,
			});

			expect(h.execute).not.toHaveBeenCalled();
			expect(seenSignal).toBeUndefined();
			expect(res.failureKind).toBe("deadline_passed");
		});

		it("runs the tool inside the deadline's scope, so the transport's own check reads it", async () => {
			connected();
			const { currentDispatchDeadline } = await import(
				"@repo/utils/dispatch-deadline"
			);
			let seen: number | undefined;
			h.execute.mockImplementationOnce(async () => {
				seen = currentDispatchDeadline();
				return { id: "1" };
			});
			const { executeMcpTool } = await import("../execute-mcp-tool");

			await executeMcpTool({
				...call,
				sendAtMostOnce: true,
				timeoutMs: 50_000,
				dispatchDeadline: clock + 50_000,
			});

			expect(seen).toBe(clock + 50_000);
		});

		it("a send the transport's deadline check refused (after tool.execute was called) is not-sent, not indeterminate", async () => {
			connected();
			const { DispatchDeadlinePassedError } = await import(
				"@repo/utils/dispatch-deadline"
			);
			h.execute.mockRejectedValueOnce(new DispatchDeadlinePassedError());
			const { executeMcpTool } = await import("../execute-mcp-tool");

			const res = await executeMcpTool({
				...call,
				sendAtMostOnce: true,
				timeoutMs: 50_000,
				dispatchDeadline: clock + 50_000,
			});

			expect(h.execute).toHaveBeenCalledTimes(1);
			expect(res.failureKind).toBe("deadline_passed");
		});

		it("the call's timer ends at the deadline, not a full timeoutMs after the call starts, and a request in flight then is indeterminate", async () => {
			fakeTimers();
			connected();
			let seen: AbortSignal | undefined;
			h.execute.mockImplementation(
				(_args: unknown, ctx: { abortSignal?: AbortSignal }) => {
					seen = ctx.abortSignal;
					return new Promise(() => {});
				},
			);
			const { executeMcpTool } = await import("../execute-mcp-tool");

			// 45s of the ceiling went on taking the claim.
			const promise = executeMcpTool({
				...call,
				sendAtMostOnce: true,
				timeoutMs: 50_000,
				dispatchDeadline: clock + 5_000,
			});
			let settled = false;
			void promise.then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(4_999);
			expect(settled).toBe(false);
			expect(seen?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			const res = await promise;

			expect(seen?.aborted).toBe(true);
			expect(res.failureKind).toBe("indeterminate");
		});
	});

	describe("a connection that closes after the call was sent", () => {
		it("by default the call is resent on a fresh connection (unchanged)", async () => {
			connected();
			h.execute
				.mockRejectedValueOnce(new Error("Connection closed"))
				.mockResolvedValueOnce({ id: "1" });
			const { executeMcpTool } = await import("../execute-mcp-tool");

			const res = await executeMcpTool(call);

			expect(h.execute).toHaveBeenCalledTimes(2);
			expect(res.success).toBe(true);
		});

		it("a failed resend is indeterminate: the first send may have landed", async () => {
			connected();
			h.execute
				.mockRejectedValueOnce(new Error("Connection closed"))
				.mockResolvedValueOnce({
					content: [{ type: "text", text: "Duplicate title" }],
					isError: true,
				});
			const { executeMcpTool } = await import("../execute-mcp-tool");

			const res = await executeMcpTool(call);

			expect(h.execute).toHaveBeenCalledTimes(2);
			expect(res.failureKind).toBe("indeterminate");
		});

		it("with sendAtMostOnce it is not resent, and comes back indeterminate", async () => {
			connected();
			h.execute
				.mockRejectedValueOnce(new Error("Connection closed"))
				.mockResolvedValueOnce({ id: "2" });
			const { executeMcpTool } = await import("../execute-mcp-tool");

			const res = await executeMcpTool({ ...call, sendAtMostOnce: true });

			expect(h.execute).toHaveBeenCalledTimes(1);
			expect(res.success).toBe(false);
			expect(res.failureKind).toBe("indeterminate");
		});
	});
});
