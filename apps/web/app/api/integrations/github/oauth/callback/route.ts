import { orpcClient } from "@shared/lib/orpc-client";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { htmlEscape, jsString, sanitizeReturnUrl } from "./sanitize";

export const runtime = "nodejs";

const PAGE_STYLE = `
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
            .github-icon {
              width: 48px;
              height: 48px;
              margin-bottom: 1rem;
            }`;

export async function GET(req: NextRequest) {
	try {
		const url = new URL(req.url);
		const code = url.searchParams.get("code") ?? undefined;
		const state = url.searchParams.get("state") ?? undefined;
		const error = url.searchParams.get("error") ?? undefined;
		const error_description =
			url.searchParams.get("error_description") ?? undefined;

		// Call oRPC OAuth callback (public procedure)
		const result = await orpcClient.integrations.github.callback({
			code,
			state,
			error,
			error_description,
		});

		// `result.message` can carry the attacker-controlled provider
		// `error_description` — every dynamic value below is HTML- or JS-escaped,
		// and the redirect target is constrained to a same-origin relative path.
		const message = result.message ?? "";
		const messageType = result.success
			? "github_oauth_success"
			: "github_oauth_error";
		const heading = result.success
			? "GitHub Connected"
			: "Connection Failed";
		const headingClass = result.success ? "success" : "error";

		const safeReturnUrl = sanitizeReturnUrl(result.returnUrl);
		const sep = safeReturnUrl.includes("?") ? "&" : "?";
		const statusParam = result.success ? "success" : "error";
		// Success verdicts can carry a caveat too (repo connected but not
		// readable) — the fallback path must preserve it like the popup does.
		const messageParam = message
			? `&message=${encodeURIComponent(message)}`
			: "";
		const fallbackRedirect = `${safeReturnUrl}${sep}github_oauth=${statusParam}${messageParam}`;

		const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>GitHub OAuth</title>
          <style>${PAGE_STYLE}</style>
        </head>
        <body>
          <div class="message">
            <svg class="github-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
            <h2 class="${headingClass}">${heading}</h2>
            <p>${htmlEscape(message)}</p>
          </div>
          <script>
            // Send message to parent window
            if (window.opener) {
              window.opener.postMessage({
                type: ${jsString(messageType)},
                success: ${result.success ? "true" : "false"},
                message: ${jsString(message)}
              }, window.location.origin);

              // Close popup after a short delay
              setTimeout(() => {
                window.close();
              }, 2000);
            } else {
              // Fallback: redirect if not in popup
              setTimeout(() => {
                window.location.href = ${jsString(fallbackRedirect)};
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
		// Do not leak internal exception text to the client in production
		// (SOC 2 CC6.1). Show a generic message; the real error is logged.
		if (e instanceof Error) {
			console.error("[GitHub OAuth callback] unexpected error:", e);
		}
		const errorMessage =
			e instanceof Error && process.env.NODE_ENV === "development"
				? e.message
				: "GitHub OAuth callback failed";

		const fallbackRedirect = `/app/settings/integrations?github_oauth=error&message=${encodeURIComponent(errorMessage)}`;

		const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>GitHub OAuth Error</title>
          <style>${PAGE_STYLE}</style>
        </head>
        <body>
          <div class="message">
            <h2 class="error">Connection Failed</h2>
            <p>${htmlEscape(errorMessage)}</p>
          </div>
          <script>
            if (window.opener) {
              window.opener.postMessage({
                type: "github_oauth_error",
                success: false,
                message: ${jsString(errorMessage)}
              }, window.location.origin);

              setTimeout(() => {
                window.close();
              }, 2000);
            } else {
              window.location.href = ${jsString(fallbackRedirect)};
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
