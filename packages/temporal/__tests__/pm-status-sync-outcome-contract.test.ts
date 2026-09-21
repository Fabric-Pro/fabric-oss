/**
 * The status-sync outcome vocabulary is declared twice (Fizzy #2304): in
 * `@repo/integrations/pm` (`StatusSyncOutcome`, which the decision table
 * produces) and structurally inside `@repo/database`'s last-run zod schema,
 * which cannot import integrations — the dependency points the other way.
 *
 * This pin lives in temporal because temporal depends on BOTH packages and
 * type-checks its tests (its tsconfig includes `__tests__`), so the
 * compile-time half below is enforced by `tsc`, not merely present.
 *
 * Run with: corepack pnpm --filter @repo/temporal exec vitest run __tests__/pm-status-sync-outcome-contract.test.ts
 */
import {
	type PmStatusSyncLastRun,
	pmStatusSyncLastRunSchema,
} from "@repo/database";
import {
	STATUS_SYNC_OUTCOMES,
	type StatusSyncOutcome,
} from "@repo/integrations/pm";
import { describe, expect, it } from "vitest";

type DatabaseOutcome = keyof NonNullable<
	PmStatusSyncLastRun["outcome"]
>["counts"];

/** Exact type equality: true only when A and B are the same union. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
	? 1
	: 2
	? true
	: false;

// Compile-time pin. This assignment stops type-checking the moment either
// side gains or loses an outcome — a bare `type _ = Equal<…>` would never fail.
const vocabulariesMatch: Equal<DatabaseOutcome, StatusSyncOutcome> = true;

const SESSION_AT = "2026-09-21T09:00:00.000Z";
const OUTCOME_AT = "2026-09-21T10:00:00.000Z";

describe("status-sync outcome vocabulary (Fizzy #2304)", () => {
	it("is one set across @repo/integrations and the @repo/database last-run schema", () => {
		expect(vocabulariesMatch).toBe(true);
		const counts = Object.fromEntries(
			STATUS_SYNC_OUTCOMES.map((outcome, i) => [outcome, i + 1]),
		) as Record<StatusSyncOutcome, number>;

		const parsed = pmStatusSyncLastRunSchema.parse({
			sessionAt: SESSION_AT,
			outcome: { at: OUTCOME_AT, counts },
		});

		// Every integrations outcome survives the schema, and nothing else appears.
		expect(parsed.outcome?.counts).toEqual(counts);
	});

	it("rejects a summary whose counts miss an outcome, after a positive control", () => {
		const full = Object.fromEntries(
			STATUS_SYNC_OUTCOMES.map((o) => [o, 0]),
		);
		const missingRaced = Object.fromEntries(
			STATUS_SYNC_OUTCOMES.filter((o) => o !== "raced").map((o) => [
				o,
				0,
			]),
		);
		const summary = (counts: Record<string, number>) => ({
			sessionAt: SESSION_AT,
			outcome: { at: OUTCOME_AT, counts },
		});

		expect(pmStatusSyncLastRunSchema.safeParse(summary(full)).success).toBe(
			true,
		);
		expect(
			pmStatusSyncLastRunSchema.safeParse(summary(missingRaced)).success,
		).toBe(false);
	});
});
