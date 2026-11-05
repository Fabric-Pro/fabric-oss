import { describe, expect, it, vi } from "vitest";

vi.mock("../prisma/client", () => ({ db: {} }));

import { skillVisibilityWhere } from "../prisma/queries/skills";
import {
	buildSkillReadPolicySQL,
	buildSkillWritePolicies,
} from "../scripts/rls-policy-sql";

describe("skill tenant visibility and RLS", () => {
	it("never includes legacy USER/null namespace in an organization", () => {
		const where = skillVisibilityWhere(
			{ userId: "example-user", organizationId: "example-org" },
			true,
		);
		expect(where).toEqual({
			OR: [
				{
					scope: "SYSTEM",
					userId: null,
					organizationId: null,
					isPublished: true,
					archivedAt: null,
				},
				{
					scope: "ORGANIZATION",
					organizationId: "example-org",
					OR: [
						{ userId: "example-user" },
						{ isPublished: true, archivedAt: null },
					],
				},
			],
		});
	});
	it("anonymous context cannot expose user or organization drafts", () => {
		expect(skillVisibilityWhere({})).toEqual({
			OR: [
				{
					scope: "SYSTEM",
					userId: null,
					organizationId: null,
					isPublished: true,
					archivedAt: null,
				},
			],
		});
	});
	it("parent file reads inherit draft privacy and writes require actual owner", () => {
		for (const file of [false, true]) {
			const sql = buildSkillReadPolicySQL(file);
			expect(sql).toContain("current_tenant_type() = 'organization'");
			expect(sql).toContain("current_user_id()");
			expect(sql).toContain('"archivedAt" IS NULL');
			expect(sql).not.toContain("'personal'");
			const writes = buildSkillWritePolicies(file);
			expect(writes).toHaveLength(3);
			for (const p of writes) {
				expect(p.sql).toContain('"userId" = current_user_id()');
				expect(p.sql).toContain("scope = 'ORGANIZATION'");
				expect(p.sql).not.toContain("scope = 'SYSTEM'");
			}
			if (file) {
				expect(sql).toContain('s.id = "skill_file"."skillId"');
			}
		}
	});
});
