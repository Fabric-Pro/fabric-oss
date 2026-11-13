/**
 * The deployment's shared telemetry workspace, and the one comparison that
 * decides whether a project log-source binding names it.
 *
 * The worker refuses such a binding at scan time and `projects.update` refuses
 * it at save time; both call `namesSharedLogWorkspace` so they cannot disagree.
 * Workspace ids are GUIDs that Azure treats case-insensitively, so the
 * comparison is case-insensitive: an exact match would be bypassed by
 * re-casing the id. When the deployment names no shared workspace there is
 * nothing to refuse.
 */
export function sharedLogWorkspaceId(): string | undefined {
	const id = process.env.FABRIC_BUG_ANALYSIS_LOG_WORKSPACE_ID?.trim();
	return id ? id : undefined;
}

export function namesSharedLogWorkspace(workspaceId: string): boolean {
	const shared = sharedLogWorkspaceId()?.toLowerCase();
	return !!shared && workspaceId.trim().toLowerCase() === shared;
}
