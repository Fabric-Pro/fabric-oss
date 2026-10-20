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
vi.mock("../agent.js", () => ({ predictiveStateUpdatesGraph: {} }));
import "../unified-server";
describe("A2A output", () => {
	it("reports a terminal graph failure", () => {
		expect(
			h.transform?.({
				error: "Failed to generate document: Provider failure",
				document: "",
				streamingContent: "",
			}),
		).toMatchObject({
			error: "Failed to generate document: Provider failure",
		});
	});
	it("keeps a usable answer completed", () => {
		expect(
			h.transform?.({
				document: "Generated document",
				streamingContent: "Generated document",
				error: undefined,
			})?.error,
		).toBeUndefined();
	});
	it("fails even with the pre-existing input document", () => {
		expect(
			h.transform?.({
				error: "Unable to answer",
				document: "Original input",
			})?.error,
		).toBe("Unable to answer");
	});
});
