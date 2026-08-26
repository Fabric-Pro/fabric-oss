import { orpcClient } from "@shared/lib/orpc-client";
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

export async function GET(req: NextRequest) {
	try {
		const url = new URL(req.url);
		const code = url.searchParams.get("code") ?? undefined;
		const state = url.searchParams.get("state") ?? undefined;
		const error = url.searchParams.get("error") ?? undefined;

		// Call oRPC OAuth callback (public procedure)
		const result = await orpcClient.mcp.oauth.callback({
			code,
			state,
			error,
		});

		// AUTO-CHAIN: if the callback computed a follow-up authorization
		// URL (currently: hybrid Atlassian Cloud 3LO, PR #1180), redirect
		// the popup directly to it instead of closing. The user sees one
		// continuous flow — Rovo consent → Cloud consent → done. The
		// Cloud callback handler will close the popup when it finishes.
		//
		// We use a server-side 302 instead of meta-refresh so the redirect
		// is instant and doesn't render a confusing "you can close this
		// window" message in between.
		if (result.success && result.chainTo?.authorizationUrl) {
			return NextResponse.redirect(result.chainTo.authorizationUrl);
		}

		// Return HTML that sends message to parent window and closes popup
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
            // Send message to parent window
            if (window.opener) {
              window.opener.postMessage({
                type: "${result.success ? "oauth_success" : "oauth_error"}",
                error: "${result.success ? "" : escapeJsString(result.message || "Unknown error")}"
              }, window.location.origin);

              // Close popup after a short delay
              setTimeout(() => {
                window.close();
              }, 1500);
            } else {
              // Fallback: redirect if not in popup
              window.location.href = "/app/settings/mcp?oauth=${result.success ? "success" : "error"}${!result.success && result.message ? `&message=${encodeURIComponent(result.message)}` : ""}";
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
			e instanceof Error ? e.message : "OAuth callback failed";
		// On unexpected error, return error HTML
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
            <p>${escapeHtml(errorMessage)}</p>
          </div>
          <script>
            if (window.opener) {
              window.opener.postMessage({
                type: "oauth_error",
                error: "${escapeJsString(errorMessage)}"
              }, window.location.origin);

              setTimeout(() => {
                window.close();
              }, 1500);
            } else {
              window.location.href = "/app/settings/mcp?oauth=error&message=${encodeURIComponent(errorMessage)}";
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
