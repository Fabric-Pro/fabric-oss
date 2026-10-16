/**
 * Fabric Agent sessions an owner shares with the organization.
 *
 * A session is per user within an organization. When its owner sets
 * `visibility` to ORGANIZATION, every member may READ it; only the owner may
 * write it. Two layers carry that and both are covered here:
 *
 *  1. RLS: `tenant_isolation` (FOR ALL) stays the owner's, and a second,
 *     FOR SELECT policy admits the organization's shared rows. A shared branch
 *     inside the one policy would let a teammate UPDATE or DELETE the row.
 *  2. The Prisma extension: reads also match the organization's shared rows,
 *     writes never do.
 *
 * Pure-unit; no DATABASE_URL needed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	buildPerUserWithOrgSharedReadPolicySQL,
	ORGANIZATION_SHARED_READ_POLICY,
} from "../scripts/rls-policy-sql";
import {
	createOrganizationContext,
	createPersonalContext,
	runWithTenantContext,
} from "../src/tenant-context";
import { createTenantDbClient, mergeWithTenantFilter } from "../src/tenant-db";

const applySrc = readFileSync(
	join(__dirname, "../scripts/apply-rls-direct.ts"),
	"utf8",
);

function normalize(sql: string): string {
	return sql.replace(/\s+/g, " ").trim();
}

const OWNER = { userId: "u_1", organizationId: "org_1" };
const SHARED = { organizationId: "org_1", visibility: "ORGANIZATION" };

describe("per_user_within_org_shared_read policy SQL", () => {
	const [tenantIsolation, sharedRead] =
		buildPerUserWithOrgSharedReadPolicySQL("agent_conversation").map(
			normalize,
		);

	it("keeps every command with the owner under tenant_isolation", () => {
		expect(tenantIsolation).toContain(
			'CREATE POLICY tenant_isolation ON "agent_conversation" FOR ALL',
		);
		const using = tenantIsolation.slice(
			tenantIsolation.indexOf("USING ("),
			tenantIsolation.indexOf("WITH CHECK ("),
		);
		const withCheck = tenantIsolation.slice(
			tenantIsolation.indexOf("WITH CHECK ("),
		);
		for (const body of [using, withCheck]) {
			expect(body).toContain(
				'"agent_conversation"."userId" = current_user_id() AND "agent_conversation"."organizationId" = current_tenant_id()',
			);
			expect(body).toContain("ELSE false");
			expect(body).not.toContain("visibility");
		}
	});

	it("adds a SELECT-only policy for the organization's shared rows", () => {
		expect(sharedRead).toContain(
			`CREATE POLICY ${ORGANIZATION_SHARED_READ_POLICY} ON "agent_conversation" FOR SELECT`,
		);
		expect(sharedRead).toContain(
			`"agent_conversation"."organizationId" = current_tenant_id() AND "agent_conversation"."visibility" = 'ORGANIZATION'`,
		);
		expect(sharedRead).toContain("WHEN 'organization'");
		expect(sharedRead).toContain("ELSE false");
	});

	it("cannot admit a write through the shared policy", () => {
		expect(sharedRead).not.toContain("WITH CHECK");
		expect(sharedRead).not.toContain("FOR ALL");
		expect(sharedRead).not.toContain("current_user_id()");
	});

	it("does not open a shared read to a personal context", () => {
		expect(sharedRead).not.toContain("WHEN 'personal'");
	});
});

describe("the RLS script registers the shared-read policy", () => {
	it("applies it to agent_conversation, with the extra policy dropped and recreated", () => {
		expect(applySrc).toMatch(
			/name:\s*"agent_conversation"\s*,\s*policy:\s*"per_user_within_org_shared_read"/,
		);
		expect(applySrc).toContain('case "per_user_within_org_shared_read"');
		expect(applySrc).toContain("buildPerUserWithOrgSharedReadPolicySQL(");
	});

	it("leaves the turn rows of a shared session with their owner", () => {
		expect(applySrc).toMatch(
			/name:\s*"conversation_turn"\s*,\s*policy:\s*"per_user_within_org"/,
		);
	});
});

describe("AgentConversation on the tenant path", () => {
	const inOrg = <T>(fn: () => T) =>
		runWithTenantContext(createOrganizationContext("org_1", "u_1"), fn);

	it("lets a read match the owner's rows OR the organization's shared rows", () => {
		const filter = inOrg(() =>
			mergeWithTenantFilter("AgentConversation", undefined, "read"),
		);
		expect(filter).toEqual({ OR: [OWNER, SHARED] });
	});

	it("keeps a read's own condition alongside the owner-or-shared filter", () => {
		const filter = inOrg(() =>
			mergeWithTenantFilter("AgentConversation", { id: "c_1" }, "read"),
		);
		expect(filter).toEqual({
			AND: [{ id: "c_1" }, { OR: [OWNER, SHARED] }],
		});
	});

	it("never lets a write match another member's shared row", () => {
		expect(
			inOrg(() =>
				mergeWithTenantFilter("AgentConversation", undefined, "write"),
			),
		).toEqual(OWNER);
		expect(
			inOrg(() => mergeWithTenantFilter("AgentConversation", undefined)),
		).toEqual(OWNER);
	});

	it("shares nothing from a personal context", () => {
		const filter = runWithTenantContext(createPersonalContext("u_1"), () =>
			mergeWithTenantFilter("AgentConversation", undefined, "read"),
		);
		expect(filter).toEqual({ userId: "u_1", organizationId: null });
	});

	it("leaves other per-user tables owner-only on a read", () => {
		const filter = inOrg(() =>
			mergeWithTenantFilter("AiChat", undefined, "read"),
		);
		expect(filter).toEqual(OWNER);
	});
});

describe("the tenant extension routes reads and writes differently", () => {
	function extensionFor() {
		const executeRaw = vi.fn(async () => 1);
		const base = {
			$transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
				fn({ $executeRawUnsafe: executeRaw }),
			$extends: (config: {
				query: {
					$allModels: {
						$allOperations: (args: {
							model: string;
							operation: string;
							args: { where?: unknown };
							query: (args: {
								where?: unknown;
							}) => Promise<unknown>;
						}) => Promise<unknown>;
					};
				};
			}) => config.query.$allModels.$allOperations,
		};
		return createTenantDbClient(
			base as unknown as Parameters<typeof createTenantDbClient>[0],
		) as unknown as (args: {
			model: string;
			operation: string;
			args: { where?: unknown };
			query: (args: { where?: unknown }) => Promise<unknown>;
		}) => Promise<unknown>;
	}

	async function whereSentFor(operation: string) {
		const run = extensionFor();
		let sent: unknown;
		await runWithTenantContext(
			createOrganizationContext("org_1", "u_1"),
			() =>
				run({
					model: "AgentConversation",
					operation,
					args: { where: { id: "c_1" } },
					query: async (args) => {
						sent = args.where;
						return null;
					},
				}),
		);
		return sent;
	}

	it.each(["findMany", "findFirst", "findUnique", "count"])(
		"%s sees shared rows",
		async (operation) => {
			expect(await whereSentFor(operation)).toEqual({
				AND: [{ id: "c_1" }, { OR: [OWNER, SHARED] }],
			});
		},
	);

	it.each(["update", "updateMany", "delete", "deleteMany"])(
		"%s stays with the owner",
		async (operation) => {
			expect(await whereSentFor(operation)).toEqual({
				AND: [{ id: "c_1" }, OWNER],
			});
		},
	);
});

describe("FramePageRecord is organization-only", () => {
	it("filters on the organization in an organization context", () => {
		const filter = runWithTenantContext(
			createOrganizationContext("org_1", "u_1"),
			() => mergeWithTenantFilter("FramePageRecord", undefined, "read"),
		);
		expect(filter).toEqual({ organizationId: "org_1" });
	});

	it("matches nothing from a personal context", () => {
		const filter = runWithTenantContext(createPersonalContext("u_1"), () =>
			mergeWithTenantFilter("FramePageRecord", undefined, "read"),
		);
		expect(filter).toEqual({ organizationId: "___BLOCKED___" });
	});

	it("carries the org_only RLS policy", () => {
		expect(applySrc).toMatch(
			/name:\s*"frame_page_record"\s*,\s*policy:\s*"org_only"/,
		);
	});
});
