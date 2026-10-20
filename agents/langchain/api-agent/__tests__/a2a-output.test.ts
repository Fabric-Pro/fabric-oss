import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	transform: undefined as
		| undefined
		| ((output: Record<string, unknown>) => {
				response: string;
				error?: string;
		  }),
}));
vi.mock("@repo/agent-core", async (original) => ({
	...(await original<Record<string, unknown>>()),
	createUnifiedServer: (
		_config: unknown,
		_invoke: unknown,
		transform: typeof h.transform,
	) => {
		h.transform = transform;
		return { app: {}, start: () => {} };
	},
}));
vi.mock("../agent.js", () => ({ apiAgentGraph: {} }));
import "../unified-server";
describe("A2A output", () => {
	it("reports a terminal graph failure", () => {
		expect(
			h.transform?.({
				error: "Provider failure detail",
				response: "The API call failed. Please try again.",
				messages: [],
				executionResult: undefined,
				selectedTool: undefined,
			}),
		).toMatchObject({ error: "The API call failed. Please try again." });
	});
	it("keeps a usable answer completed", () => {
		expect(
			h.transform?.({
				response: "API call completed",
				messages: [],
				executionResult: undefined,
				selectedTool: undefined,
				error: undefined,
			})?.error,
		).toBeUndefined();
	});
});
