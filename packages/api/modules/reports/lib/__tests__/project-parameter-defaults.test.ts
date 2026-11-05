import { describe, expect, it } from "vitest";
import { projectParameterDefaults } from "../project-parameter-defaults";

describe("projectParameterDefaults", () => {
	it("fills a project name parameter, however its key is written", () => {
		expect(
			projectParameterDefaults(
				{
					properties: {
						projectName: { type: "string" },
						project_name: { type: "string" },
						sprintId: { type: "string" },
					},
				},
				{ name: "Example Project" },
			),
		).toEqual({
			projectName: "Example Project",
			project_name: "Example Project",
		});
	});

	it("fills owner and repository parameters from the project's repository", () => {
		expect(
			projectParameterDefaults(
				{
					properties: {
						owner: { type: "string" },
						repo: { type: "string" },
						sprintId: { type: "string" },
					},
				},
				{
					name: "Example Project",
					repository: {
						repositoryOwner: "example-org",
						repositoryName: "example-repo",
					},
				},
			),
		).toEqual({ owner: "example-org", repo: "example-repo" });
	});

	it("leaves them empty for a project without a repository", () => {
		expect(
			projectParameterDefaults(
				{ properties: { owner: { type: "string" } } },
				{ name: "Example Project", repository: null },
			),
		).toBeUndefined();
	});

	it("leaves a template without a project name parameter alone", () => {
		expect(
			projectParameterDefaults(
				{ properties: { sprintId: { type: "string" } } },
				{ name: "Example Project" },
			),
		).toBeUndefined();
		expect(
			projectParameterDefaults(null, { name: "Example Project" }),
		).toBeUndefined();
	});

	it("fills nothing from a blank project name", () => {
		expect(
			projectParameterDefaults(
				{ properties: { projectName: { type: "string" } } },
				{ name: "  " },
			),
		).toBeUndefined();
	});
});
