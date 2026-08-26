/**
 * Image Proxy Route
 *
 * Generates a fresh signed URL for an S3 storage path and redirects to it.
 * This provides stable URLs for images stored in S3 - the proxy URL never expires,
 * while the underlying signed URL is generated on-demand with a short TTL.
 *
 * Security:
 * - Requires authenticated session
 * - XOR tenant isolation: org context allows only orgId prefix, personal only userId
 */

import { config } from "@repo/config";
import { getSignedUrl } from "@repo/storage";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
	const path = request.nextUrl.searchParams.get("path");

	if (!path) {
		return new Response(
			JSON.stringify({ error: "Missing 'path' query parameter" }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	const session = await getSession();
	if (!session) {
		return new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}

	const userId = session.user.id;
	const activeOrgId = session.session.activeOrganizationId;

	// XOR tenant isolation using explicit caller context.
	// The caller sends an `orgId` query param when in org context.
	// This avoids relying on session.activeOrganizationId which can be stale.
	const orgIdParam = request.nextUrl.searchParams.get("orgId");
	const ownerPrefix = path.split("/")[0];

	if (orgIdParam) {
		// Org context (explicit): validate orgId against session and enforce org prefix
		if (orgIdParam !== activeOrgId || ownerPrefix !== orgIdParam) {
			return new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			});
		}
	} else if (ownerPrefix === userId) {
		// Personal context: path starts with userId
	} else if (activeOrgId && ownerPrefix === activeOrgId) {
		// Legacy org URLs without explicit orgId param — fall back to session org
	} else {
		return new Response(JSON.stringify({ error: "Forbidden" }), {
			status: 403,
			headers: { "Content-Type": "application/json" },
		});
	}

	try {
		const signedUrl = await getSignedUrl(path, {
			bucket: config.storage.bucketNames.chatDocuments,
			expiresIn: 3600,
		});

		return Response.redirect(signedUrl, 302);
	} catch (error) {
		console.error("[ImageProxy] Failed to generate signed URL:", error);
		return new Response(
			JSON.stringify({ error: "Failed to generate image URL" }),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}
}
