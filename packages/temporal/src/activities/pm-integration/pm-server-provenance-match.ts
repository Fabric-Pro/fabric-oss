import { belongsToCurrentKnownTool, safeHost } from "./pm-tool-mismatch";

/** PM tool types we can verify; equal to the keys of PM_TOOL_HOST_PATTERNS. */
export type PmPatternType =
	| "azure-devops"
	| "jira"
	| "fizzy"
	| "github"
	| "gitlab"
	| "linear";

/**
 * Map an MCPServer.key (catalog slug) to the PM_TOOL_HOST_PATTERNS key.
 * MCPServer.key uses "atlassian"; the host-pattern table uses "jira".
 * Returns null for non-PM / unsupported server types (fail-safe: project skipped).
 */
export function mapKeyToPatternType(
	serverKey: string | null | undefined,
): PmPatternType | null {
	if (!serverKey) {
		return null;
	}
	switch (serverKey.toLowerCase()) {
		case "azure-devops":
			return "azure-devops";
		case "atlassian":
		case "jira":
			return "jira";
		case "fizzy":
			return "fizzy";
		case "github":
		case "github-remote":
			return "github";
		case "gitlab":
		case "gitlab-official":
			return "gitlab";
		case "linear":
			return "linear";
		default:
			return null;
	}
}

function firstPathSegment(url: string): string | null {
	try {
		const segments = new URL(url).pathname.split("/").filter(Boolean);
		return segments[0] ?? null;
	} catch {
		return null;
	}
}

/**
 * Extract the org/tenant identity key from an entity externalUrl for the given
 * tool type. Returns a normalized (lowercased) key, or null when the URL is
 * missing, belongs to a different tool, or carries no extractable key.
 */
export function extractEntityOrgKey(
	toolType: PmPatternType,
	externalUrl: string | null | undefined,
): string | null {
	if (!externalUrl) {
		return null;
	}
	const host = safeHost(externalUrl);
	if (!host || !belongsToCurrentKnownTool(host, toolType)) {
		return null;
	}

	switch (toolType) {
		case "azure-devops": {
			if (
				host !== "visualstudio.com" &&
				host.endsWith(".visualstudio.com")
			) {
				const sub = host.split(".")[0];
				return sub ? sub.toLowerCase() : null;
			}
			const m = externalUrl.match(/dev\.azure\.com\/([^/?#]+)/i);
			if (!m?.[1]) {
				return null;
			}
			const org = decodeURIComponent(m[1]).toLowerCase();
			return org.startsWith("_") ? null : org;
		}
		case "jira":
			return host; // safeHost() already lowercased; tenant = full host
		case "fizzy":
		case "github":
		case "gitlab":
		case "linear": {
			const seg = firstPathSegment(externalUrl);
			return seg ? seg.toLowerCase() : null;
		}
	}
}

/**
 * Extract the project's CURRENT org/tenant key from its resolved PM config.
 * Returns null when the tool is proxied/unknown (caller falls back to
 * within-project link-set consistency).
 */
export function extractConfigOrgKey(
	toolType: PmPatternType,
	config: {
		commandArgs?: string[] | null;
		baseUrl?: string | null;
		defaultUrl?: string | null;
		atlassianCloudSiteUrl?: string | null;
	},
): string | null {
	switch (toolType) {
		case "azure-devops": {
			const arg = Array.isArray(config.commandArgs)
				? config.commandArgs[0]
				: null;
			if (typeof arg === "string" && arg.trim()) {
				return arg.trim().toLowerCase();
			}
			const url = config.baseUrl ?? config.defaultUrl ?? null;
			if (url) {
				const m = url.match(/dev\.azure\.com\/([^/?#]+)/i);
				if (m?.[1]) {
					return decodeURIComponent(m[1]).toLowerCase();
				}
				const host = safeHost(url);
				// Leading dot required, matching extractEntityOrgKey above:
				// a bare suffix test also accepts `evilvisualstudio.com`.
				// Guards js/incomplete-url-substring-sanitization.
				if (host?.endsWith(".visualstudio.com")) {
					return host.split(".")[0]?.toLowerCase() ?? null;
				}
			}
			return null;
		}
		case "jira":
			return config.atlassianCloudSiteUrl
				? safeHost(config.atlassianCloudSiteUrl) || null
				: null;
		default:
			return null; // fizzy / github / gitlab / linear → within-project fallback
	}
}

export type TrustedKey =
	| { kind: "trusted"; key: string }
	| { kind: "ambiguous"; reason: "multitenant" | "fallback-unparseable" }
	| { kind: "none" };

/**
 * Decide the project's trusted org/tenant key.
 * Primary: the config-derived key (ADO/Jira). Fallback (proxied/unknown):
 * rows already stamped for the active server (independent provenance);
 * unstamped candidates are never part of the baseline.
 * FAIL CLOSED — any unparseable baseline link forces ambiguity (it could
 * hide a second tenant).
 * `baselineKeys` is the entityOrgKey of EVERY row already stamped for the
 * active server; entries may be null.
 */
export function deriveTrustedKey(input: {
	configOrgKey: string | null;
	baselineKeys: Array<string | null>;
}): TrustedKey {
	if (input.configOrgKey != null) {
		return { kind: "trusted", key: input.configOrgKey };
	}
	if (input.baselineKeys.length === 0) {
		return { kind: "none" };
	}
	if (input.baselineKeys.some((k) => k == null)) {
		return { kind: "ambiguous", reason: "fallback-unparseable" };
	}
	const distinct = new Set(input.baselineKeys as string[]);
	if (distinct.size === 1) {
		return { kind: "trusted", key: [...distinct][0] };
	}
	return { kind: "ambiguous", reason: "multitenant" };
}

export type SkipReason =
	| "no-url"
	| "tool-mismatch"
	| "org-mismatch"
	| "ambiguous-multitenant"
	| "fallback-unparseable"
	| "no-baseline";

export type CandidateDecision =
	| { action: "stamp" }
	| { action: "skip"; reason: SkipReason };

/** Decide whether a single candidate row should be stamped. */
export function decideCandidate(input: {
	toolType: PmPatternType;
	externalUrl: string | null | undefined;
	entityOrgKey: string | null;
	trusted: TrustedKey;
}): CandidateDecision {
	const host = input.externalUrl ? safeHost(input.externalUrl) : null;
	if (!host) {
		return { action: "skip", reason: "no-url" };
	}
	if (!belongsToCurrentKnownTool(host, input.toolType)) {
		return { action: "skip", reason: "tool-mismatch" };
	}
	// URL present but no extractable org key — folded into "no-url" per the spec's "missing/unparseable URL" bucket
	if (input.entityOrgKey == null) {
		return { action: "skip", reason: "no-url" };
	}
	switch (input.trusted.kind) {
		case "none":
			// no independent baseline (no row already stamped for the active server) — skip rather than trust unstamped candidates
			return { action: "skip", reason: "no-baseline" };
		case "ambiguous":
			return {
				action: "skip",
				reason:
					input.trusted.reason === "multitenant"
						? "ambiguous-multitenant"
						: "fallback-unparseable",
			};
		case "trusted":
			return input.entityOrgKey === input.trusted.key
				? { action: "stamp" }
				: { action: "skip", reason: "org-mismatch" };
	}
}
