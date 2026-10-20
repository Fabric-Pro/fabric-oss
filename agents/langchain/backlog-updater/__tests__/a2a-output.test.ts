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
vi.mock("../agent.js", () => ({ backlogUpdaterGraph: {} }));
import "../unified-server";
describe("A2A output", () => {
	it("reports a terminal graph failure", () => {
		expect(
			h.transform?.({
				error: "Failed to process request: Provider failure",
				messages: [{ role: "user", content: "Update the backlog" }],
				analysisStatus: undefined,
				lastProposalSummary: undefined,
			}),
		).toMatchObject({
			error: "Failed to process request: Provider failure",
		});
	});
	it("keeps a usable answer completed", () => {
		expect(
			h.transform?.({
				messages: [
					{
						role: "assistant",
						content: "Backlog analysis completed",
					},
				],
				analysisStatus: undefined,
				lastProposalSummary: undefined,
				error: undefined,
			})?.error,
		).toBeUndefined();
	});
});
