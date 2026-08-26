import type { TestConnectionResult } from "../types";

/** Validate a Vercel Blob token with a bounded list call. */
export async function testBlobConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const token = credentials.BLOB_READ_WRITE_TOKEN ?? credentials.apiKey;
	if (!token) {
		return { success: false, error: "Read/write token is required" };
	}

	try {
		const response = await fetch(
			"https://blob.vercel-storage.com?limit=1",
			{
				headers: {
					Authorization: `Bearer ${token}`,
					"x-api-version": "7",
				},
			},
		);
		if (!response.ok) {
			return {
				success: false,
				error: `Vercel Blob rejected the token (HTTP ${response.status})`,
			};
		}
		return { success: true, message: "Connected to Vercel Blob" };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Could not reach Vercel Blob",
		};
	}
}
