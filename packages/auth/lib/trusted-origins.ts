import { logger } from "@repo/logs";

const NGROK_HOST_SUFFIXES = [".ngrok-free.app", ".ngrok.app", ".ngrok.io"];

function reject(
	value: string,
	reason: "non-https" | "bad-host" | "parse-error",
): void {
	logger.warn(
		{ event: "trusted_origins.rejected", reason, value },
		`Rejecting trusted origin: ${reason}`,
	);
}

function isValidNgrokHost(hostname: string): boolean {
	return NGROK_HOST_SUFFIXES.some((suffix) => {
		if (!hostname.endsWith(suffix)) {
			return false;
		}
		const label = hostname.slice(0, hostname.length - suffix.length);
		return label.length > 0 && !label.includes(".");
	});
}

function addLocalhostAlias(origins: Set<string>, appUrl: string): void {
	if (appUrl.includes("localhost:")) {
		origins.add(appUrl.replace("localhost", "127.0.0.1"));
	} else if (appUrl.includes("127.0.0.1:")) {
		origins.add(appUrl.replace("127.0.0.1", "localhost"));
	}
}

function addNgrok(origins: Set<string>, env: NodeJS.ProcessEnv): void {
	const raw = env.NGROK_URL;
	if (!raw) {
		return;
	}
	// Never trust ngrok tunnels in production — they are local dev tools only
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
	if (!isValidNgrokHost(parsed.hostname)) {
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
	addNgrok(origins, env);
	return Array.from(origins);
}
