/**
 * Which report templates the shared catalog lists before any report made from
 * them has completed: the named standard ones and those a person authored. The
 * seed derives each system template's `isGeneric` from the same rule. Also the
 * shape of the standard set.
 *
 * Only the static seed array is read — no DB call is made — so the Prisma
 * client and the logger are mocked, matching `report-light-theme-seed.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma/client", () => ({
	db: {
		$disconnect: vi.fn(),
	},
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		success: vi.fn(),
	},
}));

import { genericSourceDataType } from "../prisma/queries/lib/report-data-types";
import {
	isConnectorFreeReportDefinition,
	REPORT_SUITE_ONLY_TEMPLATE_NAMES,
	runGatheredRecords,
	STANDARD_REPORT_TEMPLATE_NAMES,
	seededTemplateListedWithoutRuns,
} from "../prisma/queries/lib/report-template-catalog";
import { STANDARD_REPORT_TEMPLATES } from "../prisma/seed-report-standard-templates";
import {
	SYSTEM_TEMPLATES,
	seededReportTemplateDefinition,
} from "../prisma/seed-report-templates";

describe("isConnectorFreeReportDefinition", () => {
	it("accepts Fabric, project knowledge and user-input sources, or none", () => {
		expect(isConnectorFreeReportDefinition({ dataSources: [] })).toBe(true);
		expect(isConnectorFreeReportDefinition({})).toBe(true);
		expect(
			isConnectorFreeReportDefinition({
				dataSources: [
					{ type: "fabric", config: { source: "youtube" } },
					{
						type: "fabric",
						provider: "fabric_project",
						operation: "project_knowledge",
					},
					{ type: "user-input" },
				],
			}),
		).toBe(true);
	});

	it("refuses any MCP or integration source", () => {
		expect(
			isConnectorFreeReportDefinition({
				dataSources: [
					{ type: "fabric" },
					{ type: "mcp", provider: "fizzy" },
				],
			}),
		).toBe(false);
		expect(
			isConnectorFreeReportDefinition({
				dataSources: [{ type: "integration", provider: "github" }],
			}),
		).toBe(false);
	});

	it("refuses a source it cannot read", () => {
		expect(isConnectorFreeReportDefinition({ dataSources: [null] })).toBe(
			false,
		);
		expect(
			isConnectorFreeReportDefinition({
				dataSources: [{ provider: "x" }],
			}),
		).toBe(false);
	});
});

describe("runGatheredRecords", () => {
	it("counts a run in which any data source returned records", () => {
		expect(
			runGatheredRecords([
				{ sourceId: "board", recordCount: 0 },
				{ sourceId: "issues", recordCount: 4 },
			]),
		).toBe(true);
	});

	it("does not count a run that found nothing or recorded no sources", () => {
		expect(
			runGatheredRecords([{ sourceId: "board", recordCount: 0 }]),
		).toBe(false);
		expect(runGatheredRecords([])).toBe(false);
		expect(runGatheredRecords(null)).toBe(false);
		expect(runGatheredRecords([{ recordCount: "4" }, null])).toBe(false);
	});
});

describe("seededReportTemplateDefinition", () => {
	const seeded = { dataSources: [], userPrompt: "Seeded" };
	const edited = { dataSources: [], userPrompt: "Edited by a person" };

	it("writes the seeded definition for a new template", () => {
		expect(seededReportTemplateDefinition(null, seeded)).toEqual({
			definition: seeded,
			keptEdited: false,
		});
	});

	it("writes the seeded definition over a template nobody edited", () => {
		expect(
			seededReportTemplateDefinition(
				{ version: 1, definition: edited },
				seeded,
			),
		).toEqual({ definition: seeded, keptEdited: false });
	});

	it("keeps the definition of a template a person edited", () => {
		expect(
			seededReportTemplateDefinition(
				{ version: 2, definition: edited },
				seeded,
			),
		).toEqual({ definition: edited, keptEdited: true });
	});
});

describe("seeded system templates", () => {
	const listedWithoutRuns = (key: string) => {
		const template = SYSTEM_TEMPLATES.find((entry) => entry.key === key);
		expect(template).toBeDefined();
		return seededTemplateListedWithoutRuns(template?.name ?? "", false);
	};

	it.each([
		"sprint-status",
		"burndown-burnup",
		"release-summary",
		"velocity",
		"engineering-metrics",
		"monthly-review",
		"quarterly-review",
		"custom-report",
	])("lists the standard %s template before it has run", (key) => {
		expect(listedWithoutRuns(key)).toBe(true);
	});

	it.each([
		"youtube-summary",
		"article-summary",
		"meeting-notes",
		"scope-estimate-by-phase",
	])(
		"waits for a completed report before listing %s, though it needs no connector",
		(key) => {
			expect(listedWithoutRuns(key)).toBe(false);
		},
	);

	it.each([
		"task-board-project-report",
		"github-issues-weekly",
		"github-pr-status",
		"jira-sprint-report",
		"linear-cycle-report",
		"slack-weekly-digest",
		"weekly-engineering-report",
	])("waits for a completed report before listing %s", (key) => {
		expect(listedWithoutRuns(key)).toBe(false);
	});

	it("lists a seeded template a person has edited", () => {
		expect(
			seededTemplateListedWithoutRuns("Example Edited Template", true),
		).toBe(true);
		expect(
			seededTemplateListedWithoutRuns("Example Edited Template", false),
		).toBe(false);
	});

	it("leaves the Quarterly Business Review out of the suite-only names: its row already exists", () => {
		expect(STANDARD_REPORT_TEMPLATE_NAMES).toContain(
			"Quarterly Business Review",
		);
		expect(REPORT_SUITE_ONLY_TEMPLATE_NAMES).not.toContain(
			"Quarterly Business Review",
		);
		expect(REPORT_SUITE_ONLY_TEMPLATE_NAMES).toHaveLength(
			STANDARD_REPORT_TEMPLATE_NAMES.length - 1,
		);
	});
});

describe("standard report templates", () => {
	it("are all in the seed, under every standard name", () => {
		const seeded = SYSTEM_TEMPLATES.map((template) => template.name);
		for (const name of STANDARD_REPORT_TEMPLATE_NAMES) {
			expect(seeded.filter((entry) => entry === name)).toEqual([name]);
		}
		expect(
			STANDARD_REPORT_TEMPLATES.map(({ name }) => name).sort(),
		).toEqual([...STANDARD_REPORT_TEMPLATE_NAMES].sort());
	});

	it.each(STANDARD_REPORT_TEMPLATES)(
		"$key declares its sources by data type, with no provider",
		({ definition }) => {
			expect(definition.dataSources.length).toBeGreaterThan(0);
			for (const source of definition.dataSources) {
				expect(source.type).toBe("mcp");
				expect(source.useAgentic).toBe(true);
				expect(source).not.toHaveProperty("provider");
				expect(source).not.toHaveProperty("config");
				expect(genericSourceDataType(source)).toBe(source.dataType);
			}
		},
	);

	it.each([
		["sprint-status", "project-management", "repository"],
		["burndown-burnup", "project-management", "repository"],
		["release-summary", "project-management", "repository"],
		["velocity", "project-management", "repository"],
		["engineering-metrics", "repository", "project-management"],
	])("%s requires %s, and %s is optional", (key, required, optional) => {
		const template = STANDARD_REPORT_TEMPLATES.find(
			(entry) => entry.key === key,
		);
		expect(
			template?.definition.dataSources.map((source) => [
				source.dataType,
				source.required,
			]),
		).toEqual(
			expect.arrayContaining([
				[required, true],
				[optional, false],
			]),
		);
	});

	it.each(["monthly-review", "quarterly-review", "custom-report"])(
		"%s requires no source and no parameter",
		(key) => {
			const template = STANDARD_REPORT_TEMPLATES.find(
				(entry) => entry.key === key,
			);
			expect(template?.definition.dataSources.length).toBeGreaterThan(0);
			expect(
				template?.definition.dataSources.every(
					(source) => source.required === false,
				),
			).toBe(true);
			expect(
				template?.connections.mcpServers.every(
					(server) => server.required === false,
				),
			).toBe(true);
			expect(template?.parameters.required).toEqual([]);
		},
	);

	it("keeps the parameters an older Quarterly Business Review report has, as optional ones", () => {
		const quarterly = STANDARD_REPORT_TEMPLATES.find(
			(entry) => entry.key === "quarterly-review",
		);
		expect(Object.keys(quarterly?.parameters.properties ?? {})).toEqual(
			expect.arrayContaining([
				"quarter",
				"year",
				"department",
				"presenter",
				"projectName",
				"reportPeriod",
				"businessContext",
			]),
		);
		const prompt = JSON.stringify(quarterly?.definition.aiAgents);
		for (const parameter of [
			"quarter",
			"year",
			"department",
			"presenter",
			"projectName",
			"reportPeriod",
		]) {
			expect(prompt).toContain(`\`${parameter}\``);
		}
	});

	it.each(STANDARD_REPORT_TEMPLATES)(
		"$key leaves no placeholder for the renderer to print",
		({ definition }) => {
			for (const section of definition.sections) {
				if (section.type === "text") {
					expect(JSON.stringify(section.config)).not.toContain("{{");
				}
			}
		},
	);

	it.each(STANDARD_REPORT_TEMPLATES)(
		"$key declares a connection for each source, under the source's id",
		({ connections, definition }) => {
			expect(
				connections.mcpServers.map((server) => [
					server.key,
					server.dataType,
					server.required,
				]),
			).toEqual(
				definition.dataSources.map((source) => [
					source.id,
					source.dataType,
					source.required,
				]),
			);
		},
	);

	it.each(STANDARD_REPORT_TEMPLATES)(
		"$key tells the report to read the board facts and never to invent a metric",
		({ definition }) => {
			const prompt = definition.aiAgents
				.map((agent) => agent.task)
				.join("\n");
			expect(prompt).toContain("Board Facts");
			for (const fact of [
				"total",
				"open",
				"closed",
				"postponed",
				"byStatus",
				"byColumn",
				"byAssignee",
				"byTag",
				"unassigned",
				"overdue",
				"stale",
				"closedPerPeriod",
				"closedCardsByDay",
				"createdPerPeriod",
				"complete: false",
				"gaps",
			]) {
				expect(prompt).toContain(fact);
			}
			expect(prompt).toContain("Never estimate or invent a metric");
			expect(prompt).toContain("A null fact means");
		},
	);

	it.each(STANDARD_REPORT_TEMPLATES)(
		"$key names no tool in its prompts",
		({ definition }) => {
			const prompt = JSON.stringify(definition).toLowerCase();
			for (const tool of [
				"fizzy",
				"jira",
				"linear",
				"github",
				"gitlab",
				"azure",
			]) {
				expect(prompt).not.toContain(tool);
			}
		},
	);

	it.each(["monthly-review", "quarterly-review"])(
		"%s takes business figures only from a parameter no default fills",
		(key) => {
			const template = STANDARD_REPORT_TEMPLATES.find(
				(entry) => entry.key === key,
			);
			expect(template?.parameters.properties).toHaveProperty(
				"businessContext.aiDefault",
				false,
			);
			expect(JSON.stringify(template?.definition)).toContain(
				"businessContext",
			);
		},
	);

	it.each(["releaseName", "quarter", "year"])(
		"asks AI for no %s, which it could only invent",
		(key) => {
			const declaring = STANDARD_REPORT_TEMPLATES.filter(
				(template) => key in template.parameters.properties,
			);

			expect(declaring.length).toBeGreaterThan(0);
			for (const template of declaring) {
				expect(template.parameters.properties).toHaveProperty(
					`${key}.aiDefault`,
					false,
				);
			}
		},
	);

	it("draws the burn chart as HTML with inline SVG on a light-only theme", () => {
		const burnChart = STANDARD_REPORT_TEMPLATES.find(
			(entry) => entry.key === "burndown-burnup",
		);
		expect(burnChart?.outputFormat).toBe("HTML");
		const prompt = JSON.stringify(burnChart?.definition);
		expect(prompt).toContain("inline SVG");
		expect(prompt).toContain("light-only");
	});
});

describe("engineering metrics wording", () => {
	const prompt = JSON.stringify(
		STANDARD_REPORT_TEMPLATES.find(
			(template) => template.key === "engineering-metrics",
		)?.definition,
	);

	it("counts releases when the deployment records cover only part of the period", () => {
		expect(prompt).toContain(
			"when the records you could read cover only part of the period and the releases you read reach back to its start, report the release count for the whole period as the value",
		);
		expect(prompt).toContain(
			"give the deployment-record count with the dates it covers beside it",
		);
	});
});

describe("task board report wording", () => {
	const prompt = JSON.stringify(
		SYSTEM_TEMPLATES.find(
			(template) => template.key === "task-board-project-report",
		)?.definition,
	);

	it("says every page was read, and never to call the data a sample", () => {
		expect(prompt).toContain(
			"Every page of the open, closed and not-now listings has been read.",
		);
		expect(prompt).toContain("Never call the data a sample.");
		expect(prompt).not.toMatch(/\bSAMPLE\b/);
		expect(prompt).not.toContain("total_count");
	});

	it("takes the status counts from the board facts", () => {
		expect(prompt).toContain(
			"Take the status counts from the Board Facts, and from those and the gathered data report:",
		);
		expect(prompt).not.toContain("From the gathered data, compute:");
	});
});
