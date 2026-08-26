"use client";

import { PipelineRunsPanel } from "../../test-cases/pipeline/PipelineRunsPanel";

/**
 * QA pipeline-results surface (cards 1834 / 1688) inside the feature QA tab.
 *
 * The implementation lives in {@link PipelineRunsPanel}, which the project Test
 * Cases tab renders too — one component, so the two QA surfaces show the same
 * runs, the same provider marks, the same history and the same run detail
 * instead of drifting into two half-implementations.
 *
 * Part of the QA surface — the dark-launch flag was dropped when the
 * feature graduated, so it renders wherever the QA tab does (server procedures
 * ride the same QA gate).
 */
export function PipelineRunsSection({
	projectId,
	organizationId = null,
	storyId,
}: {
	projectId: string;
	organizationId?: string | null;
	/**
	 * Scopes the list to the runs that actually touched this feature (the
	 * FR4). Without it the tab showed every run in the project, so a feature
	 * with no automated coverage looked identically busy to one with full
	 * coverage — which is the opposite of what UC1 asks this tab to answer.
	 */
	storyId?: string;
}) {
	return (
		<PipelineRunsPanel
			projectId={projectId}
			organizationId={organizationId}
			storyId={storyId}
		/>
	);
}
