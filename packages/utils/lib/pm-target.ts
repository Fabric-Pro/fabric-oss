function safeHost(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

/**
 * Extract the project's CURRENT org/tenant key from its resolved PM config.
 * Returns null when the tool is proxied/unknown (caller falls back to
 * within-project link-set consistency).
 */
export function extractConfigOrgKey(
	toolType: string,
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
				// Leading dot required, matching the entity provenance parser:
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

/** Parse only ADO organisation identities, independently of provenance matching. */
function normalizeAdoOrg(value: string | null | undefined): string | null {
	if (!value?.trim()) {
		return null;
	}
	try {
		const text = value.trim();
		let org: string;
		const bare = text.replace(/\/+$/, "");
		if (!/[/:?.#]/.test(bare)) {
			org = decodeURIComponent(bare);
		} else {
			const url = new URL(
				/^[a-z][a-z0-9+.-]*:\/\//i.test(text)
					? text
					: `https://${text}`,
			);
			if (!/^https?:$/.test(url.protocol)) {
				return null;
			}
			if (url.hostname === "dev.azure.com") {
				org = decodeURIComponent(url.pathname.split("/")[1] ?? "");
			} else {
				const match = url.hostname.match(
					/^([^.]+)\.visualstudio\.com$/i,
				);
				org = decodeURIComponent(match?.[1] ?? "");
			}
		}
		// ADO organisation names start and end with a letter or digit, which
		// also turns flag-like first arguments ("--authentication") into null.
		return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(org)
			? org.toLowerCase()
			: null;
	} catch {
		return null;
	}
}

export interface PmTargetConfig {
	commandArgs?: string[] | null;
	baseUrl?: string | null;
	defaultUrl?: string | null;
	atlassianCloudSiteUrl?: string | null;
	mcpServer?: { key?: string | null; defaultUrl?: string | null } | null;
}

/** Canonical link identity. Missing required identity yields an unknown target. */
export function buildExternalPmTarget(input: {
	mcpServerId?: string | null;
	config?: PmTargetConfig | null;
	pmTool?: string | null;
	containerId?: string | null;
	additionalContext?: unknown;
	/** GitLab origin resolved for the call; recorded additionalContext.gitlabOrigin wins. */
	instanceOrigin?: string | null;
}): string | null {
	const { mcpServerId, config } = input;
	let containerId = input.containerId;
	const knownTools = new Set([
		"azure-devops",
		"jira",
		"atlassian",
		"fizzy",
		"gitlab",
		"gitlab-official",
		"github",
		"github-remote",
		"linear",
		"notion",
		"clickup",
		"trello",
		"asana",
	]);
	const detected =
		input.pmTool === "ado" ? "azure-devops" : input.pmTool?.toLowerCase();
	const tool =
		detected && knownTools.has(detected)
			? detected
			: config?.mcpServer?.key?.toLowerCase();
	if (
		!mcpServerId ||
		mcpServerId.startsWith("key:") ||
		!containerId ||
		!tool ||
		!knownTools.has(tool)
	) {
		return null;
	}
	const context =
		input.additionalContext && typeof input.additionalContext === "object"
			? (input.additionalContext as Record<string, unknown>)
			: {};
	let instance = "";
	if (tool === "azure-devops") {
		const arg = config?.commandArgs?.[0];
		instance =
			normalizeAdoOrg(
				arg?.trim()
					? arg
					: (config?.baseUrl ??
							config?.mcpServer?.defaultUrl ??
							config?.defaultUrl),
			) ?? "";
		// ADO list calls can use a display name; link identity needs the GUID.
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				containerId,
			) ||
			!instance
		) {
			return null;
		}
		containerId = containerId.toLowerCase();
	} else if (tool === "jira" || tool === "atlassian") {
		instance =
			typeof context.cloudId === "string" ? context.cloudId.trim() : "";
	} else if (tool === "fizzy") {
		if (
			typeof context.account_slug !== "string" ||
			!context.account_slug.trim()
		) {
			return null;
		}
		instance = context.account_slug
			.trim()
			.replace(/\/+$/, "")
			.toLowerCase();
		if (!instance) {
			return null;
		}
	} else if (tool === "gitlab" || tool === "gitlab-official") {
		const origin = context.gitlabOrigin ?? input.instanceOrigin;
		if (typeof origin !== "string") {
			return null;
		}
		try {
			const parsed = new URL(origin);
			if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
				return null;
			}
			instance = parsed.origin.toLowerCase();
		} catch {
			return null;
		}
	}
	// JSON encoding preserves separators within provider ids.
	return `pmt1:${JSON.stringify([mcpServerId, instance, containerId])}`;
}

function parsePmTarget(key: string | null | undefined): string[] | null {
	if (typeof key !== "string" || !key.startsWith("pmt1:")) {
		return null;
	}
	try {
		const parts: unknown = JSON.parse(key.slice(5));
		return Array.isArray(parts) &&
			parts.length === 3 &&
			parts.every((part) => typeof part === "string") &&
			parts[0] &&
			parts[2]
			? parts
			: null;
	} catch {
		return null;
	}
}

/** Unknown targets preserve legacy guard behavior; an empty instance is a wildcard. */
export function pmTargetsConflict(
	rowKey: string | null | undefined,
	activeKey: string | null | undefined,
): boolean {
	const row = parsePmTarget(rowKey);
	const active = parsePmTarget(activeKey);
	if (!row || !active) {
		return false;
	}
	return (
		row[0] !== active[0] ||
		row[2] !== active[2] ||
		(!!row[1] && !!active[1] && row[1] !== active[1])
	);
}
