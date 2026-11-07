import { db, type Prisma } from "../client";
import { canAccessReportInstance } from "./lib/report-access";
import { canEditProject, hasProjectAccess } from "./projects/projects";

type ReportFrame = {
	sourceRunType?: string | null;
	sourceRunId?: string | null;
	organizationId?: string | null;
	userId: string;
	projectId?: string | null;
};
type ReportFrameActor = { userId?: string; organizationId?: string | null };

/** Generated previews retain the report's current and admitted audience. */
async function reportDerivedFrameAccess(
	frame: ReportFrame,
	actor: ReportFrameActor,
	write: boolean,
	client: Prisma.TransactionClient = db,
): Promise<boolean> {
	if (frame.sourceRunType !== "REPORT_EXECUTION") {
		return true;
	}
	if (
		!actor.userId ||
		!actor.organizationId ||
		frame.organizationId !== actor.organizationId ||
		!frame.sourceRunId ||
		(write && frame.userId !== actor.userId)
	) {
		return false;
	}
	if (frame.projectId) {
		const project = await client.project.findFirst({
			where: {
				id: frame.projectId,
				organizationId: actor.organizationId,
				deletedAt: null,
			},
			select: { id: true },
		});
		if (
			!project ||
			!(await (write
				? canEditProject(frame.projectId, actor.userId, client)
				: hasProjectAccess(
						frame.projectId,
						actor.userId,
						actor.organizationId,
						client,
					)))
		) {
			return false;
		}
	}
	const execution = await client.templateInstanceExecution.findFirst({
		where: { id: frame.sourceRunId, organizationId: actor.organizationId },
		include: { instance: true },
	});
	return (
		!!execution &&
		(await canAccessReportInstance(
			execution.instance,
			{ userId: actor.userId, organizationId: actor.organizationId },
			execution.parameters,
			write,
			client,
		))
	);
}
export function canReadReportDerivedFrame(
	frame: ReportFrame,
	actor: ReportFrameActor,
	client: Prisma.TransactionClient = db,
): Promise<boolean> {
	return reportDerivedFrameAccess(frame, actor, false, client);
}
/** Edits retain ownership plus current report/project write authority. */
export function canWriteReportDerivedFrame(
	frame: ReportFrame,
	actor: ReportFrameActor,
	client: Prisma.TransactionClient = db,
): Promise<boolean> {
	return reportDerivedFrameAccess(frame, actor, true, client);
}
