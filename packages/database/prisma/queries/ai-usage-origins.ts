import { db, type Prisma } from "../client";

/** Origins describe an already authorized call; they never grant object access. */
async function resolveAiUsageOrigins(input: {
	organizationId?: string | null;
	frameId?: string | null;
	workflowExecutionId?: string | null;
}): Promise<{ frameId: string | null; workflowExecutionId: string | null }> {
	if (!input.organizationId) {
		return { frameId: null, workflowExecutionId: null };
	}
	const [frame, execution] = await Promise.all([
		input.frameId
			? db.agentWorkspaceFile.findFirst({
					where: {
						id: input.frameId,
						organizationId: input.organizationId,
					},
					select: { id: true },
				})
			: null,
		input.workflowExecutionId
			? db.workflowExecution.findFirst({
					where: {
						id: input.workflowExecutionId,
						organizationId: input.organizationId,
					},
					select: { id: true },
				})
			: null,
	]);
	return {
		frameId: frame?.id ?? null,
		workflowExecutionId: execution?.id ?? null,
	};
}

export async function writeAiUsageLog({
	data,
}: {
	data: Prisma.AiUsageLogUncheckedCreateInput;
}) {
	const origins = await resolveAiUsageOrigins(data);
	try {
		return await db.aiUsageLog.create({ data: { ...data, ...origins } });
	} catch (error) {
		// A page/run can be deleted between the lookup and insert. Preserve the
		// accounting row when its optional origin foreign key has disappeared.
		if (
			(origins.frameId || origins.workflowExecutionId) &&
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "P2003"
		) {
			return db.aiUsageLog.create({
				data: { ...data, frameId: null, workflowExecutionId: null },
			});
		}
		throw error;
	}
}
