/**
 * ChatGPT plan tables — tenant registration (Fizzy #2939).
 *
 * `ChatGptPlanOrgUse` is per user within an organization: registered as
 * `per_user_within_org` for RLS and in `PER_USER_ORG_TABLES`, so a colleague's
 * choice is invisible on the tenant path. `ChatGptPlanCredential` carries no
 * organizationId and is deliberately in neither registry: it is read only by
 * the owning user's id.
 *
 * Pure-unit; no DATABASE_URL needed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createOrganizationContext,
	runWithTenantContext,
} from "../src/tenant-context";
import { mergeWithTenantFilter } from "../src/tenant-db";

const applySrc = readFileSync(
	join(__dirname, "../scripts/apply-rls-direct.ts"),
	"utf8",
);

describe("ChatGptPlanOrgUse is scoped to its own user within the organization", () => {
	it("filters on BOTH userId and organizationId in an organization context", () => {
		const filter = runWithTenantContext(
			createOrganizationContext("org_1", "u_1"),
			() => mergeWithTenantFilter("ChatGptPlanOrgUse", undefined),
		);
		expect(filter).toEqual({ userId: "u_1", organizationId: "org_1" });
	});

	it("carries the per_user_within_org RLS policy", () => {
		expect(applySrc).toMatch(
			/name:\s*"chat_gpt_plan_org_use"\s*,\s*policy:\s*"per_user_within_org"/,
		);
	});

	it("leaves the credential table out of RLS, since it has no organizationId", () => {
		expect(applySrc).not.toMatch(/"chat_gpt_plan_credential"/);
	});
});

// Fizzy #2770: the organization's shared plan accounts and pooling policy
// belong to the organization, so every member reads the same rows; the
// per-source breaker table has no organizationId and is in neither registry.
describe("ChatGPT plan pooling tables are organization-only", () => {
	it.each(["ChatGptPlanOrgAccount", "ChatGptPlanOrgPolicy"])(
		"%s filters on organizationId alone in an organization context",
		(model) => {
			const filter = runWithTenantContext(
				createOrganizationContext("org_1", "u_1"),
				() => mergeWithTenantFilter(model, undefined),
			);
			expect(filter).toEqual({ organizationId: "org_1" });
		},
	);

	it.each(["chat_gpt_plan_org_account", "chat_gpt_plan_org_policy"])(
		"%s carries the org_only RLS policy",
		(table) => {
			expect(applySrc).toMatch(
				new RegExp(`name:\\s*"${table}"\\s*,\\s*policy:\\s*"org_only"`),
			);
		},
	);

	it("leaves the breaker table out of RLS, since it has no organizationId", () => {
		expect(applySrc).not.toMatch(/name:\s*"chat_gpt_plan_source_state"/);
	});
});
