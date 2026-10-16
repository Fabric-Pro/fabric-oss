/**
 * The frame id a run's `publish-frame` step recorded. A run's output is the
 * map of each step's output by node id; the step's output is `{ frameId, url }`.
 *
 * Pure: the scheduled-run activity, the API commands and the MCP tools all
 * read a run's frame through this one function.
 */
export function findPublishedFrameId(output: unknown): string | null {
	if (!output || typeof output !== "object" || Array.isArray(output)) {
		return null;
	}
	for (const value of Object.values(output)) {
		if (
			value &&
			typeof value === "object" &&
			"frameId" in value &&
			typeof value.frameId === "string" &&
			value.frameId.length > 0
		) {
			return value.frameId;
		}
	}
	return null;
}
