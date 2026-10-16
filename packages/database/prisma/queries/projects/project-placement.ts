import {
	canEditProject,
	getProjectAccessContext,
	isProjectSoftDeleted,
} from "./projects";

/**
 * Why something may not be placed in a project, or null when it may.
 *
 * `not_found`: the project is missing, in the trash, hosted by another
 * organization, or not one the user can open — all reported as missing, as
 * everywhere else. `not_editable`: the user can open it but not change it.
 */
export type ProjectPlacementRefusal = "not_found" | "not_editable";

/**
 * May this user put something of their own (a frame, a scheduled workflow's
 * output) into this project of their organization? The one rule every caller
 * shares, trash included: `getProjectAccessContext` deliberately does not cover
 * the trash, so it is asked here alongside it.
 */
export async function projectPlacementRefusal(input: {
	userId: string;
	organizationId: string;
	projectId: string;
}): Promise<ProjectPlacementRefusal | null> {
	const [access, trashed] = await Promise.all([
		getProjectAccessContext(input.projectId, input.userId),
		isProjectSoftDeleted(input.projectId),
	]);
	if (!access || access.organizationId !== input.organizationId || trashed) {
		return "not_found";
	}
	return (await canEditProject(input.projectId, input.userId))
		? null
		: "not_editable";
}
