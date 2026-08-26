import { orpcClient } from "@shared/lib/orpc-client";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export async function GET(req: NextRequest) {
	try {
		const url = new URL(req.url);
		const code = url.searchParams.get("code") ?? undefined;
		const state = url.searchParams.get("state") ?? undefined;
		const error = url.searchParams.get("error") ?? undefined;
		const error_description =
			url.searchParams.get("error_description") ?? undefined;

		// Call oRPC OAuth callback (public procedure)
		const result = await orpcClient.integrations.gitlab.callback({
			code,
			state,
			error,
			error_description,
		});

		// Determine redirect URL (from state or default).
		// Same-origin only: a path starting with '/' but not '//' (which is
		// a protocol-relative URL that would redirect off-site).
		const rawReturnUrl = result.returnUrl || "/app/settings/integrations";
		const isSafeUrl =
			rawReturnUrl.startsWith("/") && !rawReturnUrl.startsWith("//");
		const redirectUrl = isSafeUrl
			? rawReturnUrl
			: "/app/settings/integrations";

		// Return HTML that sends message to parent window and closes popup
		const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>GitLab OAuth</title>
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
            .gitlab-icon {
              width: 48px;
              height: 48px;
              margin-bottom: 1rem;
              color: #FC6D26;
            }
          </style>
        </head>
        <body>
          <div class="message">
            <svg class="gitlab-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z"/>
            </svg>
            <h2 class="${result.success ? "success" : "error"}">
              ${result.success ? "GitLab Connected" : "Connection Failed"}
            </h2>
            <p>${escapeHtml(result.message)}</p>
          </div>
          <script>
            // Send message to parent window
            if (window.opener) {
              window.opener.postMessage({
                type: ${JSON.stringify(result.success ? "gitlab_oauth_success" : "gitlab_oauth_error")},
                success: ${result.success},
                message: ${JSON.stringify(result.message ?? "")}
              }, window.location.origin);

              // Close popup after a short delay
              setTimeout(() => {
                window.close();
              }, 2000);
            } else {
              // Fallback: redirect if not in popup
              setTimeout(() => {
                window.location.href = "${redirectUrl}${redirectUrl.includes("?") ? "&" : "?"}gitlab_oauth=${result.success ? "success" : "error"}${!result.success && result.message ? `&message=${encodeURIComponent(result.message)}` : ""}";
              }, 2000);
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
			e instanceof Error ? e.message : "GitLab OAuth callback failed";

		// On unexpected error, return error HTML
		const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>GitLab OAuth Error</title>
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
            <h2 class="error">Connection Failed</h2>
            <p>${escapeHtml(errorMessage)}</p>
          </div>
          <script>
            if (window.opener) {
              window.opener.postMessage({
                type: "gitlab_oauth_error",
                success: false,
                message: ${JSON.stringify(errorMessage)}
              }, window.location.origin);

              setTimeout(() => {
                window.close();
              }, 2000);
            } else {
              window.location.href = "/app/settings/integrations?gitlab_oauth=error&message=${encodeURIComponent(errorMessage)}";
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
