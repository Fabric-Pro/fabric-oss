import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const here = path.dirname(new URL(import.meta.url).pathname);
const tenantDb = readFileSync(path.join(here, "../src/tenant-db.ts"), "utf8");
const rls = readFileSync(
	path.join(here, "../scripts/apply-rls-direct.ts"),
	"utf8",
);

describe("Coding Instructions tables are registered on the tenant path", () => {
	it.each([
		"ProjectInstructionSnapshot",
		"ProjectInstructionFile",
		"ProjectInstructionRepositorySync",
		"ProjectInstructionRepositorySyncRun",
	])("%s is user-owned and project-scoped", (model) => {
		expect(tenantDb).toMatch(new RegExp(`"${model}",`));
		expect(tenantDb).toMatch(new RegExp(`${model}: "projectId",`));
	});
	it.each([
		"project_instruction_snapshot",
		"project_instruction_file",
		"project_instruction_repository_sync",
		"project_instruction_repository_sync_run",
	])("%s has an RLS policy", (table) => {
		expect(rls).toMatch(
			new RegExp(
				`\\{\\s*name: "${table}",\\s*policy: "user_owned",?\\s*\\}`,
			),
		);
	});
});

/**
 * Living Memory repository sync (design 2026-09-23 §4.1, §4.2). Both tables
 * carry `organizationId`, `userId` and `projectId`; unregistered, they fail
 * OPEN on the tenant path. The sets are sliced (see `setMembers` below) so a
 * table registered in the wrong set fails here.
 */
describe("Living Memory repository sync tables are registered on the tenant path", () => {
	it.each([
		"ProjectContextRepositorySync",
		"ProjectContextRepositorySyncRun",
	])("%s is user-owned and project-scoped", (model) => {
		expect(
			setMembers(tenantDb, "const USER_OWNED_TABLES = new Set(["),
		).toContain(model);
		expect(tenantDb).toMatch(new RegExp(`\\b${model}: "projectId",`));
	});
	it.each([
		"project_context_repository_sync",
		"project_context_repository_sync_run",
	])("%s has a user_owned RLS policy", (table) => {
		expect(rls).toMatch(
			new RegExp(
				`\\{\\s*name: "${table}",\\s*policy: "user_owned",?\\s*\\}`,
			),
		);
	});
});

/**
 * #2340. The suite above matches a bare substring anywhere in tenant-db.ts,
 * which cannot tell one registration set from another — a model listed in the
 * wrong set would still pass it. These cases slice the actual set literals, so
 * a to-do row registered as organization-only (or a contact registered as
 * user-owned, which would apply a policy comparing a column it does not have)
 * fails here rather than at `apply:rls` time.
 */
function setMembers(source: string, declaration: string): string[] {
	const start = source.indexOf(declaration);
	if (start === -1) {
		throw new Error(`declaration not found: ${declaration}`);
	}
	const body = source.slice(start + declaration.length);
	const end = body.indexOf("]);");
	return [...body.slice(0, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("To Do list tables are registered on the tenant path", () => {
	it("TodoItem is user-owned and project-scoped", () => {
		expect(
			setMembers(tenantDb, "const USER_OWNED_TABLES = new Set(["),
		).toContain("TodoItem");
		expect(tenantDb).toMatch(/TodoItem: "projectId",/);
		expect(rls).toContain('{ name: "todo_item", policy: "user_owned" }');
	});

	it("NonMemberContact is organization-only, never user-owned", () => {
		expect(
			setMembers(tenantDb, "const ORG_ONLY_TABLES = new Set(["),
		).toContain("NonMemberContact");
		expect(
			setMembers(tenantDb, "const USER_OWNED_TABLES = new Set(["),
		).not.toContain("NonMemberContact");
		expect(rls).toContain(
			'{ name: "non_member_contact", policy: "org_only" }',
		);
	});
});
