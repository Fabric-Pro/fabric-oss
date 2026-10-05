/**
 * Which database faults a record gives up on at once and which it waits out
 * (Fizzy #2878 §10). The activities that record a commit's outcome are retried
 * for hours, which is right for an unreachable database and wrong for a write
 * the database refuses for what it is. Errors are built the way Prisma throws
 * them (a name, a code, a SQLSTATE in `meta.code` for a raw query), and the
 * module reads nothing else.
 */
import { describe, expect, it } from "vitest";
import {
	RECORD_NON_RETRYABLE_ERROR_TYPES,
	RECORD_PUSHED_RETRY,
} from "../../../lib/instruction-direct-commit-types";
import { deterministicRecordFailure } from "../instruction-record-failure";

function prisma(name: string, code?: string, meta?: unknown): Error {
	return Object.assign(new Error("a value, a constraint name or SQL"), {
		name,
		code,
		meta,
	});
}

describe("deterministicRecordFailure", () => {
	it.each([
		["a value too long", "P2000"],
		["a foreign key that names nothing", "P2003"],
		["a stored value invalid for its field", "P2005"],
		["a provided value invalid for its field", "P2006"],
		["data validation", "P2007"],
		["a null constraint", "P2011"],
		["a missing required value", "P2012"],
		["a missing required argument", "P2013"],
		["a required relation violation", "P2014"],
		["a record the write depends on that does not exist", "P2025"],
	])("gives up at once on %s (%s)", (_label, code) => {
		const failure = deterministicRecordFailure(
			prisma("PrismaClientKnownRequestError", code),
		);

		expect(failure).toMatchObject({
			type: "RECORD_REJECTED",
			nonRetryable: true,
		});
	});

	it.each([
		["an enum value a column refuses", "22P02"],
		["a foreign key", "23503"],
		["a null in a required column", "23502"],
		["a check constraint", "23514"],
		["a column the code names but the schema lacks", "42703"],
	])(
		"gives up at once on a raw query that failed on %s (%s)",
		(_label, state) => {
			expect(
				deterministicRecordFailure(
					prisma("PrismaClientKnownRequestError", "P2010", {
						code: state,
					}),
				),
			).toMatchObject({ type: "RECORD_REJECTED", nonRetryable: true });
		},
	);

	it("gives up at once on Prisma's own validation error", () => {
		expect(
			deterministicRecordFailure(prisma("PrismaClientValidationError")),
		).toMatchObject({ type: "RECORD_REJECTED", nonRetryable: true });
	});

	it.each([
		["a pool timeout", prisma("PrismaClientKnownRequestError", "P2024")],
		["a write conflict", prisma("PrismaClientKnownRequestError", "P2034")],
		[
			"a transaction that could not start",
			prisma("PrismaClientKnownRequestError", "P2028"),
		],
		[
			"a unique violation, which an idempotent record can meet when two attempts overlap",
			prisma("PrismaClientKnownRequestError", "P2002"),
		],
		[
			"a raw query's unique violation",
			prisma("PrismaClientKnownRequestError", "P2010", { code: "23505" }),
		],
		[
			"a raw query's lost connection",
			prisma("PrismaClientKnownRequestError", "P2010", { code: "08006" }),
		],
		["an unreachable database", prisma("PrismaClientInitializationError")],
		["a crash of the engine", prisma("PrismaClientRustPanicError")],
		["an error that is not Prisma's", new Error("socket hang up")],
		["a value that is not an error", "P2003"],
	])("waits out %s", (_label, error) => {
		expect(deterministicRecordFailure(error)).toBeNull();
	});

	it("carries the code of the refusal and nothing of the error's own text", () => {
		const failure = deterministicRecordFailure(
			prisma("PrismaClientKnownRequestError", "P2003"),
		);

		expect(failure?.message).toContain("P2003");
		expect(failure?.message).not.toContain(
			"a value, a constraint name or SQL",
		);
	});
});

describe("the record retry policy", () => {
	it("is bounded: about a hundred attempts, backed off to five minutes", () => {
		expect(RECORD_PUSHED_RETRY).toMatchObject({
			initialInterval: "5 seconds",
			backoffCoefficient: 2,
			maximumInterval: "5 minutes",
			maximumAttempts: 100,
		});
	});

	it("never retries the failure types it throws for a fault that cannot pass", () => {
		expect(RECORD_PUSHED_RETRY.nonRetryableErrorTypes).toEqual(
			RECORD_NON_RETRYABLE_ERROR_TYPES,
		);
		expect(RECORD_NON_RETRYABLE_ERROR_TYPES).toEqual(
			expect.arrayContaining([
				"RECORD_REJECTED",
				"DIRECT_COMMIT_SNAPSHOT_MISSING",
				"DIRECT_COMMIT_OUTCOME_REFUSED",
				"PrismaClientValidationError",
			]),
		);
	});
});
