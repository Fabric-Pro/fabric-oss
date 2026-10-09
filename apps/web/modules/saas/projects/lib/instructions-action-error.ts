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
	| "badRequest"
	| "preconditionFailed"
	| "tooManyRequests"
	| "readOnlyMode"
	| "generic";

/** Carried in `data.errorCode` by every write a project in Read-only mode refuses (`@repo/utils`). */
const READ_ONLY_MODE_ERROR_CODE = "PROJECT_READ_ONLY";

const KEY_BY_CODE: ReadonlyMap<string, InstructionActionErrorKey> = new Map<
	string,
	InstructionActionErrorKey
>([
	["UNAUTHORIZED", "forbidden"],
	["FORBIDDEN", "forbidden"],
	["NOT_FOUND", "notFound"],
	["CONFLICT", "conflict"],
	["BAD_REQUEST", "badRequest"],
	["PRECONDITION_FAILED", "preconditionFailed"],
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

/**
 * A write refused because the project is in Read-only mode. It arrives as a
 * CONFLICT like any other, so the code alone would read as "this changed while
 * you were working"; the typed `errorCode` says what it is.
 */
function isReadOnlyModeRefusal(error: unknown): boolean {
	const data =
		error && typeof error === "object" && "data" in error
			? error.data
			: undefined;
	return (
		!!data &&
		typeof data === "object" &&
		"errorCode" in data &&
		data.errorCode === READ_ONLY_MODE_ERROR_CODE
	);
}

/**
 * A write refused because the project's uploaded instructions are being moved
 * into a repository (`MIGRATION_OPEN`, Fizzy #2878 §9): every way of changing
 * them is paused until the move's pull request is merged and synced, or
 * canceled. `pullRequest` is its number, null while it is still being opened;
 * `state` says whether it merged and the project is switching over. `null` for
 * any other error.
 */
export type MigrationOpenRefusal = {
	state: "proposing" | "switching";
	pullRequest: string | null;
};

export function migrationOpenRefusal(
	error: unknown,
): MigrationOpenRefusal | null {
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
		data.reason !== "MIGRATION_OPEN"
	) {
		return null;
	}
	const pullRequest =
		"pullRequest" in data &&
		data.pullRequest &&
		typeof data.pullRequest === "object" &&
		"externalId" in data.pullRequest &&
		typeof data.pullRequest.externalId === "string"
			? data.pullRequest.externalId
			: null;
	return {
		state:
			"state" in data && data.state === "SWITCHING"
				? "switching"
				: "proposing",
		pullRequest,
	};
}

/**
 * A branch command refused because the branch moved since the caller read
 * its attempt (`BRANCH_CHANGED`); nothing was written.
 */
export function isBranchChangedRefusal(error: unknown): boolean {
	if (codeOf(error) !== "CONFLICT") {
		return false;
	}
	const data =
		error && typeof error === "object" && "data" in error
			? error.data
			: undefined;
	return (
		!!data &&
		typeof data === "object" &&
		"reason" in data &&
		data.reason === "BRANCH_CHANGED"
	);
}

/** The line for an error: its code's own, or the generic one. */
export function instructionActionErrorKey(
	error: unknown,
): InstructionActionErrorKey {
	if (isReadOnlyModeRefusal(error)) {
		return "readOnlyMode";
	}
	const code = codeOf(error);
	return (code && KEY_BY_CODE.get(code)) || "generic";
}
