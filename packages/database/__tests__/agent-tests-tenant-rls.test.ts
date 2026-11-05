import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	createOrganizationContext,
	createPersonalContext,
	runWithTenantContext,
} from "../src/tenant-context";
import { mergeWithTenantFilter } from "../src/tenant-db";
import { matchesWhere } from "./_helpers/in-memory-rows";

const models = ["AgentTestCase", "AgentTestRun"];
const rls = readFileSync(
	new URL("../scripts/apply-rls-direct.ts", import.meta.url),
	"utf8",
).replace(/\s+/g, " ");
describe("saved agent tests belong to one member within an organization", () => {
	it("keeps per-member and organization-wide user-owned registrations disjoint", () => {
		const source = readFileSync(
			new URL("../src/tenant-db.ts", import.meta.url),
			"utf8",
		);
		const members = (name: string) =>
			[
				...(
					source.match(
						new RegExp(
							`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`,
						),
					)?.[1] ?? ""
				).matchAll(/"([A-Za-z]+)"/g),
			].map((match) => match[1]);
		const perMember = members("PER_USER_ORG_TABLES");
		const userOwned = members("USER_OWNED_TABLES");
		expect(perMember.length).toBeGreaterThan(20);
		expect(userOwned.length).toBeGreaterThan(50);
		expect(perMember.filter((model) => userOwned.includes(model))).toEqual(
			[],
		);
		for (const model of models) {
			expect(perMember).toContain(model);
			expect(userOwned).not.toContain(model);
		}
	});
	it.each(models)(
		"%s limits reads and writes by both owner and organization",
		(model) => {
			for (const access of ["read", "write"] as const) {
				const filter = runWithTenantContext(
					createOrganizationContext("example-org", "example-user"),
					() =>
						mergeWithTenantFilter(
							model,
							{ id: "example-row" },
							access,
						),
				);
				expect(filter).toEqual({
					AND: [
						{ id: "example-row" },
						{
							userId: "example-user",
							organizationId: "example-org",
						},
					],
				});
				for (const [userId, organizationId, allowed] of [
					["example-user", "example-org", true],
					["example-member", "example-org", false],
					["example-user", "example-other-org", false],
					["example-user", null, false],
				] as const) {
					expect(
						matchesWhere(
							{ id: "example-row", userId, organizationId },
							filter,
						),
					).toBe(allowed);
				}
			}
		},
	);
	it.each(models)(
		"%s preserves unique selectors without permitting injected owners",
		(model) => {
			const filter = runWithTenantContext(
				createOrganizationContext("example-org", "example-user"),
				() =>
					mergeWithTenantFilter(
						model,
						{ id: "example-row", userId: "other-user" },
						"write",
						true,
					),
			);
			expect(
				matchesWhere(
					{
						id: "example-row",
						userId: "other-user",
						organizationId: "example-org",
					},
					filter,
				),
			).toBe(false);
			expect(filter).toMatchObject({
				id: "example-row",
				AND: [
					{ userId: "example-user", organizationId: "example-org" },
				],
			});
		},
	);
	it.each(models)(
		"%s cannot match organization rows through the fail-closed null arm",
		(model) => {
			const filter = runWithTenantContext(
				createPersonalContext("example-user"),
				() => mergeWithTenantFilter(model, undefined),
			);
			expect(filter).toEqual({
				userId: "example-user",
				organizationId: null,
			});
			expect(
				matchesWhere(
					{ userId: "example-user", organizationId: "example-org" },
					filter,
				),
			).toBe(false);
		},
	);
	it.each(["agent_test_case", "agent_test_run"])(
		"%s uses owner-within-org RLS",
		(table) => {
			expect(rls).toContain(
				`{ name: "${table}", policy: "per_user_within_org" }`,
			);
		},
	);
});
