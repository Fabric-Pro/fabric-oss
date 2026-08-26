declare const window: { location: { origin: string } } | undefined;

/**
 * Resolve the canonical base URL for Fabric in the current runtime.
 *
 * Precedence (first match wins):
 *   1. `window.location.origin`        — client-side; honours ngrok / proxies.
 *   2. `NEXT_PUBLIC_SITE_URL`          — Vercel / Next.js server context.
 *   3. `APP_URL`                       — Temporal worker (Azure Container App)
 *                                        and any non-Next.js Node process that
 *                                        does not see NEXT_PUBLIC_* vars at
 *                                        build time.
 *   4. `NEXT_PUBLIC_VERCEL_URL`        — Vercel preview deployments.
 *   5. `http://localhost:${PORT ?? 3000}` — dev-time fallback.
 *
 * Background: the temporal-worker Container App has APP_URL wired from Key
 * Vault (deployment/azure/main.bicep) but not NEXT_PUBLIC_*. Before this
 * was added, callers like packages/temporal/src/activities/direct-chat/
 * built-in-tools.ts::buildStoryUrl fell through to the localhost fallback,
 * leaking http://localhost:3000/... URLs into production Slack messages.
 */
export function getBaseUrl() {
	// On client-side, use window.location.origin to support ngrok and other proxies
	// Use typeof check to avoid "window is not defined" error during SSR
	// biome-ignore lint/complexity/useOptionalChain: typeof guard is required to prevent ReferenceError on server where window is undeclared
	if (typeof window !== "undefined" && window?.location?.origin) {
		return window.location.origin;
	}

	// On server-side, use environment variables
	if (process.env.NEXT_PUBLIC_SITE_URL) {
		return process.env.NEXT_PUBLIC_SITE_URL;
	}
	if (process.env.APP_URL) {
		return process.env.APP_URL;
	}
	if (process.env.NEXT_PUBLIC_VERCEL_URL) {
		return `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`;
	}
	return `http://localhost:${process.env.PORT ?? 3000}`;
}

/**
 * Resolve a link to an absolute URL for consumers that live outside the app —
 * email, Slack, webhooks. Already-absolute inputs pass through unchanged.
 *
 * In-app links are stored relative (`/app/{slug}/settings/usage?…`), which is
 * correct for Next.js routing but dead in an email: the client has no origin to
 * resolve against. Anything handing an in-app link to an off-app channel must
 * pass it through here first. Not doing so shipped an unclickable "Manage
 * limits" button to users on 2026-07-02.
 */
export function toAbsoluteUrl(path: string): string {
	if (/^https?:\/\//i.test(path)) {
		return path;
	}
	const base = getBaseUrl().replace(/\/+$/, "");
	return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}
