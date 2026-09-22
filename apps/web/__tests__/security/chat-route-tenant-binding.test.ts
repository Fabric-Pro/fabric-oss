/**
 * The two non-oRPC chat entry points (`/api/copilotkit` and the direct-chat
 * stream) receive `organizationId` from the client. Both must bind it to the
 * caller's memberships through `resolveRequestedOrganization` before anything
 * tenant-scoped reads it, and neither may fall back to silently substituting
 * the session's active organization.
 *
 * The resolver itself is unit-tested in `@repo/api`; these assertions pin the
 * routes to it so a refactor cannot quietly reintroduce the raw query-string
 * read (Fizzy security review, September 2026).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COPILOTKIT_ROUTE = join(process.cwd(), "app/api/copilotkit/route.ts");
const STREAM_ROUTE = join(
	process.cwd(),
	"app/api/agents/fabric-ai/stream/route.ts",
);

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

	it("filters workspace ids through hasWorkspaceAccess before retrieval", () => {
		const resolveAt = source.indexOf("resolveRequestedOrganization({");
		const accessMatch = source.match(
			/hasWorkspaceAccess\(\s*workspaceId,\s*userId,?\s*\)/,
		);
		expect(accessMatch).not.toBeNull();
		expect(accessMatch?.index ?? -1).toBeGreaterThan(resolveAt);
	});

	// `hasWorkspaceAccess` takes no organization (it used to accept one and
	// ignore it), so the tenant binding is this comparison of the workspace's
	// own organization with the resolved one — exact and null-aware, and made
	// before the access check admits the workspace.
	it("binds each workspace to the resolved organization before admitting it", () => {
		const resolveAt = source.indexOf("resolveRequestedOrganization({");
		const tenantMatch = source.match(
			/\(workspaceTenants\.get\(workspaceId\)\s*\?\?\s*null\)\s*!==\s*\(organizationId\s*\?\?\s*null\)/,
		);
		const accessAt =
			source.match(/hasWorkspaceAccess\(\s*workspaceId,\s*userId,?\s*\)/)
				?.index ?? -1;
		expect(tenantMatch).not.toBeNull();
		expect(tenantMatch?.index ?? -1).toBeGreaterThan(resolveAt);
		expect(tenantMatch?.index ?? -1).toBeLessThan(accessAt);
	});
});
