/** Clerk: fetch a user by ID. */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import {
	CLERK_API_URL,
	type ClerkUser,
	clerkAuthHeaders,
	clerkFailure,
	mapClerkUser,
} from "./clerk-shared";
import { interpolateTemplate } from "./utils";

export async function executeClerkGetUserStep(
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
			{ headers: clerkAuthHeaders(credentials.CLERK_SECRET_KEY) },
		);
		if (!response.ok) {
			return await clerkFailure(response, "Failed to fetch user");
		}
		// Spelled out rather than returning mapClerkUser() directly: the
		// action's declared outputFields are verified against the keys this
		// step visibly returns, and a bare call hides them from that check.
		const mapped = mapClerkUser((await response.json()) as ClerkUser);
		return {
			success: true,
			output: {
				id: mapped.id,
				firstName: mapped.firstName,
				lastName: mapped.lastName,
				primaryEmailAddress: mapped.primaryEmailAddress,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to fetch Clerk user",
		};
	}
}
