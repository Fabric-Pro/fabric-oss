import { describe, expect, it, vi } from "vitest";
import { probeGitLabMcp } from "../../src/gitlab/probe-mcp";

describe("probeGitLabMcp", () => {
	it("returns capable=true on 200", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			),
		);

		const result = await probeGitLabMcp({
			baseUrl: "https://gitlab.com",
			accessToken: "token-abc",
			fetchImpl,
		});

		expect(result).toEqual({
			capable: true,
			status: "ok",
			httpStatus: 200,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://gitlab.com/api/v4/mcp");
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			Authorization: "Bearer token-abc",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(init.body as string)).toMatchObject({
			jsonrpc: "2.0",
			method: "initialize",
		});
	});
});

describe("probeGitLabMcp status mapping", () => {
	it.each([
		[401, "unauthorized"],
		[403, "unauthorized"],
		[404, "not-found"],
		[500, "not-found"],
	])("HTTP %i → status %s", async (httpStatus, status) => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("", { status: httpStatus }));
		const result = await probeGitLabMcp({
			baseUrl: "https://gitlab.com",
			accessToken: "t",
			fetchImpl,
		});
		expect(result).toEqual({ capable: false, status, httpStatus });
	});

	it("returns timeout when fetch is aborted", async () => {
		const fetchImpl = vi
			.fn()
			.mockImplementation((_url, init?: RequestInit) => {
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						const err = new Error("aborted");
						err.name = "AbortError";
						reject(err);
					});
				});
			});
		const result = await probeGitLabMcp({
			baseUrl: "https://gitlab.com",
			accessToken: "t",
			fetchImpl,
			timeoutMs: 10,
		});
		expect(result).toEqual({
			capable: false,
			status: "timeout",
			httpStatus: null,
		});
	});

	it("returns network-error on fetch throw", async () => {
		const fetchImpl = vi
			.fn()
			.mockRejectedValue(new TypeError("fetch failed"));
		const result = await probeGitLabMcp({
			baseUrl: "https://gitlab.com",
			accessToken: "t",
			fetchImpl,
		});
		expect(result).toEqual({
			capable: false,
			status: "network-error",
			httpStatus: null,
		});
	});
});
