/** Clerk: create a user. */

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

export async function executeClerkCreateUserStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const {
		emailAddress,
		firstName,
		lastName,
		password,
		publicMetadata,
		privateMetadata,
	} = params.nodeConfig as Record<string, string | undefined>;

	if (!emailAddress) {
		return { success: false, error: "Email address is required" };
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

	const body: Record<string, unknown> = {
		email_address: [resolve(emailAddress)],
	};
	if (firstName) {
		body.first_name = resolve(firstName);
	}
	if (lastName) {
		body.last_name = resolve(lastName);
	}
	if (password) {
		body.password = resolve(password);
	}
	if (publicMeta.value) {
		body.public_metadata = publicMeta.value;
	}
	if (privateMeta.value) {
		body.private_metadata = privateMeta.value;
	}

	try {
		const response = await fetch(`${CLERK_API_URL}/users`, {
			method: "POST",
			headers: clerkAuthHeaders(credentials.CLERK_SECRET_KEY),
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			return await clerkFailure(response, "Failed to create user");
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
					: "Failed to create Clerk user",
		};
	}
}
