import { expect, it } from "vitest";
import { Permissions } from "../lib/permissions";
import { PROJECT_ROLE_PERMISSIONS } from "../lib/roles";

it("Project Editor and above can create and edit project reports", () => {
	for (const role of ["EDITOR", "PROJECT_ADMIN", "OWNER"] as const) {
		expect(PROJECT_ROLE_PERMISSIONS[role]).toContain(
			Permissions.REPORT_CREATE,
		);
		expect(PROJECT_ROLE_PERMISSIONS[role]).toContain(
			Permissions.REPORT_UPDATE,
		);
	}
});

it("Project Viewer and Commenter can read reports but not edit them", () => {
	for (const role of ["VIEWER", "COMMENTER"] as const) {
		expect(PROJECT_ROLE_PERMISSIONS[role]).toContain(
			Permissions.REPORT_READ,
		);
		expect(PROJECT_ROLE_PERMISSIONS[role]).not.toContain(
			Permissions.REPORT_CREATE,
		);
		expect(PROJECT_ROLE_PERMISSIONS[role]).not.toContain(
			Permissions.REPORT_UPDATE,
		);
	}
});

it("deleting a project report stays with Project Admin and above", () => {
	expect(PROJECT_ROLE_PERMISSIONS.EDITOR).not.toContain(
		Permissions.REPORT_DELETE,
	);
	expect(PROJECT_ROLE_PERMISSIONS.PROJECT_ADMIN).toContain(
		Permissions.REPORT_DELETE,
	);
});
