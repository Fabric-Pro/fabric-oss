/**
 * Synthetic `projects.proposalArtifact.*` responses for the Proposal artifact
 * panel tests (Fizzy #2801, Fizzy #2946).
 */

import type { ProposalAnalysisReport } from "@saas/projects/components/proposal-artifact/AnalysisReport";
import type {
	ProposalAnalysis,
	ProposalAnalysisFinding,
	ProposalAnalysisResponse,
	ProposalNewerRun,
	ProposalNoLongerRaised,
	ProposalSavedAnswer,
} from "@saas/projects/components/proposal-artifact/use-proposal-analysis";

export const PROJECT_ID = "project-1";
export const DOCUMENT_ID = "document-1";
export const RUN_ID = "analysis-1";

let nextFinding = 0;

/** A finding of the shown run, unaddressed and keyed unless overridden. */
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
		stableKey: `key-${nextFinding}`,
		keyed: true,
		foldedTitles: [],
		state: "UNADDRESSED",
		reason: null,
		response: null,
		evidence: [],
		...overrides,
	};
}

/** An answer as the analysis read shows it. */
export function response(
	overrides: Partial<ProposalAnalysisResponse> = {},
): ProposalAnalysisResponse {
	return {
		id: "response-1",
		kind: "RESPONDED",
		text: "Covered in the statement of work.",
		version: 1,
		author: { id: "user-1", name: "Dana Example" },
		updatedAt: new Date("2026-10-08T10:00:00.000Z"),
		settledSkipReason: null,
		versionUnknown: false,
		...overrides,
	};
}

/** An answer as a write returns it, or a stale write reports it. */
export function savedAnswer(
	overrides: Partial<ProposalSavedAnswer> = {},
): ProposalSavedAnswer {
	return {
		id: "response-1",
		kind: "RESPONDED",
		text: "Covered in the statement of work.",
		version: 1,
		author: { id: "user-1", name: "Dana Example" },
		updatedAt: new Date("2026-10-08T10:00:00.000Z"),
		...overrides,
	};
}

export function noLongerRaised(
	overrides: Partial<ProposalNoLongerRaised> = {},
): ProposalNoLongerRaised {
	return {
		stableKey: "key-gone",
		findingTitle: "A finding no longer raised",
		state: "RESPONDED",
		reason: null,
		response: response(),
		...overrides,
	};
}

export function newerRun(
	overrides: Partial<ProposalNewerRun> = {},
): ProposalNewerRun {
	return {
		id: "analysis-2",
		kind: "RERUN",
		status: "RUNNING",
		errorCode: null,
		timedOut: false,
		createdAt: new Date("2026-10-08T11:00:00.000Z"),
		...overrides,
	};
}

type ShownRun = NonNullable<ProposalAnalysis["run"]>;

/**
 * A run's report: an assessment, a summary and one thing to do before
 * sending, with no full text and no citations unless overridden.
 */
export function report(
	overrides: Partial<ProposalAnalysisReport> = {},
): ProposalAnalysisReport {
	return {
		assessment: "Ready to send after two fixes",
		summary: "The proposal covers the brief.\nTwo gaps remain.",
		scope: [],
		beforeSending: ["Confirm the hosting region"],
		duringDiscovery: [],
		text: null,
		textTruncated: false,
		plainText: false,
		citations: [],
		...overrides,
	};
}

/**
 * The analysis read: a complete shown run with the given findings and no
 * report, no newer run, nothing stale, read by a member the server lets
 * respond. `run: null` builds a document with no complete run.
 */
export function analysis(
	overrides: Partial<Omit<ProposalAnalysis, "run">> & {
		run?: Partial<ShownRun> | null;
	} = {},
): ProposalAnalysis {
	const { run, ...rest } = overrides;
	return {
		run:
			run === null
				? null
				: {
						id: RUN_ID,
						kind: "GENERATION",
						status: "COMPLETE",
						documentVersion: 3,
						contextCount: 4,
						model: "example-model",
						startedAt: new Date("2026-10-07T10:00:00.000Z"),
						completedAt: new Date("2026-10-07T10:01:00.000Z"),
						createdAt: new Date("2026-10-07T09:59:00.000Z"),
						updatedAt: new Date("2026-10-07T10:01:00.000Z"),
						...run,
					},
		isStale: false,
		newerRun: null,
		findings: [],
		noLongerRaised: [],
		report: null,
		viewer: { canRespond: true },
		...rest,
	};
}

/** No run has ever completed or started. */
export function noAnalysis(): ProposalAnalysis {
	return analysis({ run: null });
}

/** A thrown oRPC client error, as the client surfaces it. */
export function orpcError(
	code: string,
	message = "Refused",
	data?: Record<string, unknown>,
): Error & { code: string; data?: Record<string, unknown> } {
	return Object.assign(new Error(message), { code, data });
}
