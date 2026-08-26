/**
 * OAuth Tool Ingestion Client
 *
 * Provides functions to trigger OAuth tool and server ingestion workflows from the API layer.
 * Used when OAuth integrations need to refresh their definitions.
 */

import { getTemporalClient, isTemporalAvailable } from "./client";

const TASK_QUEUE = "fabric-worker";

/**
 * Trigger OAuth tool ingestion for an integration
 *
 * Call this when:
 * - User manually refreshes OAuth tools (Microsoft Teams, GitHub)
 * - OAuth integration is re-authenticated
 */
export async function triggerOAuthToolIngestion(params: {
	integrationId: string;
	provider: "MICROSOFT_GRAPH" | "GITHUB" | "GITLAB";
	userId: string;
	organizationId?: string;
}): Promise<{ workflowId: string } | null> {
	const { integrationId, provider, userId, organizationId } = params;

	if (!(await isTemporalAvailable())) {
		console.warn(
			"[OAuth Ingestion] Temporal not available, skipping tool ingestion",
		);
		return null;
	}

	try {
		const client = await getTemporalClient();
		const workflowId = `oauth-ingest-${integrationId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"oauthToolIngestionWorkflow",
			{
				taskQueue: TASK_QUEUE,
				workflowId,
				args: [
					{
						integrationId,
						provider,
						userId,
						organizationId,
					},
				],
			},
		);

		console.log(
			`[OAuth Ingestion] Started tool ingestion workflow for ${provider}`,
			{
				workflowId: handle.workflowId,
				integrationId,
			},
		);

		return { workflowId: handle.workflowId };
	} catch (error) {
		console.error(
			"[OAuth Ingestion] Failed to trigger tool ingestion:",
			error,
		);
		return null;
	}
}

/**
 * Trigger OAuth server ingestion for an integration
 *
 * Call this when:
 * - User manually refreshes OAuth integration
 * - OAuth integration is re-authenticated
 * - Need to update server-level semantic routing metadata
 */
export async function triggerOAuthServerIngestion(params: {
	integrationId: string;
	provider: "MICROSOFT_GRAPH" | "GITHUB" | "GITLAB";
	userId: string;
	organizationId?: string;
}): Promise<{ workflowId: string } | null> {
	const { integrationId, provider, userId, organizationId } = params;

	if (!(await isTemporalAvailable())) {
		console.warn(
			"[OAuth Server Ingestion] Temporal not available, skipping server ingestion",
		);
		return null;
	}

	try {
		const client = await getTemporalClient();
		const workflowId = `oauth-server-ingest-${integrationId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"oauthServerIngestionWorkflow",
			{
				taskQueue: TASK_QUEUE,
				workflowId,
				args: [
					{
						integrationId,
						provider,
						userId,
						organizationId,
					},
				],
			},
		);

		console.log(
			`[OAuth Server Ingestion] Started server ingestion workflow for ${provider}`,
			{
				workflowId: handle.workflowId,
				integrationId,
			},
		);

		return { workflowId: handle.workflowId };
	} catch (error) {
		console.error(
			"[OAuth Server Ingestion] Failed to trigger server ingestion:",
			error,
		);
		return null;
	}
}
