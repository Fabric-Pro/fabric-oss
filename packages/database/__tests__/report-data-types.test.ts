import { describe, expect, it } from "vitest";
import {
	genericSourceDataType,
	isReportDataType,
	REPORT_DATA_TYPE_INFO,
	REPORT_DATA_TYPES,
	serverSuppliesDataType,
} from "../prisma/queries/lib/report-data-types";

describe("isReportDataType", () => {
	it("accepts the declared types and nothing else", () => {
		for (const type of REPORT_DATA_TYPES) {
			expect(isReportDataType(type)).toBe(true);
		}
		expect(isReportDataType("documents")).toBe(false);
		expect(isReportDataType(undefined)).toBe(false);
	});

	it("words a question for every type", () => {
		for (const type of REPORT_DATA_TYPES) {
			expect(REPORT_DATA_TYPE_INFO[type].question).toMatch(/\?$/);
		}
	});
});

describe("serverSuppliesDataType", () => {
	it("takes a project management tool by category, in any case", () => {
		expect(
			serverSuppliesDataType(
				{ category: "Project Management", tags: [] },
				"project-management",
			),
		).toBe(true);
		expect(
			serverSuppliesDataType(
				{ category: " project management ", tags: null },
				"project-management",
			),
		).toBe(true);
	});

	it("takes a project management tool by tag", () => {
		expect(
			serverSuppliesDataType(
				{ category: "Developer Tools", tags: ["project-management"] },
				"project-management",
			),
		).toBe(true);
	});

	it.each(["git", "repositories", "repos"])(
		"takes a repository host by its %s tag",
		(tag) => {
			expect(
				serverSuppliesDataType(
					{ category: "Developer Tools", tags: [tag] },
					"repository",
				),
			).toBe(true);
		},
	);

	it("does not take a tool of one type for the other", () => {
		const projectManagement = {
			category: "Project Management",
			tags: ["tasks"],
		};
		const repository = { category: "Developer Tools", tags: ["git"] };
		expect(serverSuppliesDataType(projectManagement, "repository")).toBe(
			false,
		);
		expect(serverSuppliesDataType(repository, "project-management")).toBe(
			false,
		);
	});

	it("does not take a server with neither category nor tags", () => {
		expect(serverSuppliesDataType({}, "project-management")).toBe(false);
		expect(serverSuppliesDataType({}, "repository")).toBe(false);
	});

	it("takes a tool that is both for both", () => {
		const both = { category: null, tags: ["git", "project-management"] };
		expect(serverSuppliesDataType(both, "project-management")).toBe(true);
		expect(serverSuppliesDataType(both, "repository")).toBe(true);
	});
});

describe("genericSourceDataType", () => {
	it("reads the data type of a source that names no tool", () => {
		expect(
			genericSourceDataType({ type: "mcp", dataType: "repository" }),
		).toBe("repository");
	});

	it("treats a blank provider as naming no tool", () => {
		expect(
			genericSourceDataType({
				dataType: "project-management",
				provider: " ",
			}),
		).toBe("project-management");
	});

	it("treats a source naming a provider or a server key as that tool", () => {
		expect(
			genericSourceDataType({
				dataType: "project-management",
				provider: "fizzy",
			}),
		).toBeNull();
		expect(
			genericSourceDataType({
				dataType: "repository",
				config: { mcpServerKey: "github" },
			}),
		).toBeNull();
	});

	it("refuses an unknown data type and anything that is not a source", () => {
		expect(genericSourceDataType({ dataType: "documents" })).toBeNull();
		expect(genericSourceDataType({ provider: "fizzy" })).toBeNull();
		expect(genericSourceDataType(null)).toBeNull();
		expect(genericSourceDataType("repository")).toBeNull();
	});
});
