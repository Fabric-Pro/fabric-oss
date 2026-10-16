/**
 * The one rule for putting something of one's own into a project: the frame
 * tools, the publish-frame step, publish validation and the workflow commands
 * all ask it. `getProjectAccessContext` does not cover the trash, so a project
 * in the trash must be refused here as missing, or a scheduled workflow keeps
 * publishing into it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const projects = vi.hoisted(() => ({
	canEditProject: vi.fn(),
	getProjectAccessContext: vi.fn(),
	isProjectSoftDeleted: vi.fn(),
}));

vi.mock("../prisma/queries/projects/projects", () => projects);

import { projectPlacementRefusal } from "../prisma/queries/projects/project-placement";

const input = {
	userId: "user-1",
	organizationId: "org-example-a",
	projectId: "project-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	projects.getProjectAccessContext.mockResolvedValue({
		organizationId: "org-example-a",
	});
	projects.isProjectSoftDeleted.mockResolvedValue(false);
	projects.canEditProject.mockResolvedValue(true);
});

describe("projectPlacementRefusal", () => {
	it("allows an editable project in the organization", async () => {
		expect(await projectPlacementRefusal(input)).toBeNull();
	});

	it("reports a project in the trash as missing", async () => {
		projects.isProjectSoftDeleted.mockResolvedValue(true);

		expect(await projectPlacementRefusal(input)).toBe("not_found");
		expect(projects.canEditProject).not.toHaveBeenCalled();
	});

	it("reports a project the user cannot open as missing", async () => {
		projects.getProjectAccessContext.mockResolvedValue(null);

		expect(await projectPlacementRefusal(input)).toBe("not_found");
	});

	it("reports another organization's project as missing", async () => {
		projects.getProjectAccessContext.mockResolvedValue({
			organizationId: "org-example-b",
		});

		expect(await projectPlacementRefusal(input)).toBe("not_found");
	});

	it("tells a project the user can open but not change apart from a missing one", async () => {
		projects.canEditProject.mockResolvedValue(false);

		expect(await projectPlacementRefusal(input)).toBe("not_editable");
	});
});
