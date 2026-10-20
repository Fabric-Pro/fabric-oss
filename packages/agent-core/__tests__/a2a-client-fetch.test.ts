import { afterEach, describe, expect, it, vi } from "vitest";
import { A2AClient, A2AClientError } from "../src/a2a/client";
import { SecureA2AClient } from "../src/a2a/secure-client";

const baseUrl = "https://agent.example.com";
const message = {
	role: "user" as const,
	parts: [{ type: "text" as const, text: "hello" }],
};
const tenant = { userId: "example-user", organizationId: "example-org" };

function response(url: string) {
	if (url.includes(".well-known")) {
		return Response.json({
			name: "Example",
			url: baseUrl,
			protocolVersion: "0.3.0",
		});
	}
	if (url.endsWith("/stream")) {
		return new Response('data: {"type":"done"}\n\n');
	}
	return Response.json({ id: "example-task", status: "completed" });
}

afterEach(() => vi.unstubAllGlobals());

describe("A2A outbound transport", () => {
	it.each([
		"send",
		"stream",
		"card",
		"legacy card",
		"health",
		"poll",
		"cancel",
		"secure send",
		"secure stream",
	])("injects fetch for %s", async (path) => {
		const globalFetch = vi.fn(() => {
			throw new Error("unexpected global fetch");
		});
		vi.stubGlobal("fetch", globalFetch);
		const injected = vi.fn(async (url: string, _init: RequestInit) =>
			response(url),
		);
		if (path === "legacy card") {
			injected.mockResolvedValueOnce(new Response(null, { status: 404 }));
		}
		const client = new SecureA2AClient({
			fetch: injected,
			serviceToken: "example-secret",
		});
		if (path === "send") {
			await client.sendMessage(baseUrl, message);
		}
		if (path === "stream") {
			for await (const _event of client.sendMessageStream(
				baseUrl,
				message,
			)) {
				/* consume */
			}
		}
		if (path === "card" || path === "legacy card") {
			await client.getAgentCard(baseUrl);
		}
		if (path === "health") {
			expect(await client.healthCheck(baseUrl)).toBe(true);
		}
		if (path === "poll") {
			await client.waitForCompletion(baseUrl, "example-task");
		}
		if (path === "cancel") {
			await client.cancelTask(baseUrl, "example-task");
		}
		if (path === "secure send") {
			await client.sendMessageSecure(baseUrl, message, tenant);
		}
		if (path === "secure stream") {
			for await (const _event of client.sendMessageStreamSecure(
				baseUrl,
				message,
				tenant,
			)) {
				/* consume */
			}
		}
		const paths: Record<string, string[]> = {
			send: ["/a2a/send"],
			stream: ["/a2a/send/stream"],
			card: ["/.well-known/agent-card.json"],
			"legacy card": [
				"/.well-known/agent-card.json",
				"/.well-known/agent.json",
			],
			health: ["/.well-known/agent-card.json"],
			poll: ["/a2a/tasks/example-task"],
			cancel: ["/a2a/tasks/example-task/cancel"],
			"secure send": ["/a2a/send"],
			"secure stream": ["/a2a/send/stream"],
		};
		expect(
			injected.mock.calls.map(([url]) => new URL(url).pathname),
		).toEqual(paths[path]);
		expect(injected.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
		expect(globalFetch).not.toHaveBeenCalled();
	});

	it("uses global fetch by default, including when replaced after construction", async () => {
		const client = new A2AClient();
		const globalFetch = vi.fn(async (url: string) => response(url));
		vi.stubGlobal("fetch", globalFetch);
		await client.sendMessage(baseUrl, message);
		expect(globalFetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		{
			refusal: new Error(
				"Agent endpoint rejected: IPv6 special-use network access is not allowed",
			),
			reason: "Agent endpoint rejected: IPv6 special-use network access is not allowed",
		},
		{
			refusal: new TypeError("fetch failed", {
				cause: Object.assign(
					new Error(
						"Blocked outbound connection to agent.example.com: Private network access is not allowed",
					),
					{ code: "EACCES" },
				),
			}),
			reason: "Blocked outbound connection to agent.example.com: Private network access is not allowed",
		},
		{
			refusal: new TypeError("fetch failed", {
				cause: new Error("unexpected redirect"),
			}),
			reason: "unexpected redirect",
		},
	])(
		"preserves the refusal reason without retrying: $reason",
		async ({ refusal, reason }) => {
			const injected = vi.fn().mockRejectedValue(refusal);
			vi.stubGlobal("fetch", injected);
			const client = new A2AClient({ fetch: injected, retryDelay: 1 });
			const outcome = await client
				.sendMessage(baseUrl, message)
				.catch((error: unknown) => error);
			expect(outcome).toBeInstanceOf(A2AClientError);
			expect.soft(outcome).toMatchObject({
				message: `Network request to ${baseUrl}/a2a/send refused: ${reason}`,
				details: { cause: reason, attempts: 1 },
			});
			expect(injected).toHaveBeenCalledTimes(1);
		},
	);

	it("still retries an unclassified fetch failure", async () => {
		const injected = vi
			.fn()
			.mockRejectedValue(new TypeError("fetch failed"));
		vi.stubGlobal("fetch", injected);
		const client = new A2AClient({ fetch: injected, retryDelay: 1 });
		await expect(
			client.sendMessage(baseUrl, message),
		).rejects.toMatchObject({
			message: `Network request to ${baseUrl}/a2a/send failed after 3 attempt(s): fetch failed`,
			details: {
				cause: "Network request failed - check if agent is running and accessible",
				attempts: 3,
			},
		});
		expect(injected).toHaveBeenCalledTimes(3);
	});
});
