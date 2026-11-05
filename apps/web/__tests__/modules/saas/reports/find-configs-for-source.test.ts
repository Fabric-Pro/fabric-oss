import { findConfigsForSource } from "@saas/reports/lib/mcp-utils";
import { describe, expect, it } from "vitest";

const fizzy = {
	id: "config-fizzy",
	mcpServer: {
		key: "fizzy",
		name: "Fizzy",
		category: "Project Management",
		tags: [],
	},
};
const gitlab = {
	id: "config-gitlab",
	mcpServer: {
		key: "gitlab",
		name: "GitLab",
		category: "Developer Tools",
		tags: ["git"],
	},
};
const azureDevOps = {
	id: "config-azure",
	mcpServer: {
		key: "azure-devops",
		name: "Azure DevOps",
		category: "Developer Tools",
		tags: ["git", "project-management"],
	},
};
const configs = [fizzy, gitlab, azureDevOps];

describe("findConfigsForSource", () => {
	it("finds the configs of the provider a source names", () => {
		expect(findConfigsForSource(configs, { provider: "gitlab" })).toEqual([
			gitlab,
		]);
	});

	it("finds the configs of the data type a generic source asks for", () => {
		expect(
			findConfigsForSource(configs, { dataType: "project-management" }),
		).toEqual([fizzy, azureDevOps]);
		expect(
			findConfigsForSource(configs, { dataType: "repository" }),
		).toEqual([gitlab, azureDevOps]);
	});

	it("reads the provider first when a source has both", () => {
		expect(
			findConfigsForSource(configs, {
				provider: "fizzy",
				dataType: "repository",
			}),
		).toEqual([fizzy]);
	});

	it("finds nothing for a source that asks for neither, or a config with no server", () => {
		expect(findConfigsForSource(configs, {})).toEqual([]);
		expect(
			findConfigsForSource([{ id: "config-none", mcpServer: null }], {
				dataType: "repository",
			}),
		).toEqual([]);
	});
});
