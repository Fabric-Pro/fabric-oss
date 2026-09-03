import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";

/**
 * A PROJECT binding is an ORG binding narrowed to one project, so the project
 * MUST belong to the caller's organization — otherwise pairing one org's id
 * with another org's project id would stamp cross-tenant reach onto a row.
 * Resolved here rather than trusted from the request.
 *
 * Shared by every path that accepts a `projectId`, reads or writes. The write
 * gate and the two read procedures each grew their own copy of this check and
 * they had already drifted in their error text; a fourth copy is how one of
 * them ends up without the organization comparison at all.
 */
export async function resolveProjectForOrg(
	projectId: string | null | undefined,
	organizationId: string | null | undefined,
): Promise<string | null> {
	if (!projectId) {
		return null;
	}
	if (!organizationId) {
		throw new ORPCError("BAD_REQUEST", {
			message: "A project scope applies only inside an organization",
		});
	}
	const project = await db.project.findFirst({
		where: { id: projectId, deletedAt: null },
		select: { id: true, organizationId: true },
	});
	if (!project || project.organizationId !== organizationId) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"That project does not belong to this organization, so it cannot receive its prompt defaults",
		});
	}
	return project.id;
}
