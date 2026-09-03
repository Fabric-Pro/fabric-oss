/**
 * Generic OAuth Callback Route
 *
 * Handles OAuth callbacks for all OAuth-based integrations.
 * The provider is determined from the state parameter.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { htmlEscape, jsString } from "../../github/oauth/callback/sanitize";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
	const url = new URL(req.url);
	const code = url.searchParams.get("code") ?? undefined;
	const state = url.searchParams.get("state") ?? undefined;
	const error = url.searchParams.get("error") ?? undefined;
	const errorDescription =
		url.searchParams.get("error_description") ?? undefined;

	try {
		// Call generic OAuth callback procedure
		const result = await orpcClient.integrations.oauth.callback({
			code,
			state,
			error,
			error_description: errorDescription,
		});

		const providerName = result.provider || "OAuth";
		const redirectUrl = result.returnUrl || "/app/settings/integrations";

		// Return HTML that sends message to parent window and closes popup
		const html = generateCallbackHtml({
			success: result.success,
			message: result.message,
			providerName,
			redirectUrl,
		});

		return new NextResponse(html, {
			headers: { "Content-Type": "text/html" },
		});
	} catch (e: unknown) {
		const errorMessage =
			e instanceof Error ? e.message : "OAuth callback failed";

		const html = generateCallbackHtml({
			success: false,
			message: errorMessage,
			providerName: "OAuth",
			redirectUrl: "/app/settings/integrations",
		});

		return new NextResponse(html, {
			headers: { "Content-Type": "text/html" },
		});
	}
}

interface CallbackHtmlParams {
	success: boolean;
	message: string;
	providerName: string;
	redirectUrl: string;
}

function generateCallbackHtml({
	success,
	message,
	providerName,
	redirectUrl,
}: CallbackHtmlParams): string {
	// `message` carries the provider's unauthenticated `error_description`, so
	// it is escaped for whichever context it lands in — never interpolated raw.
	// The replaced hand-rolled quote/newline escape left backslashes untouched,
	// so a `\"` in the message closed the inline-script string literal.
	// Guards js/incomplete-sanitization.
	const messageLiteral = jsString(message);
	const eventType = success ? "oauth_success" : "oauth_error";
	// Same treatment for the non-popup fallback href: assembled here so the
	// whole URL goes into the script as one escaped literal rather than as raw
	// interpolation. Guards js/incomplete-sanitization.
	const fallbackHrefLiteral = jsString(
		`${redirectUrl}${redirectUrl.includes("?") ? "&" : "?"}oauth=${success ? "success" : "error"}&provider=${encodeURIComponent(providerName)}${!success ? `&message=${encodeURIComponent(message)}` : ""}`,
	);

	return `
<!DOCTYPE html>
<html>
  <head>
    <title>${providerName} OAuth</title>
    <style>
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
        margin: 0;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      }
      .card {
        text-align: center;
        padding: 2.5rem;
        background: white;
        border-radius: 16px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        max-width: 400px;
        margin: 1rem;
      }
      .icon {
        width: 64px;
        height: 64px;
        margin: 0 auto 1.5rem;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .icon.success {
        background: #ecfdf5;
        color: #10b981;
      }
      .icon.error {
        background: #fef2f2;
        color: #ef4444;
      }
      .icon svg {
        width: 32px;
        height: 32px;
      }
      h2 {
        margin: 0 0 0.5rem;
        font-size: 1.5rem;
        font-weight: 600;
      }
      .success h2 { color: #065f46; }
      .error h2 { color: #991b1b; }
      p {
        margin: 0;
        color: #6b7280;
        font-size: 0.95rem;
        line-height: 1.5;
      }
      .provider {
        display: inline-block;
        padding: 0.25rem 0.75rem;
        background: #f3f4f6;
        border-radius: 9999px;
        font-size: 0.875rem;
        color: #374151;
        margin-bottom: 1rem;
      }
      .close-note {
        margin-top: 1.5rem;
        font-size: 0.75rem;
        color: #9ca3af;
      }
    </style>
  </head>
  <body>
    <div class="card ${success ? "success" : "error"}">
      <div class="provider">${providerName}</div>
      <div class="icon ${success ? "success" : "error"}">
        ${
			success
				? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>'
				: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>'
		}
      </div>
      <h2>${success ? "Connected Successfully" : "Connection Failed"}</h2>
      <p>${htmlEscape(message)}</p>
      <p class="close-note">This window will close automatically...</p>
    </div>
    <script>
      // Send message to parent window
      if (window.opener) {
        window.opener.postMessage({
          type: "${eventType}",
          provider: "${providerName}",
          success: ${success},
          message: ${messageLiteral}
        }, window.location.origin);

        // Close popup after a short delay
        setTimeout(() => {
          window.close();
        }, 2000);
      } else {
        // Fallback: redirect if not in popup
        setTimeout(() => {
          window.location.href = ${fallbackHrefLiteral};
        }, 2000);
      }
    </script>
  </body>
</html>
  `;
}
