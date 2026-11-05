/**
 * Recognising a refusal for a missing API-key scope, shared by the commands
 * that map it to their own sentence (`fabric instructions`, `fabric context`).
 *
 * The v1 middleware answers a missing scope with a flat 403 whose message is
 * `Missing required scope: <scope>`, which the SDK codes `MISSING_SCOPE`;
 * other surfaces code it `INSUFFICIENT_SCOPE`. Only the scope is taken from
 * the message, and only when it has the shape of one, a closed vocabulary,
 * never free text.
 */
import { REQUESTED_SCOPES } from "./oauth/flow.js";

/**
 * Whether signing in again could fix a refusal for this scope. A browser
 * sign-in carries only `REQUESTED_SCOPES`, the server's ceiling; any other
 * scope takes an API key, so a hint to sign in would send a person in a circle.
 */
export function signInCanGrant(scope: string): boolean {
	return REQUESTED_SCOPES.some((requested) => requested === scope);
}

function readProperty(error: unknown, name: string): unknown {
	return typeof error === "object" && error !== null && name in error
		? Reflect.get(error, name)
		: undefined;
}

/**
 * The permission a refusal names (`Missing required scope: instructions:write`),
 * only when it has the shape of one.
 */
export function scopeNamed(message: unknown): string | null {
	const named =
		typeof message === "string"
			? /\bscope: ([a-z_]+:[a-z_]+)\b/.exec(message)?.[1]
			: undefined;
	return named ?? null;
}

const MISSING_SCOPE_CODES = new Set(["MISSING_SCOPE", "INSUFFICIENT_SCOPE"]);

/**
 * The missing scope of a 403 that is a scope refusal: `{ scope }`, `scope`
 * null when the refusal did not name it. `null` for any other error,
 * including a 403 for a permission the key's owner lacks.
 */
export function missingScopeOf(
	error: unknown,
): { scope: string | null } | null {
	if (readProperty(error, "status") !== 403) {
		return null;
	}
	const code = readProperty(error, "code");
	const scope = scopeNamed(readProperty(error, "message"));
	if ((typeof code === "string" && MISSING_SCOPE_CODES.has(code)) || scope) {
		return { scope };
	}
	return null;
}
