import { describe, expect, it } from "vitest";
import {
	assertTenantOwnedKey,
	buildProjectStoragePath,
	buildTenantStoragePath,
	isTenantOwnedKey,
	tenantOwnerPrefix,
} from "../tenant-paths";

describe("tenant-paths (F-099 XOR isolation)", () => {
	it("keys org files under organizationId (org wins over user)", () => {
		expect(
			buildTenantStoragePath({
				organizationId: "org_1",
				userId: "usr_1",
				sub: "workspace-files/f.md",
			}),
		).toBe("org_1/workspace-files/f.md");
	});

	it("keys personal files under userId when org is null/undefined", () => {
		expect(
			buildTenantStoragePath({
				organizationId: null,
				userId: "usr_1",
				sub: "workspace-files/f.md",
			}),
		).toBe("usr_1/workspace-files/f.md");
		expect(tenantOwnerPrefix(undefined, "usr_1")).toBe("usr_1");
	});

	it("project paths are projectId-scoped", () => {
		expect(
			buildProjectStoragePath({ projectId: "proj_1", sub: "a/b.ext" }),
		).toBe("projects/proj_1/a/b.ext");
	});

	it("isTenantOwnedKey accepts own prefix, rejects foreign + prefix-collision", () => {
		expect(isTenantOwnedKey("org_1/x.md", "org_1", "usr_1")).toBe(true);
		expect(isTenantOwnedKey("org_1", "org_1", "usr_1")).toBe(true);
		// A personal user must not be able to claim the org's objects.
		expect(isTenantOwnedKey("org_1/x.md", null, "usr_1")).toBe(false);
		// Trailing-slash guard: "org_12" must NOT match owner "org_1".
		expect(isTenantOwnedKey("org_12/x.md", "org_1", "usr_1")).toBe(false);
	});

	it("assertTenantOwnedKey throws a generic message on a foreign key", () => {
		expect(() =>
			assertTenantOwnedKey("org_2/x.md", "org_1", "usr_1"),
		).toThrow("Storage object not found or access denied");
		expect(() =>
			assertTenantOwnedKey("org_1/x.md", "org_1", "usr_1"),
		).not.toThrow();
	});
});
