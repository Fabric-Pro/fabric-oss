import { expect, it, vi } from "vitest";

vi.mock("../plugins/registry", () => ({
	findActionById: (type: string) =>
		type === "ai-generate-text"
			? {
					outputFields: [
						{ field: "text", description: "Generated text" },
					],
				}
			: undefined,
}));
vi.mock("../node-definitions", () => ({ getNodeDefinition: () => undefined }));

import { workflowOutputOptions } from "../output-options";

const node = (id: string, type = "ai-generate-text", label = id) => ({
	id,
	type,
	position: { x: 0, y: 0 },
	data: { label, config: {} },
});
it("offers only upstream outputs with stable IDs even when display names change", () => {
	const nodes = [
		node("start", "trigger"),
		node("summary", "ai-generate-text", "Summary renamed"),
		node("plan"),
		node("unconnected"),
	];
	const edges = [
		{ id: "a", source: "start", target: "summary" },
		{ id: "b", source: "summary", target: "plan" },
	];
	expect(workflowOutputOptions("plan", nodes, edges)).toEqual([
		{
			label: "data",
			value: "{{$start.data}}",
			description: "Trigger input",
			category: "start",
		},
		{
			label: "text",
			value: "{{$summary.text}}",
			description: "Generated text",
			category: "Summary renamed",
		},
	]);
});
it("terminates on cycles and never offers itself", () => {
	expect(
		workflowOutputOptions(
			"a",
			[node("a"), node("b")],
			[
				{ id: "a", source: "a", target: "b" },
				{ id: "b", source: "b", target: "a" },
			],
		).map((v) => v.value),
	).toEqual(["{{$b.text}}"]);
});
