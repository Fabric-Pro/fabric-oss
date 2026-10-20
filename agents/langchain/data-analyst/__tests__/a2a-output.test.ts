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
vi.mock("../lib/agent/graph.js", () => ({
	createDataAnalystGraph: () => ({}),
}));
import "../unified-server";
describe("A2A output", () => {
	it("reports a terminal graph failure", () => {
		expect(
			h.transform?.({
				error: "Provider failure detail",
				response: "Unable to analyze the data. Please try again.",
				messages: [],
				artifacts: [],
				connectionSuggestions: [],
			}),
		).toMatchObject({
			error: "Unable to analyze the data. Please try again.",
		});
	});
	it("keeps a usable answer completed", () => {
		expect(
			h.transform?.({
				response: "Analysis completed",
				messages: [],
				artifacts: [],
				connectionSuggestions: [],
				error: null,
			})?.error,
		).toBeUndefined();
	});
});
