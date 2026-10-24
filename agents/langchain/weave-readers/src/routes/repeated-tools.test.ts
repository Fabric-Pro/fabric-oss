import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ outputs: [] as unknown[], attempts: 0 }));
vi.mock("../lib/llm.js", () => ({
	resolveReaderModel: async () => ({
		model: {},
		provider: "OPENAI",
		modelString: "example-model",
	}),
}));
vi.mock("../tools/web-search.js", () => ({
	createWebSearchTools: () => ({
		search: { execute: async () => "example result" },
	}),
}));
vi.mock("ai", async () => ({
	...(await vi.importActual<typeof import("ai")>("ai")),
	generateText: async ({ tools }: { tools: Record<string, any> }) => {
		state.attempts++;
		for (const toolCallId of ["first", "second"]) {
			const input = { query: "example" };
			const output = await tools.search.execute(input, { toolCallId });
			expect(output).toBe("example result");
			state.outputs.push(
				tools.search.toModelOutput?.({ input, output, toolCallId }) ?? {
					type: "text",
					value: output,
				},
			);
			if (state.attempts === 1) {
				throw new Error("503 example retry");
			}
		}
		return { text: "done" };
	},
}));

import { spindleRoute } from "./spindle.js";

it("starts retry attempts with fresh repeat state and detects repeats within the retry", async () => {
	const response = await spindleRoute.request("/research", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			message: "example research",
			metadata: {
				tenantContext: {
					userId: "example-user",
					organizationId: "example-org",
				},
			},
		}),
	});
	expect(response.status).toBe(200);
	expect(state.attempts).toBe(2);
	expect(state.outputs[0]).toEqual({ type: "text", value: "example result" });
	expect(state.outputs[1]).toEqual(state.outputs[0]);
	expect(state.outputs[2]).toEqual({
		type: "text",
		value: expect.stringContaining("same result"),
	});
});
