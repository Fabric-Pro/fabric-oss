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
	it.each(["ProjectInstructionSnapshot", "ProjectInstructionFile"])(
		"%s is user-owned and project-scoped",
		(model) => {
			expect(tenantDb).toMatch(new RegExp(`"${model}",`));
			expect(tenantDb).toMatch(new RegExp(`${model}: "projectId",`));
		},
	);
	it.each(["project_instruction_snapshot", "project_instruction_file"])(
		"%s has an RLS policy",
		(table) => {
			expect(rls).toContain(`{ name: "${table}", policy: "user_owned" }`);
		},
	);
});
