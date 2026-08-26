/**
 * Clerk: permanently delete a user.
 *
 * Irreversible and externally visible — belongs in EXTERNAL_WRITE_NODE_TYPES
 * so it is never auto-retried.
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { CLERK_API_URL, clerkAuthHeaders, clerkFailure } from "./clerk-shared";
import { interpolateTemplate } from "./utils";

export async function executeClerkDeleteUserStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { userId } = params.nodeConfig as { userId?: string };
	if (!userId) {
		return { success: false, error: "User ID is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"CLERK",
		params.userId,
		params.organizationId,
	);
	if (!credentials?.CLERK_SECRET_KEY) {
		return {
			success: false,
			error: "Clerk secret key not configured. Please configure it in Settings > Integrations.",
		};
	}

	try {
		const id = interpolateTemplate(userId, params.inputs);
		const response = await fetch(
			`${CLERK_API_URL}/users/${encodeURIComponent(id)}`,
			{
				method: "DELETE",
				headers: clerkAuthHeaders(credentials.CLERK_SECRET_KEY),
			},
		);
		if (!response.ok) {
			return await clerkFailure(response, "Failed to delete user");
		}
		return { success: true, output: { deleted: true } };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to delete Clerk user",
		};
	}
}
