// The Fabric run-result vocabulary (mirrors the `TestResult` Prisma enum). Reuse
// the canonical union from the forward mapper rather than redeclaring it — it is
// a pure, workflow-safe type-only import (no runtime coupling), and keeping one
// source of truth means the two directions can't silently drift.
import type { TestResultValue } from "../pm-integration/test-execution-serializer";

export type { TestResultValue };

/**
 * Inverse status mapper: a provider's RAW per-test outcome token →
 * Fabric's `TestResult`. The forward direction (Fabric → ADO) lives in
 * `test-execution-serializer.ts`; this is the read / ingest direction, shared by
 * every provider fetcher so the mapping is defined and tested once.
 *
 * Three distinct "did not pass" outcomes, deliberately not collapsed:
 *  - `NOT_RUN` — queued, pending, never reached.
 *  - `SKIPPED` — the suite deliberately did not run it (`skipped`, `ignored`,
 *    `[Ignore]`, `xit`). Nothing is wrong; it was opted out of.
 *  - `BLOCKED` — attempted and could not proceed (aborted, cancelled,
 *    inconclusive, timed out), plus any UNRECOGNISED token.
 *
 * An unknown token lands in `BLOCKED` rather than being silently counted as
 * passed — an ambiguous outcome should read as "needs attention", never green.
 * Matching is case-insensitive on a trimmed token.
 */
export function mapRawStatusToTestResult(raw: string): TestResultValue {
	switch (raw.trim().toLowerCase()) {
		case "passed":
		case "pass":
		case "success":
		case "succeeded":
		case "ok":
			return "PASSED";
		case "failed":
		case "fail":
		case "failure":
		case "error":
		case "errored":
		case "broken":
			return "FAILED";
		case "notexecuted":
		case "not_executed":
		case "notrun":
		case "not_run":
		case "pending":
		case "queued":
		case "none":
		case "":
			return "NOT_RUN";
		// Every runner spells a deliberate skip differently: JUnit/pytest emit
		// `skipped`, .NET emits `Skipped`/`NotApplicable`, some Java tooling emits
		// `ignored`, and Playwright reports `xit`/`test.skip` as `skipped`.
		case "skipped":
		case "skip":
		case "ignored":
		case "notapplicable":
		case "not_applicable":
		case "disabled":
			return "SKIPPED";
		default:
			// aborted / cancelled / inconclusive / timedout / error-ish tokens we
			// don't recognise — attempted but unfinished, so "needs attention".
			return "BLOCKED";
	}
}
