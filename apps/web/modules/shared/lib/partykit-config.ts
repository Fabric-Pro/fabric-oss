/**
 * Startup validation for the PartyKit (real-time collaboration) configuration.
 *
 * Surfaces misconfiguration as a clear, actionable error at server startup
 * instead of a silently broken collaboration experience. Covers the three
 * supported deployment modes:
 *
 *   - Collaboration disabled (NEXT_PUBLIC_ENABLE_COLLABORATION !== "true"):
 *     no PartyKit config is required — nothing to validate.
 *   - Cloudflare-hosted OR Kubernetes self-hosted: NEXT_PUBLIC_PARTYKIT_HOST
 *     must be a bare host[:port]; the client prepends the WebSocket scheme.
 *
 * A scheme-prefixed host is always wrong and fails fast in every environment.
 * A missing host is a hard error in production (the client's localhost:1999
 * fallback would be a silent misconfiguration for a deployed instance) but only
 * a warning in development, where that fallback is the intended behavior.
 */
export function validatePartykitConfig(): void {
	const enabled = process.env.NEXT_PUBLIC_ENABLE_COLLABORATION === "true";
	if (!enabled) {
		return;
	}

	const host = process.env.NEXT_PUBLIC_PARTYKIT_HOST?.trim();

	// A URL scheme (ws, wss, http, …) is always invalid — the client adds the
	// protocol itself. Fail fast regardless of environment.
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host ?? "")) {
		throw new Error(
			`[collab] NEXT_PUBLIC_PARTYKIT_HOST must be a bare host[:port] without a scheme (got "${host}"). ` +
				"The client adds the WebSocket scheme automatically. " +
				'Examples: "partykit.fabric.svc.cluster.local:1999" (self-hosted) or "<project>.<account>.workers.dev" (Cloudflare).',
		);
	}

	if (!host) {
		const message =
			"[collab] NEXT_PUBLIC_ENABLE_COLLABORATION=true but NEXT_PUBLIC_PARTYKIT_HOST is not set. " +
			"Set it to the PartyKit host (self-hosted in-cluster Service or Cloudflare Workers host), " +
			"or set NEXT_PUBLIC_ENABLE_COLLABORATION=false to disable real-time collaboration.";
		if (process.env.NODE_ENV === "production") {
			throw new Error(message);
		}
		console.warn(
			`${message} (Falling back to localhost:1999 for local development.)`,
		);
	}
}
