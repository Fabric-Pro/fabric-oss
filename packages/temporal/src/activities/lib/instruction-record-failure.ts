/**
 * Which faults of a database write retrying cannot fix (Fizzy #2878 §10).
 *
 * The activities that record a commit's outcome are retried for hours: a pushed
 * commit cannot be un-pushed, so a database that is briefly unreachable must
 * not leave the member's commit pending. That patience is only right for a
 * fault that can pass. A write the database refuses for what it IS (a foreign
 * key that names nothing, a value an enum or a column does not accept, a field
 * Prisma's own validation refuses) is refused again by every attempt, and
 * retrying it only keeps the commit pending for the whole of the policy. Those
 * become a typed non-retryable failure, `RECORD_REJECTED`, which the retry
 * policy lists (`RECORD_NON_RETRYABLE_ERROR_TYPES`), and the workflow reports
 * at once.
 *
 * Matched on Prisma's documented error names and codes, not on the class, so
 * this module imports nothing from Prisma. A code that a retry can clear (a
 * pool timeout, a write conflict, a lost connection) is not listed, and
 * neither is a unique violation, which an idempotent record can meet when two
 * attempts overlap.
 *
 * Lives in ./lib so the activities barrel never exposes it as an activity.
 */
import { ApplicationFailure } from "@temporalio/activity";

/** Prisma request errors whose cause is the write itself, not the moment. */
const DETERMINISTIC_REQUEST_CODES = new Set([
	"P2000", // a value is too long for the column
	"P2003", // a foreign key constraint failed
	"P2005", // a stored value is invalid for its field
	"P2006", // a provided value is invalid for its field
	"P2007", // data validation error
	"P2011", // a null constraint was violated
	"P2012", // a required value is missing
	"P2013", // a required argument is missing
	"P2014", // the change would violate a required relation
	"P2025", // a record the write depends on does not exist
]);

/**
 * SQLSTATE classes of a raw query's failure (Prisma's `P2010` carries it as
 * `meta.code`) that name the statement or the data: 22 (data exception: an
 * enum or a number the type does not accept) and 23 (integrity constraint),
 * except the unique violation; 42 (syntax or a missing column, which is a
 * deployment that does not match the code).
 */
function isDeterministicSqlState(state: string): boolean {
	if (state === "23505") {
		return false;
	}
	return (
		state.startsWith("22") ||
		state.startsWith("23") ||
		state.startsWith("42")
	);
}

/**
 * The non-retryable failure a database write's error becomes when retrying
 * cannot fix it, or null when it can pass (the caller rethrows it as is).
 * Carries the Prisma code and nothing else of the error: never a value, a
 * constraint's name or SQL.
 */
export function deterministicRecordFailure(
	error: unknown,
): ApplicationFailure | null {
	if (!(error instanceof Error)) {
		return null;
	}
	const { code, meta } = error as {
		code?: unknown;
		meta?: { code?: unknown } | null;
	};
	let reason: string | null = null;
	if (error.name === "PrismaClientValidationError") {
		reason = "validation";
	} else if (
		error.name === "PrismaClientKnownRequestError" &&
		typeof code === "string"
	) {
		if (DETERMINISTIC_REQUEST_CODES.has(code)) {
			reason = code;
		} else if (
			code === "P2010" &&
			typeof meta?.code === "string" &&
			isDeterministicSqlState(meta.code)
		) {
			reason = `${code}/${meta.code}`;
		}
	}
	return reason === null
		? null
		: ApplicationFailure.nonRetryable(
				`A database write for a commit was refused and would be refused again (${reason})`,
				"RECORD_REJECTED",
			);
}
