import { STANDARD_REPORT_TEMPLATES } from "@repo/database/prisma/seed-report-standard-templates";
import { describe, expect, it } from "vitest";
import { renderInstanceReport } from "../src/activities/template-instance";
import { everySourceSkipped } from "../src/activities/template-instance/report-data-gate";

function seeded(key: string) {
	const template = STANDARD_REPORT_TEMPLATES.find(
		(entry) => entry.key === key,
	);
	if (!template) {
		throw new Error(`No seeded template ${key}`);
	}
	return template;
}

async function renderReview(
	key: string,
	parameters: Record<string, unknown>,
	outputVariable: string,
) {
	const template = seeded(key);
	const { markdown } = await renderInstanceReport({
		instance: { name: "Example review", description: null },
		template: { name: template.name, definition: template.definition },
		dataResults: [],
		aiResults: [
			{
				agentId: "default",
				task: "Write the review",
				outputVariable,
				output: "Example review body",
			},
		],
		parameters,
		outputFormat: "MARKDOWN",
	});
	return markdown;
}

describe("a seeded footer", () => {
	it("fills in when the report was generated", async () => {
		const { markdown } = await renderInstanceReport({
			instance: { name: "Example report", description: null },
			template: {
				name: "Example template",
				definition: {
					sections: [
						{
							id: "footer",
							type: "text",
							title: "",
							config: { template: "Report · {{generatedAt}}" },
						},
					],
				},
			},
			dataResults: [],
			aiResults: [],
			parameters: {},
			outputFormat: "MARKDOWN",
		});

		expect(markdown).toContain("Report · ");
		expect(markdown).not.toContain("{{generatedAt}}");
	});
});

describe("the rendered business review header", () => {
	it.each([
		["an older report", { quarter: "3", year: "2026" }],
		[
			"a new report",
			{ projectName: "Example project", reportPeriod: "This quarter" },
		],
		["a report with no parameters", {}],
	])(
		"has no placeholder and no empty label for %s",
		async (_, parameters) => {
			const markdown = await renderReview(
				"quarterly-review",
				parameters,
				"qbr_structure",
			);
			expect(markdown).toContain("# Quarterly Business Review");
			expect(markdown).toContain("Example review body");
			expect(markdown).not.toContain("{{");
			expect(markdown).not.toContain("**Period:**");
		},
	);

	it("has none for a Monthly Business Review with no parameters", async () => {
		const markdown = await renderReview("monthly-review", {}, "mbr_report");
		expect(markdown).toContain("# Monthly Business Review");
		expect(markdown).not.toContain("{{");
	});
});

describe("a business review with nothing connected", () => {
	it.each(["monthly-review", "quarterly-review"])(
		"%s skips every source",
		(key) => {
			expect(
				everySourceSkipped(seeded(key).definition.dataSources, {
					mcpConfigs: [],
					mcpBindings: {},
				}),
			).toBe(true);
		},
	);
});
