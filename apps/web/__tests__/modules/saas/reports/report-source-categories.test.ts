import {
	connectableServersForSource,
	groupReportConnections,
	type ReportConnectionOption,
	reportCategoryLabel,
	reportSourceCategory,
	startsWithAllTools,
	UNCATEGORIZED_LABEL,
} from "@saas/reports/lib/report-source-categories";
import { describe, expect, it } from "vitest";

describe("connectableServersForSource", () => {
	const fizzy = {
		id: "server-fizzy",
		key: "fizzy",
		name: "Fizzy",
		category: "Project Management",
		tags: [],
	};
	const linear = {
		id: "server-linear",
		key: "linear",
		name: "Linear",
		category: "Project Management",
		tags: [],
	};
	const slack = {
		id: "server-slack",
		key: "slack",
		name: "Slack",
		category: "Communication",
		tags: [],
	};
	const servers = [fizzy, linear, slack];

	it("lists the registry's tools of a generic source's data type", () => {
		expect(
			connectableServersForSource(
				servers,
				{ dataType: "project-management" },
				[],
			),
		).toEqual([fizzy, linear]);
	});

	it("lists a named source's own tool only", () => {
		expect(
			connectableServersForSource(servers, { provider: "slack" }, []),
		).toEqual([slack]);
	});

	it("leaves out a tool the person has already connected", () => {
		expect(
			connectableServersForSource(
				servers,
				{ dataType: "project-management" },
				[{ mcpServer: { key: "fizzy" } }],
			),
		).toEqual([linear]);
	});
});

describe("reportCategoryLabel", () => {
	it("title-cases a keyword category", () => {
		expect(reportCategoryLabel("PRODUCT")).toBe("Product");
		expect(reportCategoryLabel("developer_tools")).toBe("Developer Tools");
		expect(reportCategoryLabel("collaboration")).toBe("Collaboration");
	});

	it("keeps a label written in mixed case", () => {
		expect(reportCategoryLabel(" Project Management ")).toBe(
			"Project Management",
		);
		expect(reportCategoryLabel("DevOps")).toBe("DevOps");
	});
});

const PROVIDERS = {
	azure_devops: { category: "Project Management" },
	fabric_project: {},
};

type Server = { id: string; category?: string | null };

const describeServer = (server: Server) => ({
	option: { value: server.id, label: server.id },
	category: server.category,
});

const own: ReportConnectionOption[] = [
	{ value: "example-board", label: "Board" },
];

describe("reportSourceCategory", () => {
	it("reads the category of a data type", () => {
		expect(reportSourceCategory("project-management", {})).toBe(
			"Project Management",
		);
		expect(reportSourceCategory("repository", {})).toBe("Repository");
	});

	it("reads the category the provider declares, whatever the key spelling", () => {
		expect(reportSourceCategory("azure-devops", PROVIDERS)).toBe(
			"Project Management",
		);
	});

	it("falls back to the category of a connected server for the provider", () => {
		expect(
			reportSourceCategory("example-tracker", PROVIDERS, [
				null,
				" Developer Tools ",
			]),
		).toBe("Developer Tools");
	});

	it("is null when nothing names a category", () => {
		expect(reportSourceCategory("fabric_project", PROVIDERS)).toBeNull();
	});
});

describe("groupReportConnections", () => {
	const servers: Server[] = [
		{ id: "example-board", category: "Project Management" },
		{ id: "example-tracker", category: "project management" },
		{ id: "example-repo", category: "Developer Tools" },
		{ id: "example-chat", category: "Communication" },
		{ id: "example-misc", category: null },
	];

	it("offers the source's category next to its own connections", () => {
		const groups = groupReportConnections(
			own,
			servers,
			"Project Management",
			describeServer,
		);
		expect(groups.recommended.map((o) => o.value)).toEqual([
			"example-board",
		]);
		expect(groups.related.map((o) => o.value)).toEqual(["example-tracker"]);
	});

	it("keeps every other connected tool, by category, uncategorized last", () => {
		const groups = groupReportConnections(
			own,
			servers,
			"Project Management",
			describeServer,
		);
		expect(groups.others).toEqual([
			{
				label: "Communication",
				options: [{ value: "example-chat", label: "example-chat" }],
			},
			{
				label: "Developer Tools",
				options: [{ value: "example-repo", label: "example-repo" }],
			},
			{
				label: UNCATEGORIZED_LABEL,
				options: [{ value: "example-misc", label: "example-misc" }],
			},
		]);
	});

	it("puts everything in the all-tools view when the source has no category", () => {
		const groups = groupReportConnections(
			[],
			servers,
			null,
			describeServer,
		);
		expect(groups.related).toEqual([]);
		expect(
			groups.others.flatMap((group) => group.options).map((o) => o.value),
		).toHaveLength(servers.length);
	});
});

describe("startsWithAllTools", () => {
	const groups = groupReportConnections(
		own,
		[
			{ id: "example-board", category: "Project Management" },
			{ id: "example-repo", category: "Developer Tools" },
		],
		"Project Management",
		describeServer,
	);

	it("opens on the category when a tool of it is connected", () => {
		expect(startsWithAllTools(groups, "example-board")).toBe(false);
		expect(startsWithAllTools(groups, undefined)).toBe(false);
	});

	it("opens on every tool so a saved connection outside the category shows", () => {
		expect(startsWithAllTools(groups, "example-repo")).toBe(true);
	});

	it("opens on every tool when nothing in the category is connected", () => {
		const none = groupReportConnections(
			[],
			[{ id: "example-repo", category: "Developer Tools" }],
			"Project Management",
			describeServer,
		);
		expect(startsWithAllTools(none, undefined)).toBe(true);
	});
});
