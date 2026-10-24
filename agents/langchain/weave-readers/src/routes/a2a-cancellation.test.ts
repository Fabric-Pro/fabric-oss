import { afterEach, expect, it, vi } from "vitest";

const { generateText, executeTool } = vi.hoisted(() => ({
	generateText: vi.fn(),
	executeTool: vi.fn(async () => "unused"),
}));
vi.mock("ai", async () => ({
	...(await vi.importActual<typeof import("ai")>("ai")),
	generateText,
}));
vi.mock("../lib/llm.js", () => ({
	resolveReaderModel: async () => ({
		model: {},
		provider: "OPENAI",
		modelString: "example-model",
	}),
}));

vi.mock("../tools/web-search.js", () => ({
	createWebSearchTools: () => ({ example: { execute: executeTool } }),
}));

import { a2aRoute } from "./a2a.js";

function post(signal: AbortSignal, skillId = "thread") {
	return Promise.resolve(
		a2aRoute.request("/send", {
			method: "POST",
			signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				message: "hello",
				metadata: {
					skillId,
					tenantContext: {
						userId: "example-user",
						organizationId: "example-org",
					},
				},
			}),
		}),
	);
}
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	generateText.mockReset();
	executeTool.mockClear();
});

it("forwards request abort to generateText and starts no retry after abort", async () => {
	vi.useFakeTimers();
	const controller = new AbortController();
	generateText.mockImplementation(async () => {
		controller.abort();
		throw new Error("503 aborted request");
	});
	const pending = post(controller.signal);
	await vi.runAllTimersAsync();
	const response = await pending;
	expect(generateText.mock.calls[0][0].abortSignal?.aborted).toBe(true);
	expect(generateText).toHaveBeenCalledTimes(1);
	expect(
		((await response.json()) as { task: { status: string } }).task.status,
	).toBe("canceled");
});

it("interrupts retry backoff on disconnect", async () => {
	vi.useFakeTimers();
	generateText.mockRejectedValue(new Error("503 temporary failure"));
	const controller = new AbortController();
	let backingOff!: () => void;
	const backoff = new Promise<void>((resolve) => {
		backingOff = resolve;
	});
	vi.spyOn(console, "warn").mockImplementation(() => backingOff());
	let settled = false;
	const pending = post(controller.signal).then((response) => {
		settled = true;
		return response;
	});
	await backoff;
	controller.abort();
	await vi.advanceTimersByTimeAsync(0);
	expect(settled).toBe(true);
	expect(generateText).toHaveBeenCalledTimes(1);
	expect(vi.getTimerCount()).toBe(0);
	expect(
		((await (await pending).json()) as { task: { status: string } }).task
			.status,
	).toBe("canceled");
});

it("refuses tool dispatch after the request aborts", async () => {
	const controller = new AbortController();
	generateText.mockImplementation(async (options) => {
		controller.abort();
		await options.tools.example.execute({});
		return { text: "late" };
	});
	await post(controller.signal, "spindle");
	expect(executeTool).not.toHaveBeenCalled();
});
