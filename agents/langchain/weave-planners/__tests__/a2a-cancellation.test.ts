import { afterEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../src/pattern/agent.js", () => ({ patternGraph: { invoke } }));
vi.mock("@hono/node-server", () => ({ serve: vi.fn(() => ({})) }));
vi.mock("@repo/agent-runtime", () => ({
	serviceAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("@repo/observability/http-server", () => ({
	registerHttpServerShutdown: vi.fn(),
}));

import app from "../src/index.js";

afterEach(() => invoke.mockReset());

it.each(["/a2a/send", "/pattern"])(
	"passes %s disconnects into the Pattern graph",
	async (path) => {
		let started!: (signal: AbortSignal | undefined) => void;
		const received = new Promise<AbortSignal | undefined>((resolve) => {
			started = resolve;
		});
		let finish!: () => void;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		invoke.mockImplementation(async (_input, config) => {
			started(config?.signal);
			await gate;
			return { checkboxes: [], analysis: "example" };
		});
		const controller = new AbortController();
		const pending = app.request(path, {
			method: "POST",
			signal: controller.signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: { parts: [{ text: "hello" }] },
				metadata: {
					tenantContext: {
						userId: "example-user",
						organizationId: "example-org",
					},
					projectContext: {
						projectId: "example-project",
						projectName: "Example",
					},
				},
			}),
		});
		const signal = await received;
		controller.abort();
		finish();
		const response = await pending;
		expect(response.status).toBe(500);
		expect(signal?.aborted).toBe(true);
		expect(invoke).toHaveBeenCalledTimes(1);
	},
);
