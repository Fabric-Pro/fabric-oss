import { describe, expect, it } from "vitest";
import { renderInstanceReport } from "../src/activities/template-instance";

const baseInput = {
	instance: { name: "UAT Report", description: null },
	template: { name: "Board Report", definition: { sections: [] } },
	dataResults: [],
	aiResults: [],
	outputFormat: "MARKDOWN" as const,
};

describe("renderInstanceReport partial notice", () => {
	it("prepends a partial-data notice when isPartial is true (markdown)", async () => {
		const out = await renderInstanceReport({
			...baseInput,
			isPartial: true,
		});
		expect(out.markdown).toMatch(/partial data/i);
	});

	it("omits the notice on a complete run", async () => {
		const out = await renderInstanceReport({
			...baseInput,
			isPartial: false,
		});
		expect(out.markdown).not.toMatch(/partial data/i);
	});

	it("prepends the notice in HTML format", async () => {
		const out = await renderInstanceReport({
			...baseInput,
			outputFormat: "HTML",
			isPartial: true,
		});
		expect(out.markdown).toMatch(/partial data/i);
	});
});

describe("delivery starter default analysis", () => {
	const sections = [
		{ id: "progress", title: "Progress", type: "ai-generated", config: {} },
		{ id: "risks", title: "Risks", type: "ai-generated", config: {} },
	];
	it.each(["MARKDOWN", "HTML"])(
		"renders one complete default report in %s without false missing sections",
		async (outputFormat) => {
			const output =
				outputFormat === "HTML"
					? "<h2>Progress</h2><p>Prototype reviewed.</p><h2>Risks</h2><p>Owner needed.</p>"
					: "## Progress\n\nPrototype reviewed.\n\n## Risks\n\nOwner needed.";
			const out = await renderInstanceReport({
				...baseInput,
				outputFormat,
				template: {
					name: "Delivery starter",
					definition: { sections },
				},
				aiResults: [
					{
						agentId: "default",
						outputVariable: "analysis",
						task: "Summarize progress and risks",
						output,
					},
				],
			});
			expect(out.markdown).toContain(output);
			expect(out.markdown).not.toContain("AI analysis not available");
			expect(out.markdown).not.toContain("## Analysis");
			expect(out.markdown).not.toContain("<h2>Analysis</h2>");
			expect(out.markdown.split("Prototype reviewed.")).toHaveLength(2);
		},
	);
	it("keeps explicit multiple agent bindings and their independent sections", async () => {
		const out = await renderInstanceReport({
			...baseInput,
			template: {
				name: "Bound analysis",
				definition: {
					sections: [
						{
							...sections[0],
							config: { agentId: "progress-agent" },
						},
						{ ...sections[1], config: { outputVariable: "risks" } },
					],
				},
			},
			aiResults: [
				{
					agentId: "progress-agent",
					task: "Progress",
					output: "Progress body",
					outputVariable: "progress",
				},
				{
					agentId: "risk-agent",
					task: "Risks",
					output: "Risk body",
					outputVariable: "risks",
				},
			],
		});
		expect(out.markdown).toContain("## Progress");
		expect(out.markdown).toContain("Progress body");
		expect(out.markdown).toContain("## Risks");
		expect(out.markdown).toContain("Risk body");
		expect(out.markdown).not.toContain("## Analysis");
	});
	it("shows the default failure once instead of inventing successful sections", async () => {
		const out = await renderInstanceReport({
			...baseInput,
			template: { name: "Starter", definition: { sections } },
			aiResults: [
				{
					agentId: "default",
					outputVariable: "analysis",
					task: "Summarize",
					output: "",
					error: "Provider unavailable",
				},
			],
		});
		expect(out.markdown).toContain("Error: Provider unavailable");
		expect(out.markdown.split("Provider unavailable")).toHaveLength(2);
		expect(out.markdown).not.toContain("AI analysis not available");
	});
});
