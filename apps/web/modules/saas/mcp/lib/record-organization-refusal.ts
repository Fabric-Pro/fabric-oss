/**
 * Record a refused organization selection in the audit ledger.
 *
 * Both protocol entry points answer the same question — may this caller act in
 * the organization they named — and a refusal is the only trace the attempt
 * leaves: the request never reaches a tenant-scoped query, so nothing
 * downstream would log it. The two servers therefore have to record the same
 * event, and they record it from here rather than each keeping a copy. The
 * hosted server had one and the gateway had none, which is what this module
 * exists to stop happening again.
 *
 * Fire-and-forget on purpose: a failure to write the row must never change the
 * answer the caller gets. Authorization does not depend on logging succeeding.
 *
 * The row carries a null `organizationId` deliberately. The caller has no
 * standing in the organization they named, so the event does not belong in
 * that organization's log; the named id is kept in `metadata` instead, where
 * it is evidence rather than tenancy.
 */
export function recordOrganizationRefusal(
	headers: Headers,
	actor: { userId: string; email: string; name: string | null },
	requestedOrganizationId: string,
	/** Which entry point refused, so the two are tellable apart in the ledger. */
	transport: "mcp-http" | "mcp-gateway",
): void {
	void import("@repo/api/lib/audit")
		.then(({ recordAuditFromRequest }) => {
			recordAuditFromRequest(
				{
					headers,
					user: {
						id: actor.userId,
						email: actor.email,
						name: actor.name,
					},
				},
				{
					action: "mcp.session.organization_denied",
					category: "mcp",
					severity: "warning",
					outcome: "failure",
					// The identity goes on the actor explicitly. An actor
					// override replaces what the request context would have
					// supplied, so `{ type: "api_key" }` alone writes a row
					// with no user on it — and a refusal nobody can attribute
					// is not evidence, which is the only reason this row
					// exists.
					actor: {
						type: "api_key",
						userId: actor.userId,
						emailSnapshot: actor.email,
						nameSnapshot: actor.name,
					},
					organizationId: null,
					resource: {
						type: "organization",
						id: requestedOrganizationId,
					},
					metadata: {
						requestedOrganizationId,
						transport,
					},
				},
			);
		})
		.catch((error) => {
			console.warn(
				"[Fabric MCP] organization refusal audit dispatch failed:",
				error,
			);
		});
}
