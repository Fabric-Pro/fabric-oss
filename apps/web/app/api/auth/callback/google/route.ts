import { app } from "@repo/api";
import { getOauthState } from "@repo/database";
import { orpcClient } from "@shared/lib/orpc-client";
import { handle } from "hono/vercel";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Escape for embedding in HTML text content */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Escape for embedding inside a JS string literal (double-quoted) */
function escapeJsString(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/'/g, "\\'")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/<\//g, "<\\/");
}

/**
 * Interceptor route for /api/auth/callback/google
 *
 * Google Drive MCP OAuth reuses the same redirect URI as Better Auth's Google
 * login (already registered in Google Cloud Console). This route disambiguates
 * between the two flows by checking the `state` parameter against the
 * MCPOAuthState table:
 *
 * - If state is found in DB → MCP OAuth callback (handle token exchange + popup postMessage)
 * - Otherwise → Better Auth callback (forward to Hono handler)
 */

const honoHandler = handle(app);

export async function GET(req: NextRequest) {
	const url = new URL(req.url);
	const state = url.searchParams.get("state");

	// Check if this is an MCP OAuth callback by looking up state in DB
	if (state) {
		try {
			const mcpState = await getOauthState(state);
			if (mcpState) {
				return handleMcpCallback(url);
			}
		} catch {
			// DB lookup failed — fall through to Better Auth
		}
	}

	// Not an MCP callback — forward to Better Auth via Hono
	return honoHandler(req);
}

/**
 * Handle MCP OAuth callback: exchange code for tokens and return popup HTML
 * with postMessage to the parent window.
 * Mirrors the logic from apps/web/app/api/mcp/oauth/callback/route.ts
 */
async function handleMcpCallback(url: URL): Promise<NextResponse> {
	try {
		const code = url.searchParams.get("code") ?? undefined;
		const state = url.searchParams.get("state") ?? undefined;
		const error = url.searchParams.get("error") ?? undefined;

		const result = await orpcClient.mcp.oauth.callback({
			code,
			state,
			error,
		});

		const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>OAuth Callback</title>
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
              ${result.success ? "&#10003; Authentication Successful" : "&#10007; Authentication Failed"}
            </h2>
            <p>${result.success ? "You can close this window." : escapeHtml(result.message || "An error occurred.")}</p>
          </div>
          <script>
            if (window.opener) {
              window.opener.postMessage({
                type: "${result.success ? "oauth_success" : "oauth_error"}",
                error: "${result.success ? "" : escapeJsString(result.message || "Unknown error")}"
              }, window.location.origin);

              setTimeout(() => {
                window.close();
              }, 1500);
            } else {
              window.location.href = "/app/settings/mcp?oauth=${result.success ? "success" : "error"}${!result.success && result.message ? `&message=${encodeURIComponent(result.message)}` : ""}";
            }
          </script>
        </body>
      </html>
    `;

		return new NextResponse(html, {
			headers: { "Content-Type": "text/html" },
		});
	} catch (e: any) {
		const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>OAuth Callback Error</title>
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
            .error { color: #dc2626; }
          </style>
        </head>
        <body>
          <div class="message">
            <h2 class="error">&#10007; Authentication Failed</h2>
            <p>${escapeHtml(e?.message || "OAuth callback failed")}</p>
          </div>
          <script>
            if (window.opener) {
              window.opener.postMessage({
                type: "oauth_error",
                error: "${escapeJsString(e?.message || "OAuth callback failed")}"
              }, window.location.origin);

              setTimeout(() => {
                window.close();
              }, 1500);
            } else {
              window.location.href = "/app/settings/mcp?oauth=error&message=${encodeURIComponent(e?.message || "OAuth callback failed")}";
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
