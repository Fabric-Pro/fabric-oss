import { describe, expect, it } from "vitest";
import {
	hasAllPermissions,
	hasAnyPermission,
	hasPermission,
} from "../lib/evaluator";
import { Permissions } from "../lib/permissions";

describe("hasPermission", () => {
	it("returns true when permission is in the granted set", () => {
		expect(
			hasPermission([Permissions.PROJECT_READ], Permissions.PROJECT_READ),
		).toBe(true);
	});

	it("returns false when permission is not in the granted set", () => {
		expect(
			hasPermission(
				[Permissions.PROJECT_READ],
				Permissions.PROJECT_DELETE,
			),
		).toBe(false);
	});

	it("returns false for empty granted set", () => {
		expect(hasPermission([], Permissions.PROJECT_READ)).toBe(false);
	});
});

describe("hasAllPermissions", () => {
	it("returns true when all permissions are present", () => {
		expect(
			hasAllPermissions(
				[
					Permissions.PROJECT_READ,
					Permissions.PROJECT_UPDATE,
					Permissions.STORY_READ,
				],
				[Permissions.PROJECT_READ, Permissions.STORY_READ],
			),
		).toBe(true);
	});

	it("returns false when any required permission is missing", () => {
		expect(
			hasAllPermissions(
				[Permissions.PROJECT_READ],
				[Permissions.PROJECT_READ, Permissions.PROJECT_DELETE],
			),
		).toBe(false);
	});

	it("returns true when required set is empty", () => {
		expect(hasAllPermissions([Permissions.PROJECT_READ], [])).toBe(true);
	});
});

describe("hasAnyPermission", () => {
	it("returns true when at least one permission is present", () => {
		expect(
			hasAnyPermission(
				[Permissions.PROJECT_READ],
				[Permissions.PROJECT_DELETE, Permissions.PROJECT_READ],
			),
		).toBe(true);
	});

	it("returns false when none of the required permissions are present", () => {
		expect(
			hasAnyPermission(
				[Permissions.PROJECT_READ],
				[Permissions.PROJECT_DELETE, Permissions.ORG_DELETE],
			),
		).toBe(false);
	});

	it("returns false when required set is empty", () => {
		expect(hasAnyPermission([Permissions.PROJECT_READ], [])).toBe(false);
	});
});
