import { logger } from "@repo/logs";

/**
 * Host families a local dev tunnel may serve from, with the number of DNS
 * labels that must precede the suffix. ngrok hands out one label
 * (`abc.ngrok-free.app`); Microsoft dev tunnels use two
 * (`abc-3001.usw2.devtunnels.ms`). Anything else, including extra labels, is
 * rejected so a value like `evil.com.ngrok.io` never becomes a trusted origin.
 */
const DEV_TUNNEL_HOST_RULES: ReadonlyArray<{ suffix: string; labels: number }> =
	[
		{ suffix: ".ngrok-free.app", labels: 1 },
		{ suffix: ".ngrok.app", labels: 1 },
		{ suffix: ".ngrok.io", labels: 1 },
		{ suffix: ".devtunnels.ms", labels: 2 },
	];

function reject(
	value: string,
	reason: "non-https" | "bad-host" | "parse-error",
): void {
	logger.warn(
		{ event: "trusted_origins.rejected", reason, value },
		`Rejecting trusted origin: ${reason}`,
	);
}

function isValidDevTunnelHost(hostname: string): boolean {
	return DEV_TUNNEL_HOST_RULES.some(({ suffix, labels }) => {
		if (!hostname.endsWith(suffix)) {
			return false;
		}
		const prefix = hostname.slice(0, hostname.length - suffix.length);
		const parts = prefix.split(".");
		return (
			parts.length === labels && parts.every((part) => part.length > 0)
		);
	});
}

function addLocalhostAlias(origins: Set<string>, appUrl: string): void {
	if (appUrl.includes("localhost:")) {
		origins.add(appUrl.replace("localhost", "127.0.0.1"));
	} else if (appUrl.includes("127.0.0.1:")) {
		origins.add(appUrl.replace("127.0.0.1", "localhost"));
	}
}

function addDevTunnel(origins: Set<string>, env: NodeJS.ProcessEnv): void {
	const raw = env.DEV_TUNNEL_URL;
	if (!raw) {
		return;
	}
	// Never trust dev tunnels in production — they are local dev tools only
	if (env.NODE_ENV === "production") {
		return;
	}

	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		reject(raw, "parse-error");
		return;
	}
	if (parsed.protocol !== "https:") {
		reject(raw, "non-https");
		return;
	}
	if (!isValidDevTunnelHost(parsed.hostname)) {
		reject(raw, "bad-host");
		return;
	}
	origins.add(parsed.origin);
}

function addVercelPreview(origins: Set<string>, env: NodeJS.ProcessEnv): void {
	// Only trust Vercel deploy URLs for preview environments — production deploy
	// URLs are already covered by the canonical domain entries above.
	if (env.VERCEL_ENV !== "preview") {
		return;
	}
	if (env.VERCEL_URL) {
		origins.add(`https://${env.VERCEL_URL}`);
	}
	if (env.VERCEL_BRANCH_URL) {
		origins.add(`https://${env.VERCEL_BRANCH_URL}`);
	}
}

function addExtraOrigins(origins: Set<string>, env: NodeJS.ProcessEnv): void {
	const raw = env.AUTH_TRUSTED_ORIGINS ?? env.CORS_ALLOWED_ORIGINS;
	if (!raw) {
		return;
	}
	for (const entry of raw.split(",")) {
		const trimmed = entry.trim();
		if (trimmed) {
			origins.add(trimmed);
		}
	}
}

export function buildTrustedOrigins(
	env: NodeJS.ProcessEnv,
	appUrl: string,
): string[] {
	const origins = new Set<string>([appUrl]);
	addLocalhostAlias(origins, appUrl);
	addExtraOrigins(origins, env);
	addVercelPreview(origins, env);
	addDevTunnel(origins, env);
	return Array.from(origins);
}
