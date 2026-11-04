import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildProjectMemberOrTenantConsistentPolicySQL } from "../scripts/rls-policy-sql";
import {
	createOrganizationContext,
	createPersonalContext,
	runWithTenantContext,
} from "../src/tenant-context";
import { mergeWithTenantFilter } from "../src/tenant-db";
import { matchesWhere } from "./_helpers/in-memory-rows";

const projectModels = [
	"ProjectContextQualityBinding",
	"ProjectContextQualityRun",
];
const allModels = [...projectModels, "ProjectContextQualityPrincipal"];
const selectorFor = (model: string) =>
	model === "ProjectContextQualityPrincipal"
		? { fingerprint: "a".repeat(64) }
		: { id: "example-row" };

describe("saved context quality tenant extension", () => {
	it.each(allModels)(
		"%s scopes both reads and writes to the organization, not attribution",
		(model) => {
			const selector = selectorFor(model);
			for (const access of ["read", "write"] as const) {
				const filter = runWithTenantContext(
					createOrganizationContext("example-org", "example-user"),
					() => mergeWithTenantFilter(model, selector, access),
				);
				expect(
					matchesWhere(
						{
							...selector,
							organizationId: "example-org",
							requestedBy: "example-other-user",
						},
						filter,
					),
				).toBe(true);
				expect(
					matchesWhere(
						{ ...selector, organizationId: "example-other-org" },
						filter,
					),
				).toBe(false);
				expect(filter).toEqual({
					AND: [selector, { organizationId: "example-org" }],
				});
			}
		},
	);
	it.each(allModels)(
		"%s fails closed without organization resolution",
		(model) => {
			const filter = runWithTenantContext(
				createPersonalContext("example-user"),
				() => mergeWithTenantFilter(model, undefined),
			);
			expect(filter).toEqual({ organizationId: "___BLOCKED___" });
		},
	);
	it.each(projectModels)(
		"%s keeps the explicit project guest carve-out without admitting other projects",
		(model) => {
			const ctx = createOrganizationContext(
				"example-guest-org",
				"example-guest",
			);
			ctx.allowedProjectIds.push("example-invited-project");
			runWithTenantContext(ctx, () => {
				for (const access of ["read", "write"] as const) {
					const filter = mergeWithTenantFilter(
						model,
						undefined,
						access,
					);
					expect(
						matchesWhere(
							{
								organizationId: "example-host-org",
								projectId: "example-invited-project",
							},
							filter,
						),
					).toBe(true);
					expect(
						matchesWhere(
							{
								organizationId: "example-host-org",
								projectId: "example-uninvited-project",
							},
							filter,
						),
					).toBe(false);
				}
				const principalFilter = mergeWithTenantFilter(
					"ProjectContextQualityPrincipal",
					undefined,
					"read",
				);
				expect(principalFilter).toEqual({
					organizationId: "example-guest-org",
				});
			});
		},
	);
	it.each(allModels)(
		"%s preserves unique selectors while rejecting cross-org requests",
		(model) => {
			const selector = selectorFor(model);
			const filter = runWithTenantContext(
				createOrganizationContext("example-org", "example-user"),
				() =>
					mergeWithTenantFilter(
						model,
						{ ...selector, organizationId: "example-other-org" },
						"write",
						true,
					),
			);
			expect(filter).toEqual({
				...selector,
				organizationId: "example-other-org",
				AND: [{ organizationId: "example-org" }],
			});
		},
	);
});

describe("saved context quality RLS registration", () => {
	it("registers project-consistent policies for bindings/runs, and organization-only principal claims", async () => {
		const source = (
			await readFile(
				new URL("../scripts/apply-rls-direct.ts", import.meta.url),
				"utf8",
			)
		)
			.replace(/\/\/[^\n]*/g, "")
			.replace(/\s+/g, " ");
		for (const table of [
			"project_context_quality_binding",
			"project_context_quality_run",
		]) {
			expect(source).toMatch(
				new RegExp(
					`name: "${table}", policy: "project_member_or_tenant_consistent"`,
				),
			);
			const sql = buildProjectMemberOrTenantConsistentPolicySQL(
				table,
			).replace(/\s+/g, " ");
			const check = sql.split("WITH CHECK")[1]!;
			expect(sql).toContain(`m."projectId" = "${table}"."projectId"`);
			expect(sql).toContain('m."acceptedAt" IS NOT NULL');
			expect(sql).toContain(
				'm."expiresAt" IS NULL OR m."expiresAt" > now()',
			);
			expect(check).toContain(`op."id" = "${table}"."projectId"`);
			expect(check).toContain(
				`op."organizationId" = "${table}"."organizationId"`,
			);
		}
		expect(source).toMatch(
			/name: "project_context_quality_principal", policy: "org_only"/,
		);
	});
});
