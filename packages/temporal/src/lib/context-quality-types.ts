/** Metadata-only workflow boundary. Never add raw snapshots, results or credentials. */
export interface ContextQualityEvaluationWorkflowInput {
	evaluationRunId: string;
	organizationId: string;
	projectId: string;
	requesterUserId: string;
}

export interface ContextQualityEvaluationWorkflowOutput {
	status: string;
}
