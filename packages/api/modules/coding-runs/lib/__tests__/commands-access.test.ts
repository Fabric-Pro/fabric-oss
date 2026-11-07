import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	visible: vi.fn(),
	edit: vi.fn(),
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: mocks.access,
}));
vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.visible,
	canEditProject: mocks.edit,
}));

import { requireCodingRunProject } from "../commands-access";

const actor = { userId: "example-user", organizationId: "example-org" };
beforeEach(() => {
	mocks.access.mockReset().mockResolvedValue({
		organizationId: "example-org",
		permissions: [Permissions.AGENT_READ, Permissions.AGENT_EXECUTE],
	});
	mocks.visible.mockReset().mockResolvedValue(true);
	mocks.edit.mockReset().mockResolvedValue(true);
});
describe("current implementation-session authority", () => {
	it("requires the current project permission independently of credential scopes", async () => {
		mocks.access.mockResolvedValue({
			organizationId: "example-org",
			permissions: [Permissions.AGENT_READ],
		});
		await expect(
			requireCodingRunProject(
				actor,
				"example-project",
				Permissions.AGENT_EXECUTE,
				true,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("refuses a hidden project even when the organization role grants execution", async () => {
		mocks.visible.mockResolvedValue(false);
		await expect(
			requireCodingRunProject(
				actor,
				"example-project",
				Permissions.AGENT_READ,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("refuses a different tenant without disclosing its project", async () => {
		mocks.access.mockResolvedValue({
			organizationId: "other-org",
			permissions: [Permissions.AGENT_EXECUTE],
		});
		await expect(
			requireCodingRunProject(
				actor,
				"example-project",
				Permissions.AGENT_EXECUTE,
				true,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("rechecks object edit authority for a write", async () => {
		mocks.edit.mockResolvedValue(false);
		await expect(
			requireCodingRunProject(
				actor,
				"example-project",
				Permissions.AGENT_EXECUTE,
				true,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("permits an accepted project guest through the same project-authoritative resolver", async () => {
		await expect(
			requireCodingRunProject(
				actor,
				"example-project",
				Permissions.AGENT_EXECUTE,
				true,
			),
		).resolves.toBe("example-org");
		expect(mocks.visible).toHaveBeenCalledWith(
			"example-project",
			"example-user",
			"example-org",
		);
	});
});
