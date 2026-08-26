/**
 * Chat Image Upload API
 *
 * Handles image file uploads for the orchestrator chat.
 * Uploads to S3/R2 storage and returns a signed download URL.
 */

import { config } from "@repo/config";
import { getSignedUrl, uploadFile } from "@repo/storage";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
]);

export async function POST(request: NextRequest) {
	try {
		const session = await getSession();
		if (!session) {
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		const userId = session.user.id;
		const sessionOrgId = session.session.activeOrganizationId;

		const formData = await request.formData();
		const file = formData.get("file") as File | null;

		// Validate organizationId against session to prevent cross-tenant writes.
		// A caller cannot upload into an arbitrary org namespace by spoofing the form field.
		const requestOrgId = formData.get("organizationId") as string | null;
		if (requestOrgId && requestOrgId !== sessionOrgId) {
			return new Response(
				JSON.stringify({
					error: "Organization ID does not match session",
				}),
				{
					status: 403,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		// Use only the explicit form field (validated above). Do NOT fall back
		// to sessionOrgId — it can be stale, and the client intentionally omits
		// organizationId in personal context to upload under the userId prefix.
		const organizationId = requestOrgId || undefined;

		if (!file) {
			return new Response(JSON.stringify({ error: "No file provided" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}

		if (!ALLOWED_TYPES.has(file.type)) {
			return new Response(
				JSON.stringify({
					error: `Unsupported file type: ${file.type}. Supported: PNG, JPEG, WebP, GIF`,
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		if (file.size > MAX_FILE_SIZE) {
			return new Response(
				JSON.stringify({
					error: "File size must be less than 10MB",
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Build storage path
		const extension = file.type.split("/")[1] || "png";
		const timestamp = Date.now();
		const hash = Math.random().toString(36).substring(2, 10);
		const ownerPrefix = organizationId || userId;
		const storagePath = `${ownerPrefix}/chat-images/${timestamp}-${hash}.${extension}`;
		const bucket = config.storage.bucketNames.chatDocuments;

		// Upload file to S3/R2
		const arrayBuffer = await file.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);

		await uploadFile(storagePath, buffer, {
			bucket,
			contentType: file.type,
		});

		// Get a signed download URL (1 hour expiry)
		const url = await getSignedUrl(storagePath, {
			bucket,
			expiresIn: 3600,
		});

		return new Response(
			JSON.stringify({
				url,
				storagePath,
				name: file.name,
				size: file.size,
				type: file.type,
			}),
			{
				status: 200,
				headers: { "Content-Type": "application/json" },
			},
		);
	} catch (error) {
		console.error("[Upload Image] Error:", error);
		return new Response(
			JSON.stringify({
				error: error instanceof Error ? error.message : "Upload failed",
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}
