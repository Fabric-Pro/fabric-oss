import { db } from "@repo/database";

/**
 * Keeps the project of an Orchestrator request only inside the organization
 * the turn runs in.
 *
 * The route resolves that organization and checks the caller's membership,
 * and checks access to the project, but those are two separate checks:
 * project access admits an invited guest, so a member of one organization who
 * is a guest on another organization's project would pass both and run that
 * project in their own organization's chat. A project that belongs to a
 * different organization (or to none) is dropped and the chat continues in
 * the turn's organization without it, as the Direct route does. A missing
 * project or a failed lookup drops it too.
 *
 * Without an organization the project is returned as it is, without a
 * lookup; the route refuses such a request before it gets here.
 *
 * Call it once the project id is final, including one taken from the
 * conversation, and before the project-access check.
 */
export async function resolveRequestTenant({
	userId,
	organizationId,
	projectId,
}: {
	userId: string;
	organizationId: string | null | undefined;
	projectId: string | undefined;
}): Promise<{ projectId: string | undefined }> {
	if (!projectId || !organizationId) {
		return { projectId };
	}

	try {
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: { organizationId: true },
		});
		if (project?.organizationId === organizationId) {
			return { projectId };
		}
		console.warn(
			"[Orchestrator API] Project is not in the request's organization; ignoring it",
			{ userId, projectId },
		);
	} catch (err) {
		console.warn(
			"[Orchestrator API] Failed to resolve the project's organization; ignoring the project",
			err instanceof Error ? err.message : String(err),
		);
	}
	return { projectId: undefined };
}
