/**
 * Trusted client-IP extraction.
 *
 * `X-Forwarded-For` is a client-controlled header on any server that does not
 * strip it at the ingress. On Vercel, XFF is appended (the client-supplied
 * value is first), so reading `xff.split(",")[0]` lets an attacker spoof the
 * IP used for rate-limits, brute-force lockouts, and audit logs.
 *
 * We prefer platform-trusted headers set by the ingress:
 *   - `x-vercel-forwarded-for` on Vercel
 *   - `cf-connecting-ip` behind Cloudflare
 *   - `x-real-ip` behind reverse proxies that set it themselves
 *
 * As a last resort we honour `X-Forwarded-For` with a configurable trusted
 * proxy hop count (`TRUSTED_PROXY_HOP_COUNT`), picking the hop *before* the
 * trusted proxies rather than the first, client-supplied entry.
 *
 * Dev-loopback fallback (v2 item 3): when running with `NODE_ENV !== "production"`
 * and none of the trusted proxy headers are present, we fall back to the
 * loopback address `127.0.0.1`. This populates the audit-log IP column
 * during local dev so engineers can verify the column wires through, without
 * loosening production security (the production branch still returns
 * `"unknown"` so spoofed XFF can never escalate to a real IP).
 */

const HEADER_KEYS = {
	vercel: "x-vercel-forwarded-for",
	cloudflare: "cf-connecting-ip",
	realIp: "x-real-ip",
	forwardedFor: "x-forwarded-for",
} as const;

function readHeader(
	source: Headers | { get(name: string): string | null | undefined },
	name: string,
): string | null {
	const raw = source.get(name);
	if (!raw) {
		return null;
	}
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

const TRUSTED_PROXY_HOP_COUNT = (() => {
	const raw = process.env.TRUSTED_PROXY_HOP_COUNT;
	if (!raw) {
		return 1;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
})();

export interface IpHeaderSource {
	get(name: string): string | null | undefined;
}

/**
 * Check whether we should fall back to the loopback address when no
 * trusted proxy header is present. Active in local development
 * (`NODE_ENV === "development"`) so the audit-log IP column populates
 * for engineers. Explicit `FABRIC_IP_LOOPBACK_FALLBACK=true/false`
 * overrides the NODE_ENV default. NOTE: test environments (`NODE_ENV
 * === "test"`) intentionally DO NOT trigger this fallback — tests
 * should mirror production semantics for the IP path so security
 * regressions surface.
 */
function isLoopbackFallbackEnabled(): boolean {
	if (process.env.FABRIC_IP_LOOPBACK_FALLBACK === "false") {
		return false;
	}
	if (process.env.FABRIC_IP_LOOPBACK_FALLBACK === "true") {
		return true;
	}
	return process.env.NODE_ENV === "development";
}

/**
 * Extract the real client IP from a Headers (or Headers-like) object.
 *
 * Returns "unknown" when no reliable source is available, which is the
 * correct fail-safe behaviour for rate-limit keys (everything unknown lands
 * in a shared high-risk bucket).
 *
 * In non-production environments (or when `FABRIC_IP_LOOPBACK_FALLBACK=true`),
 * returns `127.0.0.1` instead of `"unknown"` so local dev populates the
 * audit-log IP column. Production semantics are unchanged.
 */
export function getTrustedClientIp(headers: Headers | IpHeaderSource): string {
	const vercel = readHeader(headers, HEADER_KEYS.vercel);
	if (vercel) {
		return vercel.split(",")[0]?.trim() || "unknown";
	}

	const cloudflare = readHeader(headers, HEADER_KEYS.cloudflare);
	if (cloudflare) {
		return cloudflare;
	}

	const realIp = readHeader(headers, HEADER_KEYS.realIp);
	if (realIp) {
		return realIp;
	}

	const forwarded = readHeader(headers, HEADER_KEYS.forwardedFor);
	if (forwarded) {
		const parts = forwarded
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean);

		// index = parts.length - 1 - hopCount picks the hop *before* the
		// trusted proxies. If the header is shorter than our configured hop
		// count (misconfigured proxy / spoofed header), fall back to
		// "unknown" rather than to `parts[0]` — trusting a client-supplied
		// entry is exactly what this helper exists to prevent.
		const index = parts.length - 1 - TRUSTED_PROXY_HOP_COUNT;
		if (index >= 0 && parts[index]) {
			return parts[index];
		}
	}

	if (isLoopbackFallbackEnabled()) {
		return "127.0.0.1";
	}

	return "unknown";
}

export function getTrustedClientIpFromRequest(request: Request): string {
	return getTrustedClientIp(request.headers);
}
