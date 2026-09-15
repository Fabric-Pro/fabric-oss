/**
 * Pure SQL builders for RLS policies on parent-scoped tables.
 *
 * A "parent-scoped" table carries no `userId` / `organizationId` of its own —
 * it is reachable only through a foreign key to a parent row that does. The
 * policy therefore re-uses the parent's `user_owned` predicate through an
 * `EXISTS` join instead of reading tenant columns off the child row.
 *
 * This module is intentionally free of database imports so the generated SQL
 * can be unit-tested without a live connection. `apply-rls-direct.ts` is the
 * only production consumer.
 */

export type ParentScopedPolicyKind = "project_parent" | "proposal_parent";

export interface ParentScopedPolicyConfig {
	/** Parent table name as it exists in Postgres (already snake-cased). */
	parentTable: string;
	/** Alias used for the parent inside the EXISTS sub-select. */
	parentAlias: string;
	/** Column on the parent the child FK points at (normally `id`). */
	parentKeyColumn: string;
	/** FK column on the child row. */
	childKeyColumn: string;
}

/**
 * Registry of the supported parent-scoped policy kinds.
 *
 * - `project_parent`  → child rows hang off `project` via `projectId`
 *   (e.g. `project_stage_approver`).
 * - `proposal_parent` → child rows hang off `pending_backlog_proposal` via
 *   `proposalId` (e.g. `pending_backlog_proposal_application`).
 *
 * Both parents use the `user_owned` policy shape, so the predicate below
 * mirrors the `user_owned` case in `apply-rls-direct.ts` exactly.
 */
export const PARENT_SCOPED_POLICIES: Record<
	ParentScopedPolicyKind,
	ParentScopedPolicyConfig
> = {
	project_parent: {
		parentTable: "project",
		parentAlias: "p",
		parentKeyColumn: "id",
		childKeyColumn: "projectId",
	},
	proposal_parent: {
		parentTable: "pending_backlog_proposal",
		parentAlias: "b",
		parentKeyColumn: "id",
		childKeyColumn: "proposalId",
	},
};

/**
 * The `user_owned` tenant predicate, expressed against a parent alias.
 *
 * Org context  : the parent belongs to the current organization.
 * Personal ctx : the parent belongs to the current user and to no org.
 * No context   : deny.
 */
function parentUserOwnedPredicate(alias: string): string {
	return `CASE current_tenant_type()
										WHEN 'organization' THEN
											${alias}."organizationId" = current_tenant_id()
										WHEN 'personal' THEN
											${alias}."userId" = current_user_id() AND ${alias}."organizationId" IS NULL
										ELSE false
									END`;
}

/** The EXISTS clause shared by USING and WITH CHECK. */
function parentExistsClause(
	tableName: string,
	config: ParentScopedPolicyConfig,
): string {
	const { parentTable, parentAlias, parentKeyColumn, childKeyColumn } =
		config;
	// Qualify the outer column with the policy target's table name so it can
	// never resolve to a same-named column on the parent.
	return `EXISTS (
									SELECT 1
									FROM "${parentTable}" AS ${parentAlias}
									WHERE ${parentAlias}."${parentKeyColumn}" = "${tableName}"."${childKeyColumn}"
									AND ${parentUserOwnedPredicate(parentAlias)}
								)`;
}

/**
 * Build the `tenant_isolation` policy for a table whose tenancy is inherited
 * from a parent row. USING and WITH CHECK are identical: a row is visible and
 * writable only when its parent is visible to the current tenant.
 */
export function buildParentScopedPolicySQL(
	tableName: string,
	kindOrConfig: ParentScopedPolicyKind | ParentScopedPolicyConfig,
): string {
	const config =
		typeof kindOrConfig === "string"
			? PARENT_SCOPED_POLICIES[kindOrConfig]
			: kindOrConfig;

	const exists = parentExistsClause(tableName, config);

	return `
							CREATE POLICY tenant_isolation ON "${tableName}"
							USING (
								${exists}
							)
							WITH CHECK (
								${exists}
							)
						`;
}

// ---------------------------------------------------------------------------
// project_member_or_tenant
// ---------------------------------------------------------------------------

/**
 * Policy for rows that belong to a project and must be readable AND writable
 * by every user who is authorized on that project, not only by the project's
 * tenant identity.
 *
 * Why this exists: governed stage transitions on a personal project are
 * requested and approved by project-scoped guests (accepted `ProjectMember`
 * rows without org membership). Their RLS session identity is their own
 * personal tenant, but the rows they create must be tenant-owned by the
 * project OWNER so the owner's `user_owned` policies accept them
 * (`tenantOwnerFor` in `src/delivery/transition-story.ts`). A plain
 * `user_owned` policy on the child table would therefore reject the guest's
 * insert. This policy admits a row when its parent project is visible to the
 * current tenant OR the current user holds an accepted, non-expired
 * `project_member` row on that project.
 */
export function buildProjectMemberOrTenantPolicySQL(
	tableName: string,
	childKeyColumn = "projectId",
): string {
	// Two independent branches. The member branch deliberately does NOT go
	// through the `project` row: `project` carries its own user_owned policy,
	// and RLS applies inside policy sub-selects, so a guest (who cannot see the
	// owner's project row) would otherwise never satisfy the join.
	// The outer row is referenced with its table name. An unqualified
	// "projectId" inside the project_member sub-select would resolve to
	// m."projectId" (a self-comparison that admits every member of any
	// project) — review round 5.
	const outer = `"${tableName}"."${childKeyColumn}"`;
	const predicate = `(
									EXISTS (
										SELECT 1
										FROM "project" AS p
										WHERE p."id" = ${outer}
										AND ${parentUserOwnedPredicate("p")}
									)
									OR EXISTS (
										SELECT 1
										FROM "project_member" AS m
										WHERE m."projectId" = ${outer}
										AND m."userId" = current_user_id()
										AND m."acceptedAt" IS NOT NULL
										AND (m."expiresAt" IS NULL OR m."expiresAt" > now())
									)
								)`;
	return `
							CREATE POLICY tenant_isolation ON "${tableName}"
							USING (
								${predicate}
							)
							WITH CHECK (
								${predicate}
							)
						`;
}

/**
 * The same policy for the `project` table itself. It cannot sub-select
 * `project` (Postgres reports "infinite recursion detected in policy"), so
 * the tenant branch reads the row's own columns and the member branch joins
 * `project_member` on the row's id.
 */
export function buildProjectSelfMemberOrTenantPolicySQL(): string {
	const predicate = `(
									CASE current_tenant_type()
										WHEN 'organization' THEN
											"project"."organizationId" = current_tenant_id()
										WHEN 'personal' THEN
											"project"."userId" = current_user_id() AND "project"."organizationId" IS NULL
										ELSE false
									END
									OR EXISTS (
										SELECT 1
										FROM "project_member" AS m
										WHERE m."projectId" = "project"."id"
										AND m."userId" = current_user_id()
										AND m."acceptedAt" IS NOT NULL
										AND (m."expiresAt" IS NULL OR m."expiresAt" > now())
									)
								)`;
	return `
							CREATE POLICY tenant_isolation ON "project"
							USING (
								${predicate}
							)
							WITH CHECK (
								${predicate}
							)
						`;
}

/**
 * Frames (`agent_workspace_file`): the creator's per-user-within-org rows as
 * before, PLUS rows that belong to a project (`projectId` set) when the
 * current user is authorized on that project (tenant branch on the project or
 * an accepted, non-expired `project_member` row). Spike demos are created by
 * a worker on behalf of the run's user and must be visible to the whole
 * project team (Slice 3).
 */
export function buildFrameProjectOrUserPolicySQL(): string {
	const perUser = `CASE current_tenant_type()
										WHEN 'organization' THEN
											"agent_workspace_file"."userId" = current_user_id() AND "agent_workspace_file"."organizationId" = current_tenant_id()
										WHEN 'personal' THEN
											"agent_workspace_file"."userId" = current_user_id() AND "agent_workspace_file"."organizationId" IS NULL
										ELSE false
									END`;
	const projectBranch = `(
										"agent_workspace_file"."projectId" IS NOT NULL
										AND (
											EXISTS (
												SELECT 1
												FROM "project" AS p
												WHERE p."id" = "agent_workspace_file"."projectId"
												AND ${parentUserOwnedPredicate("p")}
											)
											OR EXISTS (
												SELECT 1
												FROM "project_member" AS m
												WHERE m."projectId" = "agent_workspace_file"."projectId"
												AND m."userId" = current_user_id()
												AND m."acceptedAt" IS NOT NULL
												AND (m."expiresAt" IS NULL OR m."expiresAt" > now())
											)
										)
									)`;
	const predicate = `(${perUser} OR ${projectBranch})`;
	return `
							CREATE POLICY tenant_isolation ON "agent_workspace_file"
							USING (
								${predicate}
							)
							WITH CHECK (
								${predicate}
							)
						`;
}
