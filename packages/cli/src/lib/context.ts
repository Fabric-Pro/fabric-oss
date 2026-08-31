/**
 * Context resolution for @fabricorg/cli
 *
 * Every resource command runs inside exactly one organization. Personal context
 * is gone (Fizzy #1875, PO-9): the flag, the environment variable and the
 * stored default that selected it are retired here.
 *
 * The stored shape still PARSES a personal default, and that is deliberate.
 * Configs written by earlier versions have one on disk, and a client that
 * crashed on its own config file would be a worse failure than the one being
 * fixed. It is read, recognised, and refused with a message that says how to
 * replace it — never silently treated as "no default", which would send the
 * user hunting for a setting they can see is set.
 */

import type { ContextConfig } from "./config.js";
import { getDefaultContext } from "./config.js";
import { printError } from "./output.js";

export interface ResolvedContext {
	type: "org";
	slug: string;
}

/** What to do about a personal selection, wherever it came from. */
function refusePersonal(source: string): never {
	return printError(
		`${source} selects personal context, which no longer exists — every command runs inside an organization.\n` +
			"Name one with --org <slug>, or set a default with:\n  fabric ctx use org <slug>",
		2,
	) as never;
}

/**
 * Resolves tenant context from CLI flags, env vars, or stored default.
 * Exits with code 2 when context is ambiguous or names a retired one.
 *
 * @param personal - value of the retired --personal flag
 * @param org - value of --org flag
 * @param required - if false, returns undefined when context is unset (for auth commands)
 */
export function resolveContext(
	personal: boolean | undefined,
	org: string | undefined,
	required = true,
): ResolvedContext | undefined {
	// Checked before the both-flags case on purpose: whichever way they were
	// combined, the useful thing to say is that one of them is retired.
	if (personal) {
		refusePersonal("--personal");
	}
	if (org) {
		return { type: "org", slug: org };
	}

	// Fall back to stored default, or the environment variable behind it.
	const stored: ContextConfig | undefined = getDefaultContext();
	if (stored) {
		if (stored.type === "personal") {
			// Refused rather than ignored even when context is optional: a
			// default the user set and can still see is not the same as no
			// default, and treating it as one hides why their command behaves
			// differently from yesterday.
			refusePersonal(
				process.env.FABRIC_PERSONAL === "1"
					? "FABRIC_PERSONAL=1"
					: "Your stored default context",
			);
		}
		if (stored.type === "org") {
			return { type: "org", slug: stored.slug };
		}
	}

	if (required) {
		printError(
			"Context is required. Use --org <slug>, or set a default with:\n  fabric ctx use org <slug>",
			2,
		);
	}

	return undefined;
}
