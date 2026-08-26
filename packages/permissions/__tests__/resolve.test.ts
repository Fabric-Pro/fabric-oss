import { describe, expect, it } from "vitest";
import { Permissions } from "../lib/permissions";
import {
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "../lib/resolve";

describe("resolveOrgPermissions", () => {
	it("returns owner permission set", () => {
		const perms = resolveOrgPermissions("owner");
		expect(perms).toContain(Permissions.ORG_DELETE);
		expect(perms).toContain(Permissions.PROJECT_READ);
	});

	it("returns viewer permission set", () => {
		const perms = resolveOrgPermissions("viewer");
		expect(perms).toContain(Permissions.PROJECT_READ);
		expect(perms).not.toContain(Permissions.PROJECT_CREATE);
	});

	it("returns empty array for null", () => {
		expect(resolveOrgPermissions(null)).toEqual([]);
	});

	it("returns empty array for undefined", () => {
		expect(resolveOrgPermissions(undefined)).toEqual([]);
	});

	it("returns empty array for unknown role", () => {
		expect(resolveOrgPermissions("nonexistent")).toEqual([]);
	});
});

describe("resolveProjectPermissions", () => {
	it("returns OWNER permission set", () => {
		const perms = resolveProjectPermissions("OWNER");
		expect(perms).toContain(Permissions.PROJECT_DELETE);
	});

	it("returns VIEWER permission set", () => {
		const perms = resolveProjectPermissions("VIEWER");
		expect(perms).toContain(Permissions.PROJECT_READ);
		expect(perms).not.toContain(Permissions.PROJECT_DELETE);
	});

	it("returns empty array for null", () => {
		expect(resolveProjectPermissions(null)).toEqual([]);
	});

	it("returns empty array for unknown role", () => {
		expect(resolveProjectPermissions("BOGUS")).toEqual([]);
	});
});
