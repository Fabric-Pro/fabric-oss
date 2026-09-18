/**
 * A redirecting MCP server has to read as a redirecting MCP server.
 *
 * Every MCP transport uses the repository's guarded fetch, which refuses
 * redirects because `serverUrl` is tenant-configured and a redirect could land
 * on a host that never passed the destination checks.
 *
 * The cost of keeping it is legibility. `fetch(url, { redirect: "error" })`
 * rejects with a bare `TypeError: fetch failed` and puts `unexpected redirect`
 * on `cause`, which is indistinguishable from an unreachable server unless the
 * chain is read — and "cannot connect" sends whoever configured the
 * integration hunting an outage rather than fixing a URL.
 */

import { describe, expect, it, vi } from "vitest";

const createMCPClientMock = vi.fn();

vi.mock("@ai-sdk/mcp", () => ({
	createMCPClient: (...args: unknown[]) => createMCPClientMock(...args),
}));

vi.mock("@repo/database", () => ({
	getMcpConfigById: vi.fn(),
	getValidAccessToken: vi.fn(),
}));

vi.mock("../server-url-guard", () => ({
	assertMcpServerUrlResolved: vi.fn(),
	fetchMcpServer: vi.fn(),
}));

import { createMcpClient, McpClientError } from "../client";

function rejectWith(error: Error) {
	createMCPClientMock.mockImplementation(async () => {
		throw error;
	});
}

const authProvider = {
	get redirectUrl() {
		return "https://example.com/callback";
	},
} as never;

/**
 * Connect and return the error it failed with.
 *
 * Every test stages its own implementation, so there is deliberately no
 * `beforeEach` reset: under Vitest 4, a mock reset or clear hook sitting
 * alongside a rejecting implementation gets the rejection reported as
 * unhandled and fails the test even though the code under test catches it.
 */
async function connectExpectingFailure(): Promise<McpClientError> {
	const result = await createMcpClient({
		serverUrl: "https://mcp.example.com/sse",
		transport: "HTTP",
		authProvider,
	}).then(
		() => undefined,
		(error: unknown) => error,
	);

	expect(result).toBeInstanceOf(McpClientError);
	return result as McpClientError;
}

describe("createMcpClient — refused redirect on the guarded transport", () => {
	it("says the server redirected rather than that it could not be reached", async () => {
		// The exact shape undici produces for a refused redirect.
		rejectWith(
			new TypeError("fetch failed", {
				cause: new Error("unexpected redirect"),
			}),
		);

		const error = await connectExpectingFailure();

		expect(error.code).toBe("CONNECTION_ERROR");
		expect(error.message).toContain("redirected");
		expect(error.message).toContain("not followed");
		// The bare fetch message must not be what surfaces.
		expect(error.message).not.toContain("fetch failed");
	});

	it("still reports an ordinary unreachable server as a plain connection error", async () => {
		// Same top-level message, no redirect on the cause chain. This is the
		// case a naive `message.includes("fetch failed")` check would
		// misreport as a redirect.
		rejectWith(
			new TypeError("fetch failed", {
				cause: new Error("getaddrinfo ENOTFOUND mcp.example.com"),
			}),
		);

		const error = await connectExpectingFailure();

		expect(error.code).toBe("CONNECTION_ERROR");
		expect(error.message).not.toContain("redirected");
		expect(error.message).toContain("fetch failed");
	});

	it("keeps an auth failure an auth failure", async () => {
		// The redirect branch runs before the 401 branch, so it must not
		// swallow the case that path already handled.
		rejectWith(new Error("HTTP 401 Unauthorized"));

		const error = await connectExpectingFailure();

		expect(error.code).toBe("OAUTH_AUTH_REQUIRED");
		expect(error.isAuthError).toBe(true);
	});
});
