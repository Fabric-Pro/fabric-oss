/**
 * PM tool mismatch detection.
 *
 * Shared between the legacy `syncStoryToPM` (pull path) and `syncWorkItemToPM`
 * (push path used by the failure-panel "Retry sync" button + AI-update workflow).
 * Without these guards, a story whose externalId was stamped by a different PM
 * tool (e.g. Fizzy ULID `03fzkovwwbnhh82sk1hfprp7p`) gets sent to ADO's
 * `wit_update_work_item`, which fails with `Expected number, received nan`
 * because the ADO MCP server runs `z.coerce.number()` on the id.
 */

/**
 * Host-suffix patterns per known PM-tool detectedType. Used to detect when a
 * work item's stored externalUrl was produced by a *different* PM tool than
 * the one currently configured.
 */
export const PM_TOOL_HOST_PATTERNS: Record<string, string[]> = {
	fizzy: ["fizzy.do"],
	"azure-devops": ["dev.azure.com", "visualstudio.com"],
	linear: ["linear.app"],
	jira: ["atlassian.net"],
	github: ["github.com"],
	gitlab: ["gitlab.com"],
};

export function safeHost(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * True when hosts are equal or one is a subdomain of the other. Avoids false
 * mismatches for same-instance subdomain variants (e.g. `www.example.com` vs
 * `example.com`).
 */
export function hostsShareRegistrableDomain(a: string, b: string): boolean {
	if (a === b) {
		return true;
	}
	return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function belongsToDifferentKnownTool(
	hostname: string,
	currentType: string,
): boolean {
	for (const [type, patterns] of Object.entries(PM_TOOL_HOST_PATTERNS)) {
		if (type === currentType) {
			continue;
		}
		if (
			patterns.some((p) => hostname === p || hostname.endsWith(`.${p}`))
		) {
			return true;
		}
	}
	return false;
}

/**
 * Positive same-tool match: true when `hostname` matches one of the known host
 * patterns for `currentType`. Lets callers trust a legacy externalUrl that
 * clearly belongs to the active tool, so the secondary `baseUrl` heuristic
 * (which false-positives when the MCP proxy host differs from the card-URL
 * host — e.g. `fizzy.fabric.pro` proxy vs `app.fizzy.do` cards) is skipped.
 */
export function belongsToCurrentKnownTool(
	hostname: string,
	currentType: string,
): boolean {
	const patterns = PM_TOOL_HOST_PATTERNS[currentType];
	if (!patterns) {
		return false;
	}
	return patterns.some((p) => hostname === p || hostname.endsWith(`.${p}`));
}

/**
 * Decide whether a stored externalId/externalUrl belongs to a different PM
 * tool than the one currently configured. Returns the resolution to apply:
 *
 * - `"ok"` — link belongs here, keep using it.
 * - `"clear"` — link is stale (legacy: no `externalMcpServerId` stamped, but
 *   URL/baseUrl proves a different tool); caller should drop the local
 *   externalId/externalUrl and fall through to the CREATE branch.
 * - `"block"` — link explicitly belongs to a different MCP server; caller
 *   should surface a clear error (or honor an override flag).
 */
export function detectExternalLinkMismatch(input: {
	externalId: string | null | undefined;
	externalUrl: string | null | undefined;
	externalMcpServerId: string | null | undefined;
	activeServerId: string | null | undefined;
	currentDetectedType: string | undefined;
	currentBaseUrl: string | null | undefined;
}):
	| { resolution: "ok" }
	| { resolution: "clear"; reason: string }
	| { resolution: "block"; reason: string } {
	const {
		externalId,
		externalUrl,
		externalMcpServerId,
		activeServerId,
		currentDetectedType,
		currentBaseUrl,
	} = input;

	if (!externalId) {
		return { resolution: "ok" };
	}

	// Hard signal: the row remembers which MCP server it was synced with and
	// it isn't the active one. Block — the caller can honor an explicit
	// override (e.g. an "I want to migrate this" confirmation) if it has one.
	if (
		externalMcpServerId &&
		activeServerId &&
		externalMcpServerId !== activeServerId
	) {
		return {
			resolution: "block",
			reason: `linked to MCP server ${externalMcpServerId}, but active server is ${activeServerId}`,
		};
	}

	// Legacy fallback: no externalMcpServerId stamped (row predates the
	// column). Use URL host to decide.
	if (!externalMcpServerId && externalUrl) {
		const existingHost = safeHost(externalUrl);
		if (!existingHost) {
			return { resolution: "ok" };
		}

		// Primary signal: known-tool host patterns via detectedType.
		if (
			currentDetectedType &&
			belongsToDifferentKnownTool(existingHost, currentDetectedType)
		) {
			return {
				resolution: "clear",
				reason: `host ${existingHost} belongs to a different known PM tool than ${currentDetectedType}`,
			};
		}

		// Positive same-tool match: trust the link and stop. Without this, the
		// secondary `baseUrl` check below false-positives whenever the MCP
		// config's host differs from the card-URL host (e.g. Fizzy's
		// `fizzy.fabric.pro` proxy vs `app.fizzy.do` card URLs), silently
		// re-creating a new card on every push of a legacy story.
		if (
			currentDetectedType &&
			belongsToCurrentKnownTool(existingHost, currentDetectedType)
		) {
			return { resolution: "ok" };
		}

		// Secondary signal: baseUrl comparison for custom/self-hosted tools.
		if (currentBaseUrl) {
			const currentHost = safeHost(currentBaseUrl);
			if (
				currentHost &&
				!hostsShareRegistrableDomain(existingHost, currentHost)
			) {
				return {
					resolution: "clear",
					reason: `baseUrl host ${currentHost} does not share a domain with ${existingHost}`,
				};
			}
		}
	}

	return { resolution: "ok" };
}
