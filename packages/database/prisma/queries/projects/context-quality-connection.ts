import {
	computeDatabricksEvaluationPrincipalFingerprint,
	validateDatabricksWorkspaceOrigin,
} from "@repo/databricks";
import { db } from "../../client";
import { fetchCredentialsByIdAndProviderInTenant } from "../workflows/credential-fetcher";

/** Shared execution grant, distinct from frozen purpose-only cleanup credentials. */
export async function fetchContextQualityExecutionCredentials(input: {
	integrationId: string;
	organizationId: string;
	userId: string;
	workspaceOrigin?: string;
	principalFingerprint?: string;
}): Promise<Record<string, string> | null> {
	const integration = await db.workflowIntegration.findFirst({
		where: {
			id: input.integrationId,
			organizationId: input.organizationId,
			provider: "DATABRICKS_PLATFORM",
			workflowId: null,
			isActive: true,
			usageScope: "ORGANIZATION_SHARED",
		},
		select: { userId: true },
	});
	if (
		!integration ||
		!(await db.member.findFirst({
			where: {
				organizationId: input.organizationId,
				userId: integration.userId,
			},
			select: { id: true },
		}))
	)
		return null;
	const credentials = await fetchCredentialsByIdAndProviderInTenant(
		input.integrationId,
		"DATABRICKS_PLATFORM",
		input.userId,
		input.organizationId,
	);
	if (
		!credentials?.DATABRICKS_CLIENT_ID ||
		!credentials.DATABRICKS_CLIENT_SECRET ||
		!credentials.DATABRICKS_HOST
	)
		return null;
	try {
		const host = validateDatabricksWorkspaceOrigin(
			credentials.DATABRICKS_HOST,
		);
		if (
			host !== credentials.DATABRICKS_HOST ||
			(input.workspaceOrigin && input.workspaceOrigin !== host) ||
			(input.principalFingerprint &&
				computeDatabricksEvaluationPrincipalFingerprint(
					host,
					credentials.DATABRICKS_CLIENT_ID,
				) !== input.principalFingerprint)
		)
			return null;
	} catch {
		return null;
	}
	return credentials;
}
