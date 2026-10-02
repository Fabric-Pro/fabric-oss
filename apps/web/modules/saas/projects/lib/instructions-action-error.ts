/**
 * What a failed Coding Instructions action says: a translated line chosen by
 * the error's code, never the server's own `message`. That text is not
 * translated, and it can carry a provider's or a proxy's wording.
 *
 * The keys live under `projects.codingInstructions.actionErrors`.
 */
export type InstructionActionErrorKey =
	| "forbidden"
	| "notFound"
	| "conflict"
	| "tooManyRequests"
	| "generic";

const KEY_BY_CODE: ReadonlyMap<string, InstructionActionErrorKey> = new Map<
	string,
	InstructionActionErrorKey
>([
	["UNAUTHORIZED", "forbidden"],
	["FORBIDDEN", "forbidden"],
	["NOT_FOUND", "notFound"],
	["CONFLICT", "conflict"],
	["TOO_MANY_REQUESTS", "tooManyRequests"],
]);

function codeOf(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error) {
		return typeof error.code === "string" ? error.code : undefined;
	}
	return undefined;
}

/**
 * `PUBLISHED_CHANGED` (`publish-snapshot.ts`): the pointer moved since the page
 * the person chose from was loaded, and nothing was written. Carries the
 * version that is published now, null when none is. `null` for any other error.
 */
export function publishedChanged(
	error: unknown,
): { publishedVersion: number | null } | null {
	if (codeOf(error) !== "CONFLICT") {
		return null;
	}
	const data =
		error && typeof error === "object" && "data" in error
			? error.data
			: undefined;
	if (
		!data ||
		typeof data !== "object" ||
		!("reason" in data) ||
		data.reason !== "PUBLISHED_CHANGED"
	) {
		return null;
	}
	const version = "publishedVersion" in data ? data.publishedVersion : null;
	return { publishedVersion: typeof version === "number" ? version : null };
}

/** The line for an error: its code's own, or the generic one. */
export function instructionActionErrorKey(
	error: unknown,
): InstructionActionErrorKey {
	const code = codeOf(error);
	return (code && KEY_BY_CODE.get(code)) || "generic";
}
