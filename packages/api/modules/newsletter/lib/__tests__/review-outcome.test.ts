/**
 * Unit tests for the newsletter review-outcome classifier (Fizzy #2172).
 *
 * The classifier is what turns "the row is not PENDING_APPROVAL" — today a
 * single blanket CONFLICT — into three distinct answers: proceed, the
 * reviewer's intent is ALREADY satisfied (idempotent no-op), or the row is in a
 * genuinely incompatible state (informational, names what the state actually
 * is). Pure and total, so it is tested directly rather than through a procedure.
 *
 * Run with: pnpm --filter @repo/api test review-outcome
 */

import { describe, expect, it } from "vitest";
import { classifyReviewOutcome } from "../review-outcome";

/**
 * Mirrors NEWSLETTER_SEND_STATUSES in @repo/database (newsletter-schema.ts).
 * Declared locally rather than imported so this stays a hermetic pure-function
 * test — importing @repo/database pulls in the Prisma client, which every other
 * suite in this package mocks away. The classifier is total by construction
 * (unknown statuses fall back), so drift here degrades to "a new status gets
 * the generic message", never to a throw.
 */
const ALL_STATUSES = [
	"PENDING",
	"PENDING_APPROVAL",
	"APPROVED",
	"SENT",
	"PARTIAL",
	"FAILED",
	"SKIPPED_EMPTY",
	"REJECTED",
	"EXPIRED",
] as const;

describe("classifyReviewOutcome — approve", () => {
	it("PENDING_APPROVAL is the only status that proceeds to a transition", () => {
		expect(classifyReviewOutcome("approve", "PENDING_APPROVAL")).toEqual({
			kind: "proceed",
		});
		for (const status of ALL_STATUSES.filter(
			(s) => s !== "PENDING_APPROVAL",
		)) {
			expect(classifyReviewOutcome("approve", status).kind).not.toBe(
				"proceed",
			);
		}
	});

	it("already-approved and already-sent rows are SATISFIED, not failures (AC1)", () => {
		// The reviewer wanted this newsletter approved and delivered. All three
		// states mean that already happened, so re-clicking Approve on a stale
		// row must never surface as a red banner.
		for (const status of ["APPROVED", "SENT", "PARTIAL"] as const) {
			const outcome = classifyReviewOutcome("approve", status);
			expect(outcome.kind).toBe("satisfied");
		}
	});

	it("names the actual state for rows that cannot be approved (AC2)", () => {
		const rejected = classifyReviewOutcome("approve", "REJECTED");
		expect(rejected.kind).toBe("incompatible");
		expect(rejected).toHaveProperty(
			"message",
			expect.stringMatching(/reject/i),
		);

		const expired = classifyReviewOutcome("approve", "EXPIRED");
		expect(expired.kind).toBe("incompatible");
		expect(expired).toHaveProperty(
			"message",
			expect.stringMatching(/expired/i),
		);

		const failed = classifyReviewOutcome("approve", "FAILED");
		expect(failed.kind).toBe("incompatible");
		expect(failed).toHaveProperty(
			"message",
			expect.stringMatching(/failed/i),
		);
	});
});

describe("classifyReviewOutcome — reject (AC5)", () => {
	it("PENDING_APPROVAL is the only status that proceeds to a transition", () => {
		expect(classifyReviewOutcome("reject", "PENDING_APPROVAL")).toEqual({
			kind: "proceed",
		});
		for (const status of ALL_STATUSES.filter(
			(s) => s !== "PENDING_APPROVAL",
		)) {
			expect(classifyReviewOutcome("reject", status).kind).not.toBe(
				"proceed",
			);
		}
	});

	it("already-stopped rows are SATISFIED — a rejected or expired draft will not be sent", () => {
		for (const status of ["REJECTED", "EXPIRED"] as const) {
			expect(classifyReviewOutcome("reject", status).kind).toBe(
				"satisfied",
			);
		}
	});

	it("an approved or sent row can no longer be rejected, and says so", () => {
		// The mirror image of approve: APPROVED is satisfied for approve but
		// incompatible for reject. This asymmetry is the whole point of keying
		// the table on the ACTION as well as the status — a shared table would
		// have to pick one and be wrong for the other.
		for (const status of ["APPROVED", "SENT", "PARTIAL"] as const) {
			const outcome = classifyReviewOutcome("reject", status);
			expect(outcome.kind).toBe("incompatible");
			expect(outcome).toHaveProperty(
				"message",
				expect.stringMatching(/no longer be rejected/i),
			);
		}
	});
});

describe("classifyReviewOutcome — totality", () => {
	it("returns a non-empty string for every known status and both actions", () => {
		for (const action of ["approve", "reject"] as const) {
			for (const status of ALL_STATUSES) {
				const outcome = classifyReviewOutcome(action, status);
				if (outcome.kind === "proceed") {
					continue;
				}
				const text =
					outcome.kind === "satisfied"
						? outcome.notice
						: outcome.message;
				expect(typeof text).toBe("string");
				expect(text.length).toBeGreaterThan(0);
			}
		}
	});

	it("an unrecognised status degrades to the generic conflict message", () => {
		const outcome = classifyReviewOutcome("approve", "SOME_FUTURE_STATUS");
		expect(outcome).toEqual({
			kind: "incompatible",
			message: "This newsletter is no longer awaiting review.",
		});
	});

	it("a prototype key never resolves through Object.prototype", () => {
		// `status` is a plain String column — nothing constrains what reaches it.
		// A bare `TABLE[status] ?? fallback` would resolve "constructor" and
		// "toString" to inherited FUNCTIONS, which are truthy and so defeat the
		// fallback, returning a function where the type promises a string. This
		// bit the sibling chat-delivery mapper; the lookup must use Object.hasOwn.
		for (const key of ["constructor", "toString", "valueOf", "__proto__"]) {
			const outcome = classifyReviewOutcome("approve", key);
			expect(outcome.kind).toBe("incompatible");
			expect(outcome).toHaveProperty(
				"message",
				"This newsletter is no longer awaiting review.",
			);
		}
	});
});
