import { Buffer } from "node:buffer";
import type { getAzureDevOpsStorySnapshots } from "@repo/connectors";
import { jsonResult } from "@repo/mcp/lib/json-result";

export const PROJECT_PM_SNAPSHOT_MAX_BYTES = 128 * 1024;

/** Omit whole snapshots so retained fields and comment provenance stay intact. */
export function boundedProjectPmSnapshots(
	capture: Awaited<ReturnType<typeof getAzureDevOpsStorySnapshots>>,
	requestedIds: readonly number[],
	connection: {
		status: "ready";
		provider: "azure-devops";
		target: {
			organization: string;
			projectId: string;
			projectName: string;
		};
	},
) {
	const result = {
		...connection,
		...capture,
		snapshots: [...capture.snapshots],
		resultTruncated: false,
	};
	while (
		Buffer.byteLength(JSON.stringify(jsonResult(result)), "utf8") >
		PROJECT_PM_SNAPSHOT_MAX_BYTES
	) {
		if (result.snapshots.length === 0) {
			throw new Error(
				"Project PM snapshot metadata exceeds the result limit.",
			);
		}
		result.snapshots.pop();
		result.complete = false;
		result.resultTruncated = true;
		result.incompleteReason ??= "response_limit";
		const retained = new Set(result.snapshots.map((item) => item.id));
		result.unreadIds = requestedIds.filter((id) => !retained.has(id));
	}
	return result;
}
