/**
 * The non-oRPC chat entry points (`/api/copilotkit`, the direct-chat stream
 * and the orchestrator stream) receive `organizationId` and workspace ids from
 * the client.
 *
 * `/api/copilotkit` and the direct-chat stream must bind the organization to
 * the caller's memberships through `resolveRequestedOrganization` before
 * anything tenant-scoped reads it, and neither may fall back to silently
 * substituting the session's active organization. The orchestrator stream
 * checks membership of the requested organization directly.
 *
 * Both streams must then narrow the workspace ids, whether sent in the body or
 * read from the conversation's attachments, through
 * `filterAccessibleWorkspaceIds`, so retrieval only reads workspaces the
 * caller can open inside the tenant the turn runs in.
 *
 * The resolver and the workspace filter are unit-tested in `@repo/api` and
 * `@repo/database`; these assertions pin the routes to them so a refactor
 * cannot quietly reintroduce the raw query-string read or pass workspace ids
 * straight through (Fizzy security review, September 2026).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COPILOTKIT_ROUTE = join(process.cwd(), "app/api/copilotkit/route.ts");
const STREAM_ROUTE = join(
	process.cwd(),
	"app/api/agents/fabric-ai/stream/route.ts",
);
const ORCHESTRATOR_STREAM_ROUTE = join(
	process.cwd(),
	"app/api/agents/fabric-ai/orchestrator-temporal/stream/route.ts",
);

/** The `filterAccessibleWorkspaceIds({ ... })` call, arguments included. */
function workspaceFilterCall(source: string): { at: number; call: string } {
	const at = source.indexOf("filterAccessibleWorkspaceIds({");
	return { at, call: source.slice(at, source.indexOf("});", at) + 3) };
}

function read(path: string): string {
	return readFileSync(path, "utf-8");
}

describe("/api/copilotkit organization binding", () => {
	const source = read(COPILOTKIT_ROUTE);

	it("resolves the requested organization through the membership resolver", () => {
		expect(source).toContain("resolveRequestedOrganization({");
		expect(source).toContain("forbiddenOrganizationResponse(");
	});

	it("does not read the query-string organization straight into `organizationId`", () => {
		expect(source).not.toMatch(
			/const organizationId\s*=\s*url\.searchParams\.get\("organizationId"\)/,
		);
	});

	it("hands the session's active organization to the resolver so an omitted id cannot fall through to a null tenant (ADR-018)", () => {
		const call = source.slice(
			source.indexOf("resolveRequestedOrganization({"),
		);
		const block = call.slice(0, call.indexOf("});") + 3);
		expect(block).toContain(
			"activeOrganizationId: session.session.activeOrganizationId",
		);
	});

	it("checks membership before the tenant config is resolved", () => {
		const resolveAt = source.indexOf("resolveRequestedOrganization({");
		const tenantConfigAt = source.indexOf("await getTenantConfig(");
		expect(resolveAt).toBeGreaterThan(-1);
		expect(tenantConfigAt).toBeGreaterThan(resolveAt);
	});
});

describe("direct-chat stream organization binding", () => {
	const source = read(STREAM_ROUTE);

	it("resolves the requested organization through the membership resolver", () => {
		expect(source).toContain("resolveRequestedOrganization({");
		expect(source).toContain("forbiddenOrganizationResponse(");
	});

	it("hands the session's active organization to the resolver so an omitted id cannot fall through to a null tenant (ADR-018)", () => {
		const call = source.slice(
			source.indexOf("resolveRequestedOrganization({"),
		);
		const block = call.slice(0, call.indexOf("});") + 3);
		expect(block).toContain(
			"activeOrganizationId: session.session.activeOrganizationId",
		);
	});

	it("no longer substitutes the session's active organization on mismatch", () => {
		expect(source).not.toContain("sessionOrgId");
	});

	it("only derives context from conversations the caller owns", () => {
		expect(source).toMatch(
			/db\.agentConversation\.findFirst\(\{\s*where:\s*\{\s*id:\s*conversationId,\s*userId\s*\}/,
		);
	});

	// `hasWorkspaceAccess` takes no organization, so access alone would admit a
	// workspace the user can open in another organization. The shared filter
	// makes the exact, null-aware tenant comparison first and the access check
	// second; it must run against the resolved organization, not the raw one.
	it("filters workspace ids through filterAccessibleWorkspaceIds after the organization is resolved", () => {
		const resolveAt = source.indexOf("resolveRequestedOrganization({");
		const { at, call } = workspaceFilterCall(source);
		expect(resolveAt).toBeGreaterThan(-1);
		expect(at).toBeGreaterThan(resolveAt);
		expect(call).toMatch(/\bworkspaceIds\b/);
		expect(call).toMatch(/\buserId\b/);
		expect(call).toMatch(/\borganizationId\b/);
		expect(call).not.toContain("rawOrganizationId");
	});

	it("continues the turn with only the ids the filter allowed", () => {
		const { at } = workspaceFilterCall(source);
		const assignAt = source.indexOf("workspaceIds = allowed;");
		expect(assignAt).toBeGreaterThan(at);
		// No hand-rolled copy of the rule left beside the shared helper.
		expect(source).not.toContain("workspaceTenants");
	});
});

describe("orchestrator stream workspace binding", () => {
	const source = read(ORCHESTRATOR_STREAM_ROUTE);
	const membershipAt = source.indexOf("db.member.findFirst(");
	const workflowInputAt = source.indexOf(
		"const workflowInput: OrchestratorWorkflowInput = {",
	);
	const workflowInputLiteral = source.slice(
		workflowInputAt,
		source.indexOf("\n\t\t};", workflowInputAt),
	);

	it("filters workspace ids after the organization membership check and before the workflow input is built", () => {
		const { at } = workspaceFilterCall(source);
		expect(membershipAt).toBeGreaterThan(-1);
		expect(workflowInputAt).toBeGreaterThan(-1);
		expect(at).toBeGreaterThan(membershipAt);
		expect(workflowInputAt).toBeGreaterThan(at);
	});

	it("binds the filter to the caller and the request's organization", () => {
		const { call } = workspaceFilterCall(source);
		expect(call).toMatch(/\bworkspaceIds\b/);
		expect(call).toMatch(/\buserId\b/);
		expect(call).toContain("organizationId: organizationId ?? null");
	});

	it("hands the workflow only the filtered list", () => {
		const { at } = workspaceFilterCall(source);
		const assignments = [...source.matchAll(/\bworkspaceIds\s*=[^=]/g)].map(
			(match) => match.index ?? -1,
		);
		// The last write to `workspaceIds` is the filter's result, and nothing
		// after the filter rewrites it before the workflow input reads it.
		const assignAt = source.indexOf("workspaceIds = allowed;");
		expect(assignAt).toBeGreaterThan(at);
		expect(assignAt).toBeLessThan(workflowInputAt);
		expect(assignments.filter((index) => index > at)).toEqual([assignAt]);
		expect(workflowInputLiteral).toMatch(/\n\s*workspaceIds,\n/);
	});

	it("does not trust the body's workspace ids to be an array of strings", () => {
		expect(source).toMatch(/Array\.isArray\(rawWorkspaceIds\)/);
		expect(source).not.toMatch(/workspaceIds:\s*providedWorkspaceIds\s*=/);
	});
});
