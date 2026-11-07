import { db, type Prisma } from "../client";
import { canEditProject, hasProjectAccess } from "./projects/projects";

/** Owning a saved Frame does not retain access to a project after membership is revoked. */
export async function canAccessFrameProject(
	frame: { projectId: string | null; organizationId: string | null },
	userId: string,
	write = false,
	tx: Prisma.TransactionClient = db,
) {
	if (!frame.projectId) {
		return Boolean(frame.organizationId);
	}
	if (
		!frame.organizationId ||
		!(await tx.project.findFirst({
			where: {
				id: frame.projectId,
				organizationId: frame.organizationId,
				deletedAt: null,
			},
			select: { id: true },
		}))
	) {
		return false;
	}
	return (
		(await hasProjectAccess(
			frame.projectId,
			userId,
			frame.organizationId,
			tx,
		)) &&
		(!write || (await canEditProject(frame.projectId, userId, tx)))
	);
}
