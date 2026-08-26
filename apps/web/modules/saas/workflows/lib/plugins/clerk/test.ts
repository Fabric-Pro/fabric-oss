import type { TestConnectionResult } from "../types";

/** Validate a Clerk secret key with a bounded user list. */
export async function testClerkConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.CLERK_SECRET_KEY ?? credentials.apiKey;
	if (!apiKey) {
		return { success: false, error: "Secret key is required" };
	}

	try {
		const response = await fetch("https://api.clerk.com/v1/users?limit=1", {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (!response.ok) {
			return {
				success: false,
				error: `Clerk rejected the key (HTTP ${response.status})`,
			};
		}
		return { success: true, message: "Connected to Clerk" };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Could not reach Clerk",
		};
	}
}
