/** Clerk: update an existing user. */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import {
	CLERK_API_URL,
	type ClerkUser,
	clerkAuthHeaders,
	clerkFailure,
	mapClerkUser,
	parseJsonField,
} from "./clerk-shared";
import { interpolateTemplate } from "./utils";

export async function executeClerkUpdateUserStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { userId, firstName, lastName, publicMetadata, privateMetadata } =
		params.nodeConfig as Record<string, string | undefined>;

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

	const resolve = (v?: string) =>
		v ? interpolateTemplate(v, params.inputs) : undefined;

	const publicMeta = parseJsonField(
		resolve(publicMetadata),
		"publicMetadata",
	);
	if (!publicMeta.ok) {
		return { success: false, error: publicMeta.error };
	}
	const privateMeta = parseJsonField(
		resolve(privateMetadata),
		"privateMetadata",
	);
	if (!privateMeta.ok) {
		return { success: false, error: privateMeta.error };
	}

	const body: Record<string, unknown> = {};
	if (firstName) {
		body.first_name = resolve(firstName);
	}
	if (lastName) {
		body.last_name = resolve(lastName);
	}
	if (publicMeta.value) {
		body.public_metadata = publicMeta.value;
	}
	if (privateMeta.value) {
		body.private_metadata = privateMeta.value;
	}

	if (Object.keys(body).length === 0) {
		return { success: false, error: "Nothing to update" };
	}

	try {
		const id = resolve(userId) as string;
		const response = await fetch(
			`${CLERK_API_URL}/users/${encodeURIComponent(id)}`,
			{
				method: "PATCH",
				headers: clerkAuthHeaders(credentials.CLERK_SECRET_KEY),
				body: JSON.stringify(body),
			},
		);
		if (!response.ok) {
			return await clerkFailure(response, "Failed to update user");
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
					: "Failed to update Clerk user",
		};
	}
}
