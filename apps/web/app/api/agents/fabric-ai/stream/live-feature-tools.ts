/**
 * Whether this Direct turn binds the live roadmap reads
 * (`fabric_list_project_features`, `fabric_get_project_feature`). Mirrors
 * `createBuiltInTools` in @repo/temporal: with a project attached they ride
 * along with the default bundle and with any non-empty explicit tool list; an
 * explicit empty list disables every Fabric tool.
 */
export function bindsLiveFeatureTools(
	enabledFabricToolIds: string[] | null | undefined,
): boolean {
	return (
		!Array.isArray(enabledFabricToolIds) || enabledFabricToolIds.length > 0
	);
}

const GROUNDING =
	"Use this bounded, tenant-authorized project context to ground project catch-up, risk review, backlog analysis, project-update, and implementation-planning requests. Cite the source labels/IDs below when you use them.";

/**
 * The instruction heading the project context block. The feature list in that
 * block is a top-15 snapshot; when the live reads are bound the model must be
 * sent to them for anything past it rather than told the record is missing
 * (Fizzy #2309/#2310).
 */
export function projectContextGroundingLine(liveFeatureTools: boolean): string {
	return liveFeatureTools
		? `${GROUNDING} The feature list below is a snapshot of the top of the roadmap taken at the start of this turn: for any feature not listed, a status or priority filter (e.g. everything In Review), or a feature's acceptance criteria and tasks, call fabric_list_project_features or fabric_get_project_feature — they read the roadmap live. Never say a feature does not exist because it is missing from the snapshot.`
		: `${GROUNDING} If a needed record is not listed, say what else you need rather than guessing.`;
}
