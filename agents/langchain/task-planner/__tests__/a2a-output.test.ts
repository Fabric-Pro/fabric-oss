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
vi.mock("../agent.js", () => ({ taskPlannerGraph: {} }));
import "../unified-server";
describe("A2A output", () => {
	it("reports a terminal graph failure", () => {
		expect(
			h.transform?.({
				error: "Analysis failed",
				document: "",
				messages: [{ role: "user", content: "Plan this task" }],
				decomposedTasks: [],
				riskAnalysis: undefined,
				dependencyGraph: undefined,
				executionPlan: undefined,
			}),
		).toMatchObject({ error: "Analysis failed" });
	});
	it("keeps a usable answer completed", () => {
		expect(
			h.transform?.({
				document: "Generated plan",
				messages: [],
				decomposedTasks: [],
				riskAnalysis: undefined,
				dependencyGraph: undefined,
				executionPlan: undefined,
				error: undefined,
			})?.error,
		).toBeUndefined();
	});
	it("keeps a fallback document completed despite its warning", () => {
		expect(
			h.transform?.({
				error: "Document generation failed",
				document: "Usable fallback plan",
			})?.error,
		).toBeUndefined();
	});
});
