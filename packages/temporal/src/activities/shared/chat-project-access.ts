/**
 * Whether the user can still read the chat's project, under the chat's
 * organization. The route checked this when the turn started, but the turn
 * runs on for minutes afterwards, so the repository reads check again before
 * loading anything, as the project document and feature reads do. A failed
 * lookup counts as no access.
 */
export async function canReadChatProject(
	projectId: string,
	userId: string,
	organizationId: string | undefined,
): Promise<boolean> {
	try {
		const { getProjectAccessContext } = await import("@repo/database");
		const access = await getProjectAccessContext(projectId, userId);
		return (
			access !== null &&
			(access.organizationId ?? null) === (organizationId ?? null)
		);
	} catch (error) {
		console.warn("[code reads] Could not verify project access", {
			projectId,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
