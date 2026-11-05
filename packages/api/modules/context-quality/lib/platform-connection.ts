import {
	createOAuthM2MProvider,
	DatabricksApiClient,
	validateDatabricksWorkspaceOrigin,
} from "@repo/databricks";

/** Authentication test only; each project binding separately verifies resource access. */
export async function testDatabricksPlatformConnection(
	credentials: Record<string, string>,
) {
	try {
		const host = validateDatabricksWorkspaceOrigin(
			credentials.DATABRICKS_HOST || credentials.host || "",
		);
		const id = credentials.DATABRICKS_CLIENT_ID || credentials.clientId;
		const secret =
			credentials.DATABRICKS_CLIENT_SECRET || credentials.clientSecret;
		if (!id || !secret)
			return {
				success: false,
				error: "Workspace URL, service principal client ID and OAuth machine secret are required.",
			};
		const client = new DatabricksApiClient({
			host,
			tokenProvider: createOAuthM2MProvider(host, id, secret),
			maxRetries: 0,
		});
		await client.request("GET", "/api/2.0/preview/scim/v2/Me", undefined, {
			signal: AbortSignal.timeout(15_000),
		});
		return {
			success: true,
			message:
				"Databricks machine authentication verified. Approve a job, experiment and isolated volume in the project's Quality settings.",
		};
	} catch {
		return {
			success: false,
			error: "Databricks machine authentication failed. Check the workspace URL, OAuth credentials and workspace assignment.",
		};
	}
}
