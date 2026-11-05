import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabricksApiClient } from "../src/api-client";

const WORKSPACE = "https://example.azuredatabricks.net";
const TOKEN = "synthetic-test-token";

function fixture(host = WORKSPACE) {
	const fetchImpl = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response("{}"));
	const tokenProvider = {
		getToken: vi.fn().mockResolvedValue(TOKEN),
		invalidate: vi.fn(),
	};
	return {
		fetchImpl,
		tokenProvider,
		client: new DatabricksApiClient({ host, fetchImpl, tokenProvider }),
	};
}

describe("Databricks API workspace-relative URL validation", () => {
	it.each([
		".evil.example/api",
		"@evil.example/api",
		"https://evil.example/api",
		"api/2.0/clusters/list",
		"//evil.example/api",
		"///evil.example/api",
		"/\\evil.example/api",
		"/api\\redirect",
		"/api\r\n/redirect",
		"\t/api/2.0/clusters/list",
		"/api\u0000/redirect",
		"/api\u0085/redirect",
	])(
		"refuses unsafe path %j before acquiring or sending a token",
		async (path) => {
			const { client, tokenProvider, fetchImpl } = fixture();
			await expect(client.request("GET", path)).rejects.toBeInstanceOf(
				TypeError,
			);
			expect(tokenProvider.getToken).not.toHaveBeenCalled();
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it.each([
		"https://user:password@example.azuredatabricks.net",
		"https://example.azuredatabricks.net/proxy",
		"https://example.azuredatabricks.net?destination=example",
		"https://example.azuredatabricks.net#example",
		" https://example.azuredatabricks.net",
		"https://example.azuredatabricks.net\n",
		"https://example.azuredatabricks.net\\evil",
		"file:///example",
		"not a host",
	])(
		"refuses invalid configured origin %j before acquiring a token",
		async (host) => {
			const { client, tokenProvider, fetchImpl } = fixture(host);
			await expect(
				client.request("GET", "/api/2.0/clusters/list"),
			).rejects.toBeInstanceOf(TypeError);
			expect(tokenProvider.getToken).not.toHaveBeenCalled();
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);

	it("preserves a workspace-relative path, encoded identifiers and query parameters", async () => {
		const { client, fetchImpl } = fixture(`${WORKSPACE}/`);
		await client.request(
			"GET",
			"/api/2.0/example/id%2Fpart?q=hello%20world&limit=2",
		);
		expect(fetchImpl).toHaveBeenCalledWith(
			`${WORKSPACE}/api/2.0/example/id%2Fpart?q=hello%20world&limit=2`,
			expect.objectContaining({ redirect: "error" }),
		);
	});

	it("applies the same URL validation to raw requests", async () => {
		const { client, fetchImpl } = fixture();
		await expect(
			client.requestRaw("POST", "@evil.example/api", { body: "example" }),
		).rejects.toBeInstanceOf(TypeError);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("Databricks API raw request header normalization", () => {
	it.each(["object", "headers", "tuple"])(
		"preserves %s headers while replacing caller Authorization",
		async (representation) => {
			const { client, fetchImpl } = fixture();
			const pairs: [string, string][] = [
				["X-Example-Request", "example-value"],
				["Authorization", "Bearer caller-supplied"],
			];
			const headers =
				representation === "headers"
					? new Headers(pairs)
					: representation === "tuple"
						? pairs
						: Object.fromEntries(pairs);
			await client.requestRaw("POST", "/api/2.0/example", {
				headers,
				body: "example",
				redirect: "follow",
			});
			const sent = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
			expect(sent.get("X-Example-Request")).toBe("example-value");
			expect(sent.get("Authorization")).toBe(`Bearer ${TOKEN}`);
			expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
			expect(new Headers(headers).get("Authorization")).toBe(
				"Bearer caller-supplied",
			);
		},
	);
});

describe("Databricks API empty response cleanup", () => {
	it.each([200, 204])(
		"cancels an unread body before returning undefined for status %s",
		async (status) => {
			const { client, fetchImpl } = fixture();
			const cancel = vi.fn();
			const stream = new ReadableStream({ cancel });
			// A custom fetch can supply a body even when HTTP declares it empty.
			const response = {
				status,
				ok: true,
				headers: new Headers(
					status === 200 ? { "Content-Length": "0" } : {},
				),
				body: stream,
			};
			fetchImpl.mockResolvedValueOnce(response as Response);
			await expect(
				client.request("GET", "/api/2.0/example"),
			).resolves.toBeUndefined();
			expect(cancel).toHaveBeenCalledTimes(1);
		},
	);
});

const servers: Server[] = [];

async function listen(server: Server): Promise<string> {
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Local HTTP fixture did not expose a TCP port");
	}
	return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.closeAllConnections();
					server.close((error) =>
						error ? reject(error) : resolve(),
					);
				}),
		),
	);
});

describe("Databricks API redirects over real local HTTP", () => {
	it("does not follow a workspace response to another origin", async () => {
		let redirectedRequests = 0;
		const destination = await listen(
			createServer((_request, response) => {
				redirectedRequests++;
				response.end("{}");
			}),
		);
		const workspaceHeaders: (string | undefined)[] = [];
		const workspace = await listen(
			createServer((request, response) => {
				workspaceHeaders.push(request.headers.authorization);
				response.writeHead(302, { Location: `${destination}/outside` });
				response.end("redirect");
			}),
		);
		const client = new DatabricksApiClient({
			host: workspace,
			tokenProvider: {
				getToken: async () => TOKEN,
				invalidate: () => undefined,
			},
		});
		await expect(
			client.request("GET", "/api/2.0/example", undefined, {
				signal: AbortSignal.timeout(5000),
			}),
		).rejects.toBeInstanceOf(TypeError);
		expect(workspaceHeaders).toEqual([`Bearer ${TOKEN}`]);
		expect(redirectedRequests).toBe(0);
	});
});
