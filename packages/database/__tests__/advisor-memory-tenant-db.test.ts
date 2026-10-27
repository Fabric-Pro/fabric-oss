import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	createOrganizationContext,
	createPersonalContext,
	runWithTenantContext,
} from "../src/tenant-context";
import { mergeWithTenantFilter } from "../src/tenant-db";

const rls = readFileSync(
	new URL("../scripts/apply-rls-direct.ts", import.meta.url),
	"utf8",
);

describe.each([
	["EpisodicMemory", "episodic_memory"],
	["OrchestratorMemoryPreferences", "orchestrator_memory_preferences"],
])("%s tenant isolation", (model, table) => {
	it("scopes organization reads and writes to the requesting user", () => {
		for (const operation of ["read", "write"] as const) {
			const where = runWithTenantContext(
				createOrganizationContext("example-org", "example-user"),
				() => mergeWithTenantFilter(model, undefined, operation),
			);
			expect(where).toEqual({
				userId: "example-user",
				organizationId: "example-org",
			});
		}
	});

	it("keeps the organization-less arm separate", () => {
		const where = runWithTenantContext(
			createPersonalContext("example-user"),
			() => mergeWithTenantFilter(model, undefined),
		);
		expect(where).toEqual({
			userId: "example-user",
			organizationId: null,
		});
	});

	it("registers the matching database policy", () => {
		expect(rls).toMatch(
			new RegExp(
				`\\{\\s*name: "${table}",\\s*policy: "per_user_within_org",?\\s*\\}`,
			),
		);
	});
});
