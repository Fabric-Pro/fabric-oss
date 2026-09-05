/**
 * Dynamic OAuth Callback Route
 *
 * Handles OAuth callbacks for all OAuth-based integrations dynamically.
 * The provider is determined from the URL path parameter.
 *
 * Supported providers: github, slack, google_drive, microsoft_graph, notion
 */

import { orpcClient } from "@shared/lib/orpc-client";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
	appendQuery,
	htmlEscape,
	jsString,
	sanitizeReturnUrl,
} from "../../../github/oauth/callback/sanitize";

export const runtime = "nodejs";

// Map URL path to provider enum
const PROVIDER_MAP: Record<string, string> = {
	github: "GITHUB",
	slack: "SLACK",
	google_drive: "GOOGLE_DRIVE",
	microsoft_graph: "MICROSOFT_GRAPH",
	notion: "NOTION",
};

// Provider display names and icons
const PROVIDER_INFO: Record<string, { name: string; color: string }> = {
	GITHUB: { name: "GitHub", color: "#24292e" },
	SLACK: { name: "Slack", color: "#4A154B" },
	GOOGLE_DRIVE: { name: "Google Drive", color: "#4285F4" },
	MICROSOFT_GRAPH: { name: "Microsoft 365", color: "#00A4EF" },
	NOTION: { name: "Notion", color: "#000000" },
};

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ provider: string }> },
) {
	const { provider: providerPath } = await params;
	const providerEnum = PROVIDER_MAP[providerPath.toLowerCase()];

	if (!providerEnum) {
		return new NextResponse(
			generateErrorHtml(
				"Unknown Provider",
				`Provider "${providerPath}" is not supported.`,
			),
			{ headers: { "Content-Type": "text/html" } },
		);
	}

	const providerInfo = PROVIDER_INFO[providerEnum] || {
		name: providerPath,
		color: "#666",
	};

	try {
		const url = new URL(req.url);
		const code = url.searchParams.get("code") ?? undefined;
		const state = url.searchParams.get("state") ?? undefined;
		const error = url.searchParams.get("error") ?? undefined;
		const errorDescription =
			url.searchParams.get("error_description") ?? undefined;

		// Call generic OAuth callback procedure
		const result = await orpcClient.integrations.oauth.callback({
			code,
			state,
			error,
			error_description: errorDescription,
		});

		// `returnUrl` is caller-chosen at `start` time and only HMAC-signed, never
		// validated, so constrain it to a same-origin path before it becomes the
		// non-popup fallback redirect (open redirect, Fizzy #2370).
		const redirectUrl = sanitizeReturnUrl(result.returnUrl);

		// Return HTML that sends message to parent window and closes popup
		const html = generateCallbackHtml({
			success: result.success,
			message: result.message,
			providerName: providerInfo.name,
			providerColor: providerInfo.color,
			providerEnum,
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
			providerName: providerInfo.name,
			providerColor: providerInfo.color,
			providerEnum,
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
	providerColor: string;
	providerEnum: string;
	redirectUrl: string;
}

function generateCallbackHtml({
	success,
	message,
	providerName,
	providerColor,
	providerEnum,
	redirectUrl,
}: CallbackHtmlParams): string {
	// `message` carries the provider's unauthenticated `error_description`, so
	// it is escaped for whichever context it lands in — never interpolated raw.
	// The replaced hand-rolled quote/newline escape left backslashes untouched,
	// so a `\"` in the message closed the inline-script string literal.
	// Guards js/incomplete-sanitization.
	const messageLiteral = jsString(message);
	const eventType = success
		? `${providerEnum.toLowerCase()}_oauth_success`
		: `${providerEnum.toLowerCase()}_oauth_error`;
	// Same treatment for the non-popup fallback href: assembled here so the
	// whole URL goes into the script as one escaped literal rather than as raw
	// interpolation. Guards js/incomplete-sanitization. `appendQuery` keeps a
	// `#fragment` on the return path after the parameters, so the landing
	// page's return banner can still read `?oauth=`.
	const fallbackHrefLiteral = jsString(
		appendQuery(
			redirectUrl,
			`oauth=${success ? "success" : "error"}&provider=${encodeURIComponent(providerName)}${!success ? `&message=${encodeURIComponent(message)}` : ""}`,
		),
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
        background: linear-gradient(135deg, ${providerColor}22 0%, ${providerColor}44 100%);
      }
      .card {
        text-align: center;
        padding: 2.5rem;
        background: white;
        border-radius: 16px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.15);
        max-width: 400px;
        margin: 1rem;
      }
      .provider-badge {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 1rem;
        background: ${providerColor}11;
        border: 1px solid ${providerColor}33;
        border-radius: 9999px;
        font-size: 0.875rem;
        color: ${providerColor};
        font-weight: 500;
        margin-bottom: 1.5rem;
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
        margin: 0 0 0.75rem;
        font-size: 1.5rem;
        font-weight: 600;
        color: #111827;
      }
      p {
        margin: 0;
        color: #6b7280;
        font-size: 0.95rem;
        line-height: 1.5;
      }
      .close-note {
        margin-top: 1.5rem;
        font-size: 0.75rem;
        color: #9ca3af;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="provider-badge">${providerName}</div>
      <div class="icon ${success ? "success" : "error"}">
        ${
			success
				? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
				: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'
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
          provider: "${providerEnum}",
          providerName: "${providerName}",
          success: ${success},
          message: ${messageLiteral}
        }, window.location.origin);

        // Also send generic oauth event for broader compatibility
        window.opener.postMessage({
          type: "${success ? "oauth_success" : "oauth_error"}",
          provider: "${providerEnum}",
          providerName: "${providerName}",
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

function generateErrorHtml(title: string, message: string): string {
	return `
<!DOCTYPE html>
<html>
  <head>
    <title>OAuth Error</title>
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
      .card {
        text-align: center;
        padding: 2rem;
        background: white;
        border-radius: 12px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      }
      h2 { color: #dc2626; margin: 0 0 0.5rem; }
      p { color: #6b7280; margin: 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>${htmlEscape(title)}</h2>
      <p>${htmlEscape(message)}</p>
    </div>
  </body>
</html>
  `;
}
