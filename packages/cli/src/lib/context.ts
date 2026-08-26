/**
 * Context resolution for @fabricorg/cli
 *
 * Every resource command must resolve an explicit tenant context
 * (personal or org) before making API calls. Ambiguity is an error.
 */

import type { ContextConfig } from "./config.js";
import { getDefaultContext } from "./config.js";
import { printError } from "./output.js";

export interface ResolvedContext {
	type: "personal" | "org";
	slug?: string;
}

/**
 * Resolves tenant context from CLI flags, env vars, or stored default.
 * Exits with code 2 if context is ambiguous (neither set nor stored).
 *
 * @param personal - value of --personal flag
 * @param org - value of --org flag
 * @param required - if false, returns undefined when context is unset (for auth commands)
 */
export function resolveContext(
	personal: boolean | undefined,
	org: string | undefined,
	required = true,
): ResolvedContext | undefined {
	if (personal && org) {
		printError("Cannot use --personal and --org together", 2);
	}

	if (personal) {
		return { type: "personal" };
	}
	if (org) {
		return { type: "org", slug: org };
	}

	// Fall back to stored default
	const stored: ContextConfig | undefined = getDefaultContext();
	if (stored) {
		if (stored.type === "personal") {
			return { type: "personal" };
		}
		if (stored.type === "org") {
			return { type: "org", slug: stored.slug };
		}
	}

	if (required) {
		printError(
			"Context is required. Use --personal, --org <slug>, or set a default with:\n  fabric ctx use personal\n  fabric ctx use org <slug>",
			2,
		);
	}

	return undefined;
}
