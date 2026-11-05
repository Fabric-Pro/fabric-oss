import { ORPCError } from "@orpc/server";
import { db, getProblemLogEntry, isOrganizationMember } from "@repo/database";
import { ORGANIZATION_MEMBERSHIP_REQUIRED_CODE } from "../../projects/lib/proposal-artifact-access";

/**
 * The gate every Problem Log procedure runs after `requireProjectPermission`
 * (Fizzy #2277). The log is the organization's audit material, so a project
 * role is not enough: an invited project guest can hold any role but is not
 * a member of the organization that owns the project. The bar is a live
 * `member` row in the OWNING organization, resolved from the project row and
 * never from the session or the input.
 *
 * Handlers first check `input.organizationId` with
 * `resolveProjectOrganizationId`; this gate never reads it.
 *
 * Returns the owning organization id: every query runs in it.
 */
export async function loadProblemLogProject(args: {
	projectId: string;
	userId: string;
}): Promise<{ organizationId: string }> {
	const project = await db.project.findUnique({
		where: { id: args.projectId },
		select: { id: true, organizationId: true, deletedAt: true },
	});
	if (!project || project.deletedAt || !project.organizationId) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}

	if (!(await isOrganizationMember(args.userId, project.organizationId))) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Only members of this project's organization can see its Problem Log.",
			data: { code: ORGANIZATION_MEMBERSHIP_REQUIRED_CODE },
		});
	}
	return { organizationId: project.organizationId };
}

/** The entry, or NOT_FOUND when it is missing or belongs to another project. */
export async function loadProjectEntry(
	organizationId: string,
	projectId: string,
	entryId: string,
) {
	const entry = await getProblemLogEntry(organizationId, entryId);
	if (!entry || entry.projectId !== projectId) {
		throw new ORPCError("NOT_FOUND", { message: "Entry not found" });
	}
	return entry;
}

/** Audit actor for the signed-in caller. */
export function auditActor(context: {
	user: { id: string; email?: string | null; name?: string | null };
	session?: { impersonatedBy?: string | null } | null;
}) {
	return {
		userId: context.user.id,
		emailSnapshot: context.user.email ?? null,
		nameSnapshot: context.user.name ?? null,
		impersonatedById: context.session?.impersonatedBy ?? null,
	};
}
