/** Content-free workflow/activity boundary. */
export interface HarnessTriageWorkflowInput {
	runId: string;
	organizationId: string;
	projectId: string;
	userId: string;
	expiresAt: string;
}
export interface HarnessTriageWorkflowResult {
	runId: string;
	status: string;
}
export interface HarnessTriageActivities {
	executeHarnessTriage(
		input: HarnessTriageWorkflowInput,
	): Promise<HarnessTriageWorkflowResult>;
	purgeExpiredHarnessTriageContent(): Promise<{ purged: number }>;
}
