import { db } from "@repo/database";

/** Resolve OAuth app ownership from the repository's project, including old activity inputs. */
export async function resolveRepositoryAuthContext(input: {
	integrationId: string;
	projectId: string;
	userId?: string | null;
	organizationId?: string | null;
}): Promise<{ userId: string | null; organizationId: string } | null> {
	const repository = await db.projectRepositoryIntegration.findFirst({
		where: { id: input.integrationId, projectId: input.projectId },
		select: {
			configuredByUserId: true,
			project: { select: { organizationId: true } },
		},
	});
	const organizationId = repository?.project.organizationId;
	if (
		!organizationId ||
		(input.organizationId != null &&
			input.organizationId !== organizationId)
	) {
		return null;
	}
	return {
		userId: input.userId ?? repository.configuredByUserId,
		organizationId,
	};
}
