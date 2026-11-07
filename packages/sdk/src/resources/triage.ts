import type { FabricHttpClient } from "../client.js";
export interface TriagePin {
	observationId: string;
	watchId: string;
	grantId: string;
	grantRevision: number;
	evidenceDigest: string;
}
export interface PrivateTriageRun {
	id: string;
	status:
		| "QUEUED"
		| "RUNNING"
		| "COMPLETED"
		| "FAILED"
		| "CANCELLED"
		| "OUTCOME_UNKNOWN";
	createdAt: string;
	expiresAt: string;
	selectedCount: number;
	failureCode: string | null;
}
export interface PrivateTriageResult {
	version: 1;
	audience: "PRIVATE_OWNER";
	coverage: "SELECTED_EVIDENCE_ONLY";
	reviewedEvidence: TriagePin[];
	proposals: Array<{
		id: string;
		title: string;
		summary: string;
		kind: "BUG" | "FEATURE" | "QUESTION" | "RISK";
		urgency: "NOW" | "SOON" | "LATER";
		uncertainties: string[];
		citations: TriagePin[];
	}>;
}
export interface PrivateTriageDetail {
	version: 1;
	run: PrivateTriageRun;
	result: PrivateTriageResult | null;
	reviews: Record<string, "KEEP" | "DISMISS">;
}
export interface PrivateTriageList {
	version: 1;
	availability: "AVAILABLE" | "NOT_ENABLED" | "STORAGE_UNAVAILABLE";
	runs: PrivateTriageRun[];
	nextBefore: string | null;
}
export interface TriageContext {
	org?: string;
}
export interface StartPrivateTriageOptions extends TriageContext {
	requestId: string;
	goal: string;
	evidenceIds: string[];
}
export interface ReviewPrivateTriageOptions extends TriageContext {
	proposalId: string;
	decision: "KEEP" | "DISMISS";
}
function path(
	projectId: string,
	suffix: string,
	options: TriageContext & { before?: string } = {},
) {
	const q = new URLSearchParams();
	if (options.org) {
		q.set("org", options.org);
	}
	if (options.before) {
		q.set("before", options.before);
	}
	return `/projects/${encodeURIComponent(projectId)}/delivery/triage${suffix}${q.size ? `?${q}` : ""}`;
}
/** New physical starts require explicit input identity; re-use it after uncertainty. */
export function privateTriageMethods(http: FabricHttpClient) {
	return {
		listTriageRuns(
			projectId: string,
			options: TriageContext & { before?: string } = {},
		): Promise<PrivateTriageList> {
			return http.get(path(projectId, "", options));
		},
		startTriage(
			projectId: string,
			options: StartPrivateTriageOptions,
		): Promise<PrivateTriageRun> {
			const { org, ...body } = options;
			return http.post(path(projectId, "", { org }), body, {
				retry: { maxRetries: 0 },
			});
		},
		getTriageRun(
			projectId: string,
			runId: string,
			options: TriageContext = {},
		): Promise<PrivateTriageRun> {
			return http.get(
				path(projectId, `/${encodeURIComponent(runId)}`, options),
			);
		},
		getTriageResult(
			projectId: string,
			runId: string,
			options: TriageContext = {},
		): Promise<PrivateTriageDetail> {
			return http.get(
				path(
					projectId,
					`/${encodeURIComponent(runId)}/result`,
					options,
				),
			);
		},
		cancelTriageRun(
			projectId: string,
			runId: string,
			options: TriageContext = {},
		): Promise<PrivateTriageRun> {
			return http.post(
				path(
					projectId,
					`/${encodeURIComponent(runId)}/cancel`,
					options,
				),
				{},
				{ retry: { maxRetries: 0 } },
			);
		},
		reviewTriageProposal(
			projectId: string,
			runId: string,
			options: ReviewPrivateTriageOptions,
		): Promise<PrivateTriageDetail> {
			const { org, ...body } = options;
			return http.post(
				path(projectId, `/${encodeURIComponent(runId)}/review`, {
					org,
				}),
				body,
				{ retry: { maxRetries: 0 } },
			);
		},
	};
}
