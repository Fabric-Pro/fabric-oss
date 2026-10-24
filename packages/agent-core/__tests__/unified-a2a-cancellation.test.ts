import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type AgentRuntimeConfig,
	createUnifiedServer,
} from "../src/unified-server";

beforeEach(() => {
	vi.stubEnv("AGENT_API_KEY", "");
	vi.stubEnv("AGENT_API_KEYS", "");
	vi.stubEnv("AGENT_HMAC_SECRET", "");
});
afterEach(() => vi.unstubAllEnvs());

it.each(["/a2a/send", "/a2a/send/stream"])(
	"forwards disconnects from %s to the invoke fallback",
	async (path) => {
		let started!: (signal: AbortSignal | undefined) => void;
		const received = new Promise<AbortSignal | undefined>((resolve) => {
			started = resolve;
		});
		const { app } = createUnifiedServer(
			{
				name: "example-agent",
				description: "Example",
				baseUrl: "http://example.com",
				port: 3000,
				skills: [],
			},
			async (_input, config) => {
				started(config?.signal);
				return new Promise((resolve) => {
					config?.signal?.addEventListener(
						"abort",
						() => resolve({ response: "late" }),
						{ once: true },
					);
				});
			},
			(result) => ({ response: String(result.response) }),
		);
		const controller = new AbortController();
		const pending = app.request(path, {
			method: "POST",
			signal: controller.signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: {
					role: "user",
					parts: [{ type: "text", text: "hello" }],
				},
			}),
		});
		const signal = await received;
		controller.abort();
		const response = await pending;
		expect(signal?.aborted).toBe(true);
		if (path.endsWith("stream")) {
			expect(await response.text()).toContain('"status":"canceled"');
		} else {
			const { task } = await response.json();
			expect(task.status).toBe("canceled");
		}
	},
);

it("passes the request signal to a supplied A2A stream executor", async () => {
	let started!: (config: AgentRuntimeConfig | undefined) => void;
	const received = new Promise<AgentRuntimeConfig | undefined>((resolve) => {
		started = resolve;
	});
	const { app } = createUnifiedServer(
		{
			name: "example-agent",
			description: "Example",
			baseUrl: "http://example.com",
			port: 3000,
			skills: [],
		},
		async () => ({ response: "unused" }),
		() => ({ response: "unused" }),
		async function* (_input, config) {
			started(config);
			yield { type: "text", content: "hello" };
		},
	);
	const controller = new AbortController();
	const response = await app.request("/a2a/send/stream", {
		method: "POST",
		signal: controller.signal,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			message: { role: "user", parts: [{ type: "text", text: "hello" }] },
		}),
	});
	expect((await received)?.signal).toBeDefined();
	expect(await response.text()).toContain('"status":"completed"');
});
