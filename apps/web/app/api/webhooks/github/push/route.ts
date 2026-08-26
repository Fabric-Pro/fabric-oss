/**
 * GitHub Push Webhook Handler
 *
 * Receives GitHub push events and triggers code reindexing for connected projects.
 *
 * Endpoint: POST /api/webhooks/github/push
 *
 * Features:
 * - Verifies X-Hub-Signature-256 header using HMAC-SHA256
 * - Secret from GITHUB_WEBHOOK_SECRET env var
 * - Returns 200 quickly (non-blocking)
 * - Returns 401 if signature invalid
 * - Returns 400 if payload malformed
 *
 * Tenant Isolation (CRITICAL — no user session in webhooks):
 * - Extract repository URL from push payload (repository.clone_url or repository.html_url)
 * - Lookup ProjectRepositoryIntegration by repo URL
 * - Use the integration record's project.userId and project.organizationId as tenant context
 * - If no integration found, return 200 (silently ignore — not our repo)
 */

import { handleGitHubPushWebhook } from "@repo/api/modules/projects/procedures/code-indexing/github-webhook";
import { type NextRequest, NextResponse } from "next/server";

/**
 * POST handler for GitHub push webhook
 */
export async function POST(request: NextRequest) {
	try {
		// Get raw body for signature verification
		const rawBody = await request.text();

		// Get signature header
		const signatureHeader =
			request.headers.get("x-hub-signature-256") || "";

		// Parse payload
		let payload: unknown;
		try {
			payload = JSON.parse(rawBody);
		} catch {
			return NextResponse.json(
				{ error: "Invalid JSON payload" },
				{ status: 400 },
			);
		}

		// Validate payload has repository
		const pushPayload = payload as {
			repository?: {
				clone_url?: string;
				html_url?: string;
			};
		};

		if (
			!pushPayload.repository?.clone_url &&
			!pushPayload.repository?.html_url
		) {
			return NextResponse.json(
				{ error: "Missing repository URL in payload" },
				{ status: 400 },
			);
		}

		// Process the webhook (signature verification, tenant lookup, workflow start)
		const result = await handleGitHubPushWebhook({
			signatureHeader,
			rawBody,
			payload,
		});

		return NextResponse.json(result, { status: result.status });
	} catch (error) {
		// Handle ORPC errors (thrown by handleGitHubPushWebhook)
		if (error && typeof error === "object" && "code" in error) {
			const orpcError = error as { code: string; message?: string };
			switch (orpcError.code) {
				case "UNAUTHORIZED":
					return NextResponse.json(
						{ error: orpcError.message || "Invalid signature" },
						{ status: 401 },
					);
				case "BAD_REQUEST":
					return NextResponse.json(
						{ error: orpcError.message || "Bad request" },
						{ status: 400 },
					);
				case "SERVICE_UNAVAILABLE":
					return NextResponse.json(
						{
							error:
								orpcError.message ||
								"Webhook secret not configured",
						},
						{ status: 500 },
					);
			}
		}

		console.error("[GitHub Push Webhook] Error:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}

/**
 * GET handler for webhook verification
 * Some services check GET before POST
 */
export async function GET() {
	return NextResponse.json({
		status: "ok",
		service: "Fabric GitHub Push Webhook",
	});
}
