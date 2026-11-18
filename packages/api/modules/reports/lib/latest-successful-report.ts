import type { LatestSuccessfulReport } from "@repo/database";

/** A report's newest successful run as its View action receives it; `null` before one exists. */
export function serializeLatestSuccess(
	latest: LatestSuccessfulReport | undefined,
) {
	return latest
		? {
				executionId: latest.executionId,
				completedAt: latest.completedAt?.toISOString() ?? null,
				artifactId: latest.artifactId,
				artifactName: latest.artifactName,
			}
		: null;
}
