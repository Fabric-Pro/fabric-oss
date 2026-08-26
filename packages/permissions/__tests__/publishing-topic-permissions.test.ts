import { expect, it } from "vitest";
import { Permissions } from "../lib/permissions";
// F9: the per-role arrays (VIEWER_PROJECT_PERMISSIONS, …) are module-PRIVATE. The public
// surface is the frozen role→permissions maps. NOTE the differing key CASE (verified in
// roles.ts:163,241): `PROJECT_ROLE_PERMISSIONS` is keyed UPPERCASE (OWNER | PROJECT_ADMIN |
// EDITOR | COMMENTER | VIEWER), but `ORG_ROLE_PERMISSIONS` is keyed lowercase (owner | admin |
// member | viewer).
import { ORG_ROLE_PERMISSIONS, PROJECT_ROLE_PERMISSIONS } from "../lib/roles";

it("Viewer can read but not write publishing topics (project + org tiers)", () => {
	expect(PROJECT_ROLE_PERMISSIONS.VIEWER).toContain(
		Permissions.PUBLISHING_TOPIC_READ,
	);
	expect(PROJECT_ROLE_PERMISSIONS.VIEWER).not.toContain(
		Permissions.PUBLISHING_TOPIC_CREATE,
	);
	expect(ORG_ROLE_PERMISSIONS.viewer).toContain(
		Permissions.PUBLISHING_TOPIC_READ,
	);
});
it("Editor / org member can create and update publishing topics", () => {
	expect(PROJECT_ROLE_PERMISSIONS.EDITOR).toContain(
		Permissions.PUBLISHING_TOPIC_CREATE,
	);
	expect(PROJECT_ROLE_PERMISSIONS.EDITOR).toContain(
		Permissions.PUBLISHING_TOPIC_UPDATE,
	);
	expect(ORG_ROLE_PERMISSIONS.member).toContain(
		Permissions.PUBLISHING_TOPIC_CREATE,
	);
});
it("Project admin / org admin can delete publishing topics", () => {
	expect(PROJECT_ROLE_PERMISSIONS.PROJECT_ADMIN).toContain(
		Permissions.PUBLISHING_TOPIC_DELETE,
	);
	expect(ORG_ROLE_PERMISSIONS.admin).toContain(
		Permissions.PUBLISHING_TOPIC_DELETE,
	);
});
