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

/**
 * The same resolution as `resolveContext`, as a VALUE instead of an exit.
 *
 * `resolveContext` calls `printError`, which calls `process.exit` — correct
 * for a command a person is watching, and fatal to the session-start hook
 * contract in `commands/instructions`, which must never exit non-zero for
 * any reason. `process.exit` cannot be caught by the `try/catch` that owns
 * that contract, so a stored personal default (or a stale
 * `FABRIC_PERSONAL=1`) took the whole process down with code 2 before the
 * boundary ever saw it.
 *
 * `resolveContext` below is a thin exiting wrapper over it, so the two cannot
 * drift.
 */
type ContextResolution =
	| { ok: true; context: ResolvedContext | undefined }
	| { ok: false; message: string; exitCode: number };

const PERSONAL_RETIRED_HINT =
	"selects personal context, which no longer exists — every command runs inside an organization.\n" +
	"Name one with --org <slug>, or set a default with:\n  fabric ctx use org <slug>";

function tryResolveContext(
	personal: boolean | undefined,
	org: string | undefined,
	required = true,
): ContextResolution {
	if (personal) {
		return {
			ok: false,
			message: `--personal ${PERSONAL_RETIRED_HINT}`,
			exitCode: 2,
		};
	}
	if (org) {
		return { ok: true, context: { type: "org", slug: org } };
	}

	const stored: ContextConfig | undefined = getDefaultContext();
	if (stored?.type === "personal") {
		const source =
			process.env.FABRIC_PERSONAL === "1"
				? "FABRIC_PERSONAL=1"
				: "Your stored default context";
		return {
			ok: false,
			message: `${source} ${PERSONAL_RETIRED_HINT}`,
			exitCode: 2,
		};
	}
	if (stored?.type === "org") {
		return { ok: true, context: { type: "org", slug: stored.slug } };
	}

	if (required) {
		return {
			ok: false,
			message:
				"Context is required. Use --org <slug>, or set a default with:\n  fabric ctx use org <slug>",
			exitCode: 2,
		};
	}

	return { ok: true, context: undefined };
}

/**
 * Resolves tenant context from CLI flags, env vars, or stored default.
 * Exits with code 2 when context is ambiguous or names a retired one.
 *
 * A thin wrapper over `tryResolveContext`, which holds the actual rules —
 * see there for why the non-exiting form exists.
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
	const resolution = tryResolveContext(personal, org, required);
	if (!resolution.ok) {
		printError(resolution.message, resolution.exitCode);
	}
	return resolution.context;
}
