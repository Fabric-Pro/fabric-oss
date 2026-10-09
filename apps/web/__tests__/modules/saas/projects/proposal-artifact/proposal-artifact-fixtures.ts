/**
 * Synthetic `projects.proposalArtifact.*` responses for the Proposal artifact
 * panel tests (Fizzy #2801).
 */

import type {
	ProposalAnalysis,
	ProposalAnalysisFinding,
} from "@saas/projects/components/proposal-artifact/use-proposal-analysis";

export const PROJECT_ID = "project-1";
export const DOCUMENT_ID = "document-1";

let nextFinding = 0;

export function finding(
	overrides: Partial<ProposalAnalysisFinding> = {},
): ProposalAnalysisFinding {
	nextFinding += 1;
	return {
		id: `finding-${nextFinding}`,
		severity: "IMPORTANT",
		type: "SCOPE",
		title: `Finding ${nextFinding}`,
		detail: `Detail of finding ${nextFinding}.`,
		recommendation: null,
		sectionHeading: null,
		position: nextFinding,
		...overrides,
	};
}

export function analysisRun(
	overrides: Partial<ProposalAnalysis> = {},
): ProposalAnalysis {
	return {
		id: "analysis-1",
		status: "COMPLETE",
		isStale: false,
		timedOut: false,
		documentVersion: 3,
		contextCount: 4,
		model: "example-model",
		errorCode: null,
		errorMessage: null,
		startedAt: new Date("2026-10-07T10:00:00.000Z"),
		completedAt: new Date("2026-10-07T10:01:00.000Z"),
		createdAt: new Date("2026-10-07T09:59:00.000Z"),
		updatedAt: new Date("2026-10-07T10:01:00.000Z"),
		findings: [],
		...overrides,
	};
}

/** A thrown oRPC client error, as the client surfaces it. */
export function orpcError(
	code: string,
	message = "Refused",
	data?: Record<string, unknown>,
): Error & { code: string; data?: Record<string, unknown> } {
	return Object.assign(new Error(message), { code, data });
}
