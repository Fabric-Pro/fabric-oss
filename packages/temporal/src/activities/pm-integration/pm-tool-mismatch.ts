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

import { pmTargetsConflict } from "@repo/utils/pm-target";

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
 * Lower-cased `scheme://host[:port]` of an http(s) URL, or null when it is
 * unparsable or has no network origin.
 */
export function safeOrigin(url: string | null | undefined): string | null {
	if (!url) {
		return null;
	}
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			return null;
		}
		return parsed.origin.toLowerCase();
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
 * - `"legacy-other-tool"` — a legacy link (no `externalMcpServerId`
 *   stamped) whose URL/baseUrl points at a different tool. The caller must
 *   neither use it nor replace it: it fails the sync with
 *   `legacyLinkOtherToolMessage`, and the user drops the link with Unlink &
 *   re-create. Clearing it automatically and creating could erase a link a
 *   concurrent sync just wrote (an unstamped link cannot be told apart from
 *   a fresh one with the same id) and create a duplicate item.
 * - `"block"` — link explicitly belongs to a different MCP server; caller
 *   should surface a clear error (or honor an override flag).
 *
 * With `currentInstanceOrigin` set, an unstamped link is judged by instance
 * rather than by product: see that field.
 */
export function detectExternalLinkMismatch(input: {
	externalId: string | null | undefined;
	externalUrl: string | null | undefined;
	externalMcpServerId: string | null | undefined;
	activeServerId: string | null | undefined;
	externalPmTarget?: string | null;
	activePmTarget?: string | null;
	currentDetectedType: string | undefined;
	currentBaseUrl: string | null | undefined;
	/**
	 * The origin of the one instance the active tool's items live on, when
	 * the caller knows it (a GitLab instance: gitlab.com or self-hosted).
	 * Set, an unstamped link is used only when its URL has exactly this
	 * origin. A link on another instance of the same product names an
	 * unrelated item with the same number, and a link with no readable URL
	 * cannot be placed on any instance, so both are `"legacy-other-tool"`.
	 * `null` means the instance could not be resolved, which refuses every
	 * unstamped link. Unset, the host heuristics below apply.
	 */
	currentInstanceOrigin?: string | null;
}):
	| { resolution: "ok" }
	| { resolution: "legacy-other-tool"; reason: string }
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

	if (pmTargetsConflict(input.externalPmTarget, input.activePmTarget)) {
		return {
			resolution: "block",
			reason: "The link belongs to a different PM instance or container.",
		};
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

	// Unstamped link, known instance: the link's URL must be on it. The
	// product-level host checks below would accept a gitlab.com link for a
	// self-hosted GitLab (and vice versa).
	if (!externalMcpServerId && input.currentInstanceOrigin !== undefined) {
		const linkOrigin = safeOrigin(externalUrl);
		const instanceOrigin = safeOrigin(input.currentInstanceOrigin);
		if (!linkOrigin) {
			return {
				resolution: "legacy-other-tool",
				reason: "unstamped link has no readable URL, so its instance is unknown",
			};
		}
		if (!instanceOrigin || linkOrigin !== instanceOrigin) {
			return {
				resolution: "legacy-other-tool",
				reason: `link origin ${linkOrigin} is not the active instance ${instanceOrigin ?? "(unresolved)"}`,
			};
		}
		return { resolution: "ok" };
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
				resolution: "legacy-other-tool",
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
					resolution: "legacy-other-tool",
					reason: `baseUrl host ${currentHost} does not share a domain with ${existingHost}`,
				};
			}
		}
	}

	return { resolution: "ok" };
}

/**
 * The sync error for a legacy link that points at a different PM tool
 * (`"legacy-other-tool"` above). No automatic sync replaces it; the sync
 * failure panel keys on the phrase "linked to a ticket in a different PM
 * tool" to offer Unlink & re-create, and the message names that action.
 */
export function legacyLinkOtherToolMessage(
	toolLabel: string,
	direction: "push" | "pull" = "push",
): string {
	if (direction === "pull") {
		return `This item is linked to a ticket in a different PM tool, so Fabric did not pull it from ${toolLabel}. To replace the link with a new ticket in ${toolLabel}, use Unlink & re-create (the old ticket is not deleted).`;
	}
	return `This item is linked to a ticket in a different PM tool, so Fabric did not create a new one in ${toolLabel}. To make a new ticket in ${toolLabel}, use Unlink & re-create (the old ticket is not deleted).`;
}
