/**
 * OAuth Tool and Server Ingestion Workflows
 *
 * Ingests OAuth integration tools and server metadata (Microsoft Teams, GitHub) into Qdrant
 * for semantic search and capability matching.
 */

import { proxyActivities } from "@temporalio/workflow";
import type {
	IngestOAuthServerInput,
	IngestOAuthServerOutput,
	IngestOAuthToolsInput,
	IngestOAuthToolsOutput,
} from "../activities/oauth-tool-ingestion";

const { ingestOAuthIntegrationToolsActivity, ingestOAuthServerActivity } =
	proxyActivities<{
		ingestOAuthIntegrationToolsActivity: (
			input: IngestOAuthToolsInput,
		) => Promise<IngestOAuthToolsOutput>;
		ingestOAuthServerActivity: (
			input: IngestOAuthServerInput,
		) => Promise<IngestOAuthServerOutput>;
	}>({
		startToCloseTimeout: "5 minutes",
		retry: {
			maximumAttempts: 3,
		},
	});

/**
 * OAuth Tool Ingestion Workflow
 *
 * Ingests OAuth integration tools into Qdrant for tool-level semantic search.
 */
export async function oauthToolIngestionWorkflow(
	input: IngestOAuthToolsInput,
): Promise<IngestOAuthToolsOutput> {
	return await ingestOAuthIntegrationToolsActivity(input);
}

/**
 * OAuth Server Ingestion Workflow
 *
 * Ingests OAuth integration server metadata into Qdrant for server-level semantic routing.
 * Enables Phase 1 semantic routing: queries can match to the OAuth service (e.g., Microsoft Teams)
 * before searching for specific tools.
 */
export async function oauthServerIngestionWorkflow(
	input: IngestOAuthServerInput,
): Promise<IngestOAuthServerOutput> {
	return await ingestOAuthServerActivity(input);
}
