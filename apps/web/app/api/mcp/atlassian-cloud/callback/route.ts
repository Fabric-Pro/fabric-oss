import { orpcClient } from "@shared/lib/orpc-client";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Hybrid Atlassian Cloud OAuth 2.0 (3LO) callback handler — PR #1169.
 *
 * Atlassian Developer Console redirects here after the user grants
 * consent to Fabric's Cloud app. We forward the `code` / `state` /
 * `error` query params to the oRPC `mcp.atlassianCloud.callback`
 * procedure, then render a tiny HTML page that closes the popup +
 * posts a message back to the opener window so the MCP settings page
 * can refresh its UI banner.
 *
 * Mirror of `/api/mcp/oauth/callback/route.ts` — same HTML / postMessage
 * contract — but routed through a different oRPC procedure so the
 * primary Rovo flow and the hybrid Cloud flow can be wired in parallel.
 */

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function escapeJsString(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/'/g, "\\'")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/<\//g, "<\\/");
}

export async function GET(req: NextRequest) {
	try {
		const url = new URL(req.url);
		const code = url.searchParams.get("code") ?? undefined;
		const state = url.searchParams.get("state") ?? undefined;
		const error = url.searchParams.get("error") ?? undefined;
		const errorDescription =
			url.searchParams.get("error_description") ?? undefined;

		const result = await orpcClient.mcp.atlassianCloud.callback({
			code,
			state,
			error,
			error_description: errorDescription,
		});

		const html = `
		<!DOCTYPE html>
		<html>
			<head>
				<title>Atlassian Cloud Authorization</title>
				<style>
					body {
						font-family: system-ui, -apple-system, sans-serif;
						display: flex;
						align-items: center;
						justify-content: center;
						height: 100vh;
						margin: 0;
						background: #f5f5f5;
					}
					.message {
						text-align: center;
						padding: 2rem;
						background: white;
						border-radius: 8px;
						box-shadow: 0 2px 8px rgba(0,0,0,0.1);
					}
					.success { color: #16a34a; }
					.error { color: #dc2626; }
				</style>
			</head>
			<body>
				<div class="message">
					<h2 class="${result.success ? "success" : "error"}">
						${result.success ? "&#10003; Atlassian Cloud Connected" : "&#10007; Atlassian Cloud Authorization Failed"}
					</h2>
					<p>${escapeHtml(result.message || (result.success ? "You can close this window." : "An error occurred."))}</p>
				</div>
				<script>
					if (window.opener) {
						window.opener.postMessage({
							type: "${result.success ? "atlassian_cloud_oauth_success" : "atlassian_cloud_oauth_error"}",
							message: "${escapeJsString(result.message || "")}"
						}, window.location.origin);
						setTimeout(() => { window.close(); }, 1500);
					} else {
						window.location.href = "/app/settings/mcp?atlassian-cloud=${result.success ? "success" : "error"}${!result.success && result.message ? `&message=${encodeURIComponent(result.message)}` : ""}";
					}
				</script>
			</body>
		</html>
	`;

		return new NextResponse(html, {
			headers: { "Content-Type": "text/html" },
		});
	} catch (e: unknown) {
		const errorMessage =
			e instanceof Error ? e.message : "Atlassian Cloud callback failed";
		const html = `
		<!DOCTYPE html>
		<html>
			<head>
				<title>Atlassian Cloud Callback Error</title>
				<style>
					body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f5f5f5; }
					.message { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
					.error { color: #dc2626; }
				</style>
			</head>
			<body>
				<div class="message">
					<h2 class="error">&#10007; Atlassian Cloud Authorization Failed</h2>
					<p>${escapeHtml(errorMessage)}</p>
				</div>
				<script>
					if (window.opener) {
						window.opener.postMessage({
							type: "atlassian_cloud_oauth_error",
							message: "${escapeJsString(errorMessage)}"
						}, window.location.origin);
						setTimeout(() => { window.close(); }, 1500);
					} else {
						window.location.href = "/app/settings/mcp?atlassian-cloud=error&message=${encodeURIComponent(errorMessage)}";
					}
				</script>
			</body>
		</html>
	`;
		return new NextResponse(html, {
			headers: { "Content-Type": "text/html" },
		});
	}
}
