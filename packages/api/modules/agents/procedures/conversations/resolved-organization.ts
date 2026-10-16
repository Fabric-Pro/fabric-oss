import { ORPCError } from "@orpc/server";
import { resolveOrganizationId } from "../../../../orpc/procedures";

/**
 * The organization a request runs in, narrowed to a string for the queries
 * below it.
 *
 * Authorization has already happened by the time a handler runs:
 * `requireInputOrgPermission(..., { requireOrganization: true })` refuses a
 * request that resolves no organization, checks the caller is a member of the
 * one it resolves, and checks their role there holds the permission. What is
 * left is the type, and a refusal that keeps a query from ever running without
 * an organization filter if that middleware is ever dropped from a procedure.
 */
export function resolvedOrganizationId(
	input: { organizationId?: string | null },
	session: { activeOrganizationId?: string | null },
): string {
	const organizationId = resolveOrganizationId(input.organizationId, session);
	if (typeof organizationId !== "string" || organizationId.length === 0) {
		throw new ORPCError("FORBIDDEN", {
			message: "This request needs an organization",
		});
	}
	return organizationId;
}
