/**
 * Vercel Blob: upload a file.
 *
 * A write with an externally visible effect (it publishes content at a URL),
 * so it belongs in EXTERNAL_WRITE_NODE_TYPES and must not be auto-retried —
 * a retry with `addRandomSuffix` on would leave a second orphaned object.
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

const BLOB_API_URL = "https://blob.vercel-storage.com";

type BlobPutResponse = {
	url: string;
	downloadUrl?: string;
	pathname: string;
};

export async function executeBlobPutStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { pathname, body, contentType, addRandomSuffix } =
		params.nodeConfig as Record<string, string | undefined>;

	if (!pathname) {
		return { success: false, error: "Path is required" };
	}
	if (body === undefined) {
		return { success: false, error: "Content is required" };
	}

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
		const resolvedPath = interpolateTemplate(pathname, params.inputs);
		const url = new URL(
			`/${resolvedPath.replace(/^\/+/, "")}`,
			BLOB_API_URL,
		);
		if (addRandomSuffix === "false") {
			url.searchParams.set("addRandomSuffix", "false");
		}

		const headers: Record<string, string> = {
			Authorization: `Bearer ${credentials.BLOB_READ_WRITE_TOKEN}`,
			"x-api-version": "7",
		};
		if (contentType) {
			headers["x-content-type"] = interpolateTemplate(
				contentType,
				params.inputs,
			);
		}

		const response = await fetch(url.toString(), {
			method: "PUT",
			headers,
			body: interpolateTemplate(body, params.inputs),
		});

		if (!response.ok) {
			return {
				success: false,
				error: `Vercel Blob upload failed (HTTP ${response.status})`,
			};
		}

		const result = (await response.json()) as BlobPutResponse;
		return {
			success: true,
			output: {
				url: result.url,
				downloadUrl: result.downloadUrl ?? result.url,
				pathname: result.pathname,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to upload to Vercel Blob",
		};
	}
}
