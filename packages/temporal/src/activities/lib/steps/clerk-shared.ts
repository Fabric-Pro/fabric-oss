/**
 * Shared helpers for the Clerk steps.
 *
 * Clerk's user payload is the same across get/create/update, so the mapping
 * lives here rather than being repeated three times and drifting.
 */

import type { NodeExecutionResult } from "../../types";

export const CLERK_API_URL = "https://api.clerk.com/v1";

export type ClerkUser = {
	id: string;
	first_name: string | null;
	last_name: string | null;
	email_addresses?: { id: string; email_address: string }[];
	primary_email_address_id?: string | null;
};

export function clerkAuthHeaders(apiKey: string) {
	return {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
	};
}

export function mapClerkUser(user: ClerkUser): Record<string, unknown> {
	const primary =
		user.email_addresses?.find(
			(e) => e.id === user.primary_email_address_id,
		) ?? user.email_addresses?.[0];

	return {
		id: user.id,
		firstName: user.first_name,
		lastName: user.last_name,
		primaryEmailAddress: primary?.email_address ?? null,
	};
}

export async function clerkFailure(
	response: Response,
	fallback: string,
): Promise<NodeExecutionResult> {
	const body = (await response.json().catch(() => null)) as {
		errors?: { message?: string; long_message?: string }[];
	} | null;
	const first = body?.errors?.[0];
	return {
		success: false,
		error:
			first?.long_message ??
			first?.message ??
			`HTTP ${response.status}: ${fallback}`,
	};
}

/** Parse an optional JSON config field, returning an error result on bad input. */
export function parseJsonField(
	raw: string | undefined,
	label: string,
):
	| { ok: true; value?: Record<string, unknown> }
	| { ok: false; error: string } {
	if (!raw) {
		return { ok: true };
	}
	try {
		return { ok: true, value: JSON.parse(raw) as Record<string, unknown> };
	} catch {
		return { ok: false, error: `Invalid JSON format for ${label}` };
	}
}
