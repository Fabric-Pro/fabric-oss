import type { FabricHttpClient } from "../client.js";
import type {
	ResultQualityChecks,
	ResultQualityGrade,
} from "./result-quality.js";
export interface RunQualityTarget {
	targetType: "AGENT" | "WORKFLOW";
	targetId: string;
}
export interface RunQualityRule {
	id: string;
	name: string;
	nodeId?: string;
	pointer?: string;
	required: boolean;
	checks: ResultQualityChecks;
}
export interface RunQualityPolicy {
	id: string;
	revision: number;
	enabled: boolean;
	rules: RunQualityRule[];
	updatedAt: string;
}
export interface RunQualityPolicyResult extends RunQualityTarget {
	policy: RunQualityPolicy | null;
	canConfigure: boolean;
}
export interface ConfigureRunQualityInput extends RunQualityTarget {
	expectedRevision: number;
	enabled: boolean;
	rules: RunQualityRule[];
}
export interface RunQualityAssessment extends RunQualityTarget {
	id: string;
	executionId: string;
	policyRevision: number;
	sourceVersion: number;
	status: "PENDING" | "CHECKING" | "COMPLETED" | "CANCELLED";
	verdict:
		| "PASSED"
		| "NEEDS_ATTENTION"
		| "UNAVAILABLE"
		| "INCONCLUSIVE"
		| null;
	report: {
		version: 1;
		scorerVersion: string;
		rules: Array<{
			id: string;
			name: string;
			required: boolean;
			outputHash?: string;
			status: "PASSED" | "FAILED" | "NOT_ASSESSED" | "UNAVAILABLE";
			grade?: ResultQualityGrade;
			reason?: string;
		}>;
		coverage: {
			passed: number;
			failed: number;
			unavailable: number;
			total: number;
		};
	} | null;
	errorCode?: string | null;
	createdAt: string;
	completedAt?: string | null;
}
export interface RunQualityAssessmentIdentity extends RunQualityTarget {
	assessmentId: string;
}
export interface RunQualityComparisonInput extends RunQualityTarget {
	leftId: string;
	rightId: string;
}
export interface RunQualityComparison {
	left: RunQualityAssessment;
	right: RunQualityAssessment;
	changes: {
		sameChecks: true;
		sourceVersionChanged: boolean;
		verdictChanged: boolean;
		sourceScopeChanged?: boolean;
	};
}
export interface RunQualityOptions {
	org?: string;
}
function query(values: Record<string, string | number | undefined>) {
	const q = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) {
			q.set(key, String(value));
		}
	}
	return q.size ? `?${q}` : "";
}
/** Checks inspect recorded business results; cancelling a check never cancels its business execution. */
export class RunQualityResource {
	constructor(private readonly http: FabricHttpClient) {}
	getPolicy(
		target: RunQualityTarget,
		options: RunQualityOptions = {},
	): Promise<RunQualityPolicyResult> {
		return this.http.get(
			`/run-quality/policy${query({ ...target, ...options })}`,
		);
	}
	configure(
		input: ConfigureRunQualityInput,
		options: RunQualityOptions = {},
	): Promise<RunQualityPolicyResult> {
		return this.http.request(
			"PUT",
			`/run-quality/policy${query({ ...options })}`,
			{ body: input, retry: { maxRetries: 0 } },
		);
	}
	list(
		target: RunQualityTarget,
		options: RunQualityOptions & { limit?: number; offset?: number } = {},
	): Promise<{
		assessments: RunQualityAssessment[];
		hasMore: boolean;
		unavailableCount: number;
	}> {
		return this.http.get(
			`/run-quality/assessments${query({ ...target, ...options })}`,
		);
	}
	get(
		input: RunQualityAssessmentIdentity,
		options: RunQualityOptions = {},
	): Promise<RunQualityAssessment> {
		const { assessmentId, ...target } = input;
		return this.http.get(
			`/run-quality/assessments/${encodeURIComponent(assessmentId)}${query({ ...target, ...options })}`,
		);
	}
	cancel(
		input: RunQualityAssessmentIdentity,
		options: RunQualityOptions = {},
	): Promise<RunQualityAssessment> {
		const { assessmentId, ...target } = input;
		return this.http.post(
			`/run-quality/assessments/${encodeURIComponent(assessmentId)}/cancel${query({ ...options })}`,
			target,
			{ retry: { maxRetries: 0 } },
		);
	}
	compare(
		input: RunQualityComparisonInput,
		options: RunQualityOptions = {},
	): Promise<RunQualityComparison> {
		return this.http.post(
			`/run-quality/compare${query({ ...options })}`,
			input,
			{ retry: { maxRetries: 0 } },
		);
	}
}
