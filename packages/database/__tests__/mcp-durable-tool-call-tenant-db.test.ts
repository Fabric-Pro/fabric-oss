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

describe("McpDurableToolCall tenant registration", () => {
	it("filters by both authenticated user and organization", () => {
		const filter = runWithTenantContext(
			createOrganizationContext("org_example", "user_example"),
			() => mergeWithTenantFilter("McpDurableToolCall", undefined),
		);
		expect(filter).toEqual({
			userId: "user_example",
			organizationId: "org_example",
		});
	});

	it("uses per_user_within_org RLS", () => {
		expect(applySrc).toMatch(
			/name:\s*"mcp_durable_tool_call"\s*,\s*policy:\s*"per_user_within_org"/,
		);
	});
});
