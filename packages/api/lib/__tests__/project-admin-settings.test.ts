import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
}));

vi.mock("../effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));

import { canEditProjectAdminSettings } from "../project-admin-settings";

describe("canEditProjectAdminSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns true when the resolver returns owner", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "owner",
			permissions: [Permissions.PROJECT_READ],
		});

		expect(await canEditProjectAdminSettings("proj-1", "user-1")).toBe(
			true,
		);
	});

	it("returns true when member has PROJECT_SETTINGS_EDIT permission", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "membership",
			permissions: [
				Permissions.PROJECT_READ,
				Permissions.PROJECT_SETTINGS_EDIT,
			],
		});

		expect(await canEditProjectAdminSettings("proj-1", "user-1")).toBe(
			true,
		);
	});

	it("returns false for editor-level permissions without PROJECT_SETTINGS_EDIT", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "membership",
			permissions: [
				Permissions.PROJECT_READ,
				Permissions.STORY_CREATE,
				Permissions.STORY_EDIT,
			],
		});

		expect(await canEditProjectAdminSettings("proj-1", "user-1")).toBe(
			false,
		);
	});

	it("returns false for an org role that grants it on a project the caller cannot open", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "org",
			isVisible: false,
			permissions: [
				Permissions.PROJECT_READ,
				Permissions.PROJECT_SETTINGS_EDIT,
			],
		});

		expect(await canEditProjectAdminSettings("proj-1", "user-1")).toBe(
			false,
		);
	});

	it("returns true for the project's creator through the same org role", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "org",
			isVisible: true,
			permissions: [
				Permissions.PROJECT_READ,
				Permissions.PROJECT_SETTINGS_EDIT,
			],
		});

		expect(await canEditProjectAdminSettings("proj-1", "user-1")).toBe(
			true,
		);
	});

	it("returns false when user has no access (resolver returns null)", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(null);

		expect(await canEditProjectAdminSettings("proj-1", "user-1")).toBe(
			false,
		);
	});
});
