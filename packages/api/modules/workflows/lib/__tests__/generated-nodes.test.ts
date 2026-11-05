import { describe, expect, it } from "vitest";
import { normalizeGeneratedNodes } from "../generated-nodes";

describe("AI-generated node shorthand", () => {
	it("moves flat labels and config into data without inventing step settings", () => {
		const config = { aiPrompt: "Summarize supplied notes" };
		expect(
			normalizeGeneratedNodes([
				{
					id: "example-ai",
					type: "ai-generate-text",
					position: { x: 0, y: 150 },
					label: "Brief",
					config,
				},
			]),
		).toEqual([
			{
				id: "example-ai",
				type: "ai-generate-text",
				position: { x: 0, y: 150 },
				data: { label: "Brief", config },
			},
		]);
	});
	it("preserves nested nodes and leaves invalid shapes for the schema to reject", () => {
		const nested = { id: "example-node", data: { label: "Start" } };
		const invalid = { id: "example-invalid", type: "trigger" };
		expect(normalizeGeneratedNodes([nested, invalid, null])).toEqual([
			nested,
			invalid,
			null,
		]);
		expect(normalizeGeneratedNodes([nested])?.[0]).toBe(nested);
	});
});
