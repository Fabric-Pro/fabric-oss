/** Vercel Blob: list stored files. */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

const BLOB_API_URL = "https://blob.vercel-storage.com";

type BlobListResponse = {
	blobs?: {
		url: string;
		pathname: string;
		size: number;
		uploadedAt: string;
	}[];
	hasMore?: boolean;
	cursor?: string;
};

export async function executeBlobListStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { prefix, limit } = params.nodeConfig as {
		prefix?: string;
		limit?: string | number;
	};

	const credentials = await fetchCredentialsByProvider(
		"BLOB",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.BLOB_READ_WRITE_TOKEN) {
		return {
			success: false,
			error: "Vercel Blob token not configured. Please configure it in Settings > Integrations.",
		};
	}

	try {
		const url = new URL(BLOB_API_URL);
		if (prefix) {
			url.searchParams.set(
				"prefix",
				interpolateTemplate(prefix, params.inputs),
			);
		}
		url.searchParams.set("limit", String(limit ?? 100));

		const response = await fetch(url.toString(), {
			headers: {
				Authorization: `Bearer ${credentials.BLOB_READ_WRITE_TOKEN}`,
				"x-api-version": "7",
			},
		});

		if (!response.ok) {
			return {
				success: false,
				error: `Vercel Blob list failed (HTTP ${response.status})`,
			};
		}

		const data = (await response.json()) as BlobListResponse;
		return {
			success: true,
			output: {
				blobs: data.blobs ?? [],
				hasMore: data.hasMore ?? false,
				cursor: data.cursor ?? null,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to list Vercel Blob files",
		};
	}
}
