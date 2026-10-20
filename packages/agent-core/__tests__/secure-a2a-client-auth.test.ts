import { verifySignedTenantRequest } from "@repo/agent-runtime";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecureA2AClient } from "../src/a2a/secure-client";
import { createAuthMiddleware } from "../src/middleware/auth";

const message = {
	role: "user" as const,
	parts: [{ type: "text" as const, text: "Plan this task" }],
};
const tenant = { userId: "example-user", organizationId: "example-org" };

function setup() {
	const app = new Hono();
	app.use("*", createAuthMiddleware({ apiKeys: ["example-agent-key"] }));
	app.post("/a2a/send", async (c) => {
		const body = await c.req.json();
		return c.json({
			task: {
				id: "example-task",
				status: "completed",
				messages: [body.message],
			},
		});
	});
	app.post(
		"/a2a/send/stream",
		() =>
			new Response("", {
				headers: { "Content-Type": "text/event-stream" },
			}),
	);
	const statuses: number[] = [];
	const headers: Headers[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const request = new Request(input, init);
			headers.push(request.headers);
			const response = await app.fetch(request);
			statuses.push(response.status);
			return response;
		}),
	);
	return {
		client: new SecureA2AClient({
			serviceToken: "example-service-token",
			retryAttempts: 1,
		}),
		statuses,
		headers,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("SecureA2AClient agent authentication", () => {
	it("passes the real auth middleware with an explicit trimmed key", async () => {
		const { client, statuses } = setup();
		await expect(
			client.sendMessageSecure(
				"https://agent.example.com",
				message,
				tenant,
				{
					agentApiKey: "  example-agent-key  ",
					trustedDestination: true,
				},
			),
		).resolves.toMatchObject({ id: "example-task", status: "completed" });
		expect(statuses).toEqual([200]);
	});

	it.each([undefined, "", "   "])(
		"gets 401 without a non-empty per-call key (%j)",
		async (agentApiKey) => {
			vi.stubEnv("AGENT_API_KEY", "example-agent-key");
			const { client, statuses, headers } = setup();
			await expect(
				client.sendMessageSecure(
					"https://agent.example.com",
					message,
					tenant,
					{
						agentApiKey,
					},
				),
			).rejects.toThrow("401");
			expect(statuses).toEqual([401]);
			expect(headers[0].has("Authorization")).toBe(false);
			expect(JSON.stringify(Array.from(headers[0]))).not.toContain(
				"example-agent-key",
			);
		},
	);

	it("does not retain a key for subsequent calls", async () => {
		const { client, statuses } = setup();
		await client.sendMessageSecure(
			"https://agent.example.com",
			message,
			tenant,
			{ agentApiKey: "example-agent-key", trustedDestination: true },
		);
		await expect(
			client.sendMessageSecure(
				"https://external.example.com",
				message,
				tenant,
			),
		).rejects.toThrow("401");
		expect(statuses).toEqual([200, 401]);
	});

	it("authenticates streaming requests only with an explicit key", async () => {
		const { client, statuses } = setup();
		for await (const _event of client.sendMessageStreamSecure(
			"https://agent.example.com",
			message,
			tenant,
			{ agentApiKey: "example-agent-key", trustedDestination: true },
		)) {
			// The authenticated handler returns an empty stream.
		}
		await expect(async () => {
			for await (const _event of client.sendMessageStreamSecure(
				"https://external.example.com",
				message,
				tenant,
			)) {
				// Authentication must reject before yielding an event.
			}
		}).rejects.toThrow("401");
		expect(statuses).toEqual([200, 401]);
	});
});

const serviceSecret = "example-service-secret-for-a2a-tests";
const serviceHeaders = [
	"X-Service-Token",
	"X-Tenant-Payload",
	"X-Tenant-Signature",
	"X-Tenant-Timestamp",
];

describe.each(["send", "stream"] as const)(
	"service credential boundary (%s)",
	(mode) => {
		async function send(
			client: SecureA2AClient,
			options?: { trustedDestination?: boolean; agentApiKey?: string },
		) {
			if (mode === "send") {
				await client.sendMessageSecure(
					"https://agent.example.com",
					message,
					tenant,
					options,
				);
			} else {
				for await (const _event of client.sendMessageStreamSecure(
					"https://agent.example.com",
					message,
					tenant,
					options,
				)) {
					// An empty stream is enough to inspect the outbound request.
				}
			}
		}

		function capture() {
			vi.stubEnv("AGENT_SERVICE_SECRET", serviceSecret);
			const headers: Headers[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_input: unknown, init?: RequestInit) => {
					headers.push(new Headers(init?.headers));
					return mode === "stream"
						? new Response("", {
								headers: {
									"Content-Type": "text/event-stream",
								},
							})
						: Response.json({
								task: {
									id: "example-task",
									status: "completed",
									messages: [],
								},
							});
				}),
			);
			return {
				client: new SecureA2AClient({
					sourceAgent: "example-source",
					retryAttempts: 1,
				}),
				headers,
			};
		}

		it.each([undefined, false])(
			"withholds the service credential unless opted in (%j)",
			async (trustedDestination) => {
				const { client, headers } = capture();
				await send(
					client,
					trustedDestination === undefined
						? undefined
						: { trustedDestination },
				);
				expect(headers).toHaveLength(1);
				for (const name of serviceHeaders) {
					expect.soft(headers[0].has(name), name).toBe(false);
				}
				expect
					.soft(JSON.stringify(Array.from(headers[0])))
					.not.toContain(serviceSecret);
				expect(headers[0].get("X-Tenant-User-ID")).toBe(tenant.userId);
				expect(headers[0].get("X-Tenant-Organization-ID")).toBe(
					tenant.organizationId,
				);
				expect(headers[0].get("X-Source-Agent")).toBe("example-source");
			},
		);

		it("preserves signed tenant authentication for a trusted destination", async () => {
			const { client, headers } = capture();
			await send(client, { trustedDestination: true });
			expect(headers).toHaveLength(1);
			for (const name of serviceHeaders) {
				expect(headers[0].has(name), name).toBe(true);
			}
			expect(headers[0].get("X-Service-Token")).toBe(serviceSecret);
			expect(verifySignedTenantRequest(headers[0])).toEqual({
				ok: true,
				...tenant,
				impersonated: false,
			});
			// Trust applies to this call only, even when the client is reused.
			await send(client);
			for (const name of serviceHeaders) {
				expect.soft(headers[1].has(name), name).toBe(false);
			}
		});

		it.each([undefined, false])(
			"rejects a non-empty agent key before sending when trust is %j",
			async (trustedDestination) => {
				const { client, headers } = capture();
				await expect(
					send(client, {
						agentApiKey: " example-agent-key ",
						trustedDestination,
					}),
				).rejects.toThrow("trustedDestination");
				expect(headers).toEqual([]);
				expect(fetch).not.toHaveBeenCalled();
			},
		);
	},
);
