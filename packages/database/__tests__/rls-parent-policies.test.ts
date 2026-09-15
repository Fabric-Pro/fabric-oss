/**
 * Parent-scoped tenant isolation.
 *
 * `project_stage_approver` and `pending_backlog_proposal_application` carry no
 * `userId` / `organizationId` of their own — they are reachable only through a
 * FK to a parent row that does. Two layers protect them and both are covered
 * here:
 *
 *  1. The `project_parent` / `proposal_parent` RLS policies, whose SQL is
 *     built by the pure helper in `scripts/rls-policy-sql.ts` (asserted below
 *     without touching a database).
 *  2. The Prisma extension's parent-relation `where`, built by
 *     `getParentScopedFilter` in `src/tenant-db.ts`.
 *
 * The security-critical assertions are that BOTH tenant branches are present
 * (an org branch keyed on `current_tenant_id()` and a personal branch that
 * additionally requires `organizationId IS NULL`), that the fall-through is
 * `false` rather than open, and that WITH CHECK is as strict as USING.
 */

import { describe, expect, it } from "vitest";
import {
	buildParentScopedPolicySQL,
	buildProjectMemberOrTenantPolicySQL,
	buildProjectSelfMemberOrTenantPolicySQL,
	PARENT_SCOPED_POLICIES,
} from "../scripts/rls-policy-sql";
import {
	createOrganizationContext,
	createPersonalContext,
	runWithTenantContext,
} from "../src/tenant-context";
import {
	getParentScopedFilter,
	mergeWithParentScopedFilter,
} from "../src/tenant-db";

/** Collapse tabs/newlines so assertions are whitespace-insensitive. */
function normalize(sql: string): string {
	return sql.replace(/\s+/g, " ").trim();
}

/** Extract the USING (...) and WITH CHECK (...) bodies of a policy. */
function splitPolicy(sql: string): { using: string; withCheck: string } {
	const normalized = normalize(sql);
	const usingStart = normalized.indexOf("USING (");
	const checkStart = normalized.indexOf("WITH CHECK (");
	expect(usingStart).toBeGreaterThan(-1);
	expect(checkStart).toBeGreaterThan(usingStart);
	return {
		using: normalized.slice(usingStart + "USING (".length, checkStart),
		withCheck: normalized.slice(checkStart + "WITH CHECK (".length),
	};
}

describe("parent-scoped RLS policy SQL", () => {
	describe("project_parent (project_stage_approver)", () => {
		const sql = buildParentScopedPolicySQL(
			"project_stage_approver",
			"project_parent",
		);
		const normalized = normalize(sql);

		it("creates the tenant_isolation policy on the right table", () => {
			expect(normalized).toContain(
				'CREATE POLICY tenant_isolation ON "project_stage_approver"',
			);
		});

		it("joins the parent project via an EXISTS sub-select on projectId", () => {
			expect(normalized).toContain(
				'EXISTS ( SELECT 1 FROM "project" AS p WHERE p."id" = "project_stage_approver"."projectId"',
			);
		});

		it("includes the organization tenant branch", () => {
			expect(normalized).toContain(
				`WHEN 'organization' THEN p."organizationId" = current_tenant_id()`,
			);
		});

		it("includes the personal tenant branch requiring a null organizationId", () => {
			expect(normalized).toContain(
				`WHEN 'personal' THEN p."userId" = current_user_id() AND p."organizationId" IS NULL`,
			);
		});

		it("denies by default when there is no tenant context", () => {
			expect(normalized).toContain("ELSE false");
		});

		it("applies the same predicate to USING and WITH CHECK", () => {
			const { using, withCheck } = splitPolicy(sql);
			expect(using).toContain('FROM "project" AS p');
			expect(withCheck).toContain('FROM "project" AS p');
			expect(withCheck).toContain("ELSE false");
			// WITH CHECK must not be weaker than USING.
			expect(withCheck).toContain(normalize(using).replace(/\)\s*$/, ""));
		});

		it("never reads tenant columns off the child row", () => {
			// Every organizationId/userId reference must be alias-qualified.
			const unqualified = normalized.match(
				/(?<!\.)"(organizationId|userId)"/g,
			);
			expect(unqualified).toBeNull();
		});
	});

	describe("proposal_parent (pending_backlog_proposal_application)", () => {
		const sql = buildParentScopedPolicySQL(
			"pending_backlog_proposal_application",
			"proposal_parent",
		);
		const normalized = normalize(sql);

		it("creates the tenant_isolation policy on the right table", () => {
			expect(normalized).toContain(
				'CREATE POLICY tenant_isolation ON "pending_backlog_proposal_application"',
			);
		});

		it("joins the parent proposal via an EXISTS sub-select on proposalId", () => {
			expect(normalized).toContain(
				'EXISTS ( SELECT 1 FROM "pending_backlog_proposal" AS b WHERE b."id" = "pending_backlog_proposal_application"."proposalId"',
			);
		});

		it("includes the organization tenant branch", () => {
			expect(normalized).toContain(
				`WHEN 'organization' THEN b."organizationId" = current_tenant_id()`,
			);
		});

		it("includes the personal tenant branch requiring a null organizationId", () => {
			expect(normalized).toContain(
				`WHEN 'personal' THEN b."userId" = current_user_id() AND b."organizationId" IS NULL`,
			);
		});

		it("denies by default when there is no tenant context", () => {
			expect(normalized).toContain("ELSE false");
		});

		it("applies the same predicate to USING and WITH CHECK", () => {
			const { using, withCheck } = splitPolicy(sql);
			expect(using).toContain('FROM "pending_backlog_proposal" AS b');
			expect(withCheck).toContain('FROM "pending_backlog_proposal" AS b');
			expect(withCheck).toContain("ELSE false");
		});

		it("never reads tenant columns off the child row", () => {
			const unqualified = normalized.match(
				/(?<!\.)"(organizationId|userId)"/g,
			);
			expect(unqualified).toBeNull();
		});
	});

	it("registers exactly the two supported parent-scoped kinds", () => {
		expect(Object.keys(PARENT_SCOPED_POLICIES).sort()).toEqual([
			"project_parent",
			"proposal_parent",
		]);
	});

	it("is registered in apply-rls-direct for both tables", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(
			new URL("../scripts/apply-rls-direct.ts", import.meta.url),
			"utf8",
		);
		const normalized = normalize(source);
		// project_stage_approver moved to project_member_or_tenant (review
		// round 4): guests who are configured approvers must read it.
		expect(normalized).toMatch(
			/\{ name: "project_stage_approver", policy: "project_member_or_tenant",? \}/,
		);
		expect(normalized).toMatch(
			/\{ name: "stage_transition_request", policy: "project_member_or_tenant",? \}/,
		);
		expect(normalized).toMatch(
			/\{ name: "project", policy: "project_member_or_tenant", childKeyColumn: "id",? \}/,
		);
		expect(normalized).toMatch(
			/name: "pending_backlog_proposal_application", policy: "proposal_parent",? \}/,
		);
	});
});

describe("getParentScopedFilter (tenant-db extension)", () => {
	it("returns null for models that are not parent-scoped", async () => {
		await runWithTenantContext(
			createPersonalContext("user-1"),
			async () => {
				expect(getParentScopedFilter("Project")).toBeNull();
				expect(getParentScopedFilter("UserStory")).toBeNull();
			},
		);
	});

	it("returns null when there is no tenant context (RLS still denies)", () => {
		expect(getParentScopedFilter("ProjectStageApprover")).toBeNull();
		expect(
			getParentScopedFilter("PendingBacklogProposalApplication"),
		).toBeNull();
	});

	it("scopes ProjectStageApprover by organization in org context", async () => {
		await runWithTenantContext(
			createOrganizationContext("org-1", "user-1"),
			async () => {
				expect(getParentScopedFilter("ProjectStageApprover")).toEqual({
					project: { organizationId: "org-1" },
				});
			},
		);
	});

	it("ORs in the guest carve-out for allowedProjectIds (project-scoped guest)", async () => {
		const ctx = createPersonalContext("guest-1");
		ctx.allowedProjectIds.push("proj-host");
		await runWithTenantContext(ctx, async () => {
			expect(getParentScopedFilter("ProjectStageApprover")).toEqual({
				OR: [
					{ project: { userId: "guest-1", organizationId: null } },
					{ projectId: { in: ["proj-host"] } },
				],
			});
			expect(
				getParentScopedFilter("PendingBacklogProposalApplication"),
			).toEqual({
				OR: [
					{ proposal: { userId: "guest-1", organizationId: null } },
					{ proposal: { projectId: { in: ["proj-host"] } } },
				],
			});
		});
	});

	it("scopes ProjectStageApprover by user AND null org in personal context", async () => {
		await runWithTenantContext(
			createPersonalContext("user-1"),
			async () => {
				expect(getParentScopedFilter("ProjectStageApprover")).toEqual({
					project: { userId: "user-1", organizationId: null },
				});
			},
		);
	});

	it("scopes PendingBacklogProposalApplication by organization in org context", async () => {
		await runWithTenantContext(
			createOrganizationContext("org-2", "user-2"),
			async () => {
				expect(
					getParentScopedFilter("PendingBacklogProposalApplication"),
				).toEqual({ proposal: { organizationId: "org-2" } });
			},
		);
	});

	it("scopes PendingBacklogProposalApplication by user AND null org in personal context", async () => {
		await runWithTenantContext(
			createPersonalContext("user-2"),
			async () => {
				expect(
					getParentScopedFilter("PendingBacklogProposalApplication"),
				).toEqual({
					proposal: { userId: "user-2", organizationId: null },
				});
			},
		);
	});

	it("does not leak Org A rows into an Org B context", async () => {
		const orgA = await runWithTenantContext(
			createOrganizationContext("org-A", "user-1"),
			async () => getParentScopedFilter("ProjectStageApprover"),
		);
		const orgB = await runWithTenantContext(
			createOrganizationContext("org-B", "user-1"),
			async () => getParentScopedFilter("ProjectStageApprover"),
		);
		expect(orgA).not.toEqual(orgB);
		expect(orgB).toEqual({ project: { organizationId: "org-B" } });
	});
});

describe("mergeWithParentScopedFilter", () => {
	it("returns the parent filter alone when there is no existing where", async () => {
		await runWithTenantContext(
			createPersonalContext("user-1"),
			async () => {
				expect(
					mergeWithParentScopedFilter(
						"ProjectStageApprover",
						undefined,
					),
				).toEqual({
					project: { userId: "user-1", organizationId: null },
				});
			},
		);
	});

	it("AND-wraps an existing where rather than replacing it", async () => {
		await runWithTenantContext(
			createOrganizationContext("org-1", "user-1"),
			async () => {
				expect(
					mergeWithParentScopedFilter("ProjectStageApprover", {
						projectId: "proj-1",
					}),
				).toEqual({
					AND: [
						{ projectId: "proj-1" },
						{ project: { organizationId: "org-1" } },
					],
				});
			},
		);
	});

	it("leaves the where untouched for non-parent-scoped models", async () => {
		await runWithTenantContext(
			createPersonalContext("user-1"),
			async () => {
				const where = { id: "x" };
				expect(mergeWithParentScopedFilter("Project", where)).toBe(
					where,
				);
			},
		);
	});

	it("leaves the where untouched when there is no tenant context", () => {
		const where = { projectId: "proj-1" };
		expect(mergeWithParentScopedFilter("ProjectStageApprover", where)).toBe(
			where,
		);
	});
});

describe("project_member_or_tenant policy SQL", () => {
	const sql = buildProjectMemberOrTenantPolicySQL("stage_transition_request");

	it("joins the parent project and admits the tenant branch", () => {
		expect(sql).toContain('FROM "project" AS p');
		expect(sql).toContain(
			'WHERE p."id" = "stage_transition_request"."projectId"',
		);
		expect(sql).toContain('p."organizationId" = current_tenant_id()');
		expect(sql).toContain(
			'p."userId" = current_user_id() AND p."organizationId" IS NULL',
		);
	});

	it("correlates the member branch against the TARGET row, never m.projectId itself", () => {
		// Review round 5: an unqualified "projectId" here resolves to
		// m."projectId" and admits every member of any project.
		expect(sql).toContain(
			'm."projectId" = "stage_transition_request"."projectId"',
		);
		expect(sql).not.toMatch(/m\."projectId" = "projectId"/);
	});

	it("ORs in an accepted, non-expired project_member row for the current user", () => {
		expect(sql).toContain('FROM "project_member" AS m');
		expect(sql).toContain('m."userId" = current_user_id()');
		expect(sql).toContain('m."acceptedAt" IS NOT NULL');
		expect(sql).toContain('m."expiresAt" IS NULL OR m."expiresAt" > now()');
	});

	it("applies the same predicate to USING and WITH CHECK", () => {
		const using = sql.split("WITH CHECK")[0];
		const check = sql.split("WITH CHECK")[1];
		expect(using).toContain('FROM "project_member" AS m');
		expect(check).toContain('FROM "project_member" AS m');
	});
});

describe("project_member_or_tenant on the project table itself", () => {
	it("never sub-selects project (policy recursion) and keys the member branch on the row id", () => {
		const sql = buildProjectSelfMemberOrTenantPolicySQL();
		// "project_member" is allowed; a self-select on "project" is not.
		expect(sql).not.toMatch(/FROM "project"\s/);
		expect(sql).toContain(
			'"project"."organizationId" = current_tenant_id()',
		);
		expect(sql).toContain(
			'"project"."userId" = current_user_id() AND "project"."organizationId" IS NULL',
		);
		expect(sql).toContain('m."projectId" = "project"."id"');
	});
});
