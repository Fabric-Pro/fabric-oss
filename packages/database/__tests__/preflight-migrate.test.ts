import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type ActivityRow,
	awaitQuietTransactions,
	DEFAULT_LONG_TX_THRESHOLD_MS,
	evaluateAdvisoryLock,
	evaluateLongRunningTransactions,
	evaluateMigrationLedger,
	type MigrationLedgerRow,
	parseThresholdArg,
	summarize,
} from "../scripts/preflight-migrate";

function ledgerRow(
	overrides: Partial<MigrationLedgerRow> = {},
): MigrationLedgerRow {
	return {
		migration_name: "20260101000000_example",
		finished_at: new Date("2026-01-01T00:00:00Z"),
		rolled_back_at: null,
		applied_steps_count: 1,
		...overrides,
	};
}

function activityRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
	return {
		pid: 1,
		state: "idle in transaction",
		duration_ms: 0,
		...overrides,
	};
}

describe("evaluateMigrationLedger", () => {
	it("passes when every migration finished", () => {
		expect(evaluateMigrationLedger([ledgerRow(), ledgerRow()]).ok).toBe(
			true,
		);
	});

	it("passes on an empty ledger", () => {
		expect(evaluateMigrationLedger([]).ok).toBe(true);
	});

	it("fails when a migration started but never finished", () => {
		const result = evaluateMigrationLedger([
			ledgerRow({ finished_at: null }),
		]);
		expect(result.ok).toBe(false);
		expect(result.detail).toMatch(/never finished/);
		expect(result.detail).toContain("20260101000000_example");
	});

	it("passes when a migration is marked rolled back — that is the resolved state", () => {
		// `prisma migrate resolve --rolled-back` writes this to record that a
		// failed migration has been dealt with. The dev database carries two such
		// rows while `prisma migrate status` reports the schema up to date;
		// treating them as failures blocked every deploy.
		const result = evaluateMigrationLedger([
			ledgerRow({ rolled_back_at: new Date() }),
		]);
		expect(result.ok).toBe(true);
		expect(result.detail).toMatch(/previously resolved as rolled back/);
	});

	it("still fails a migration left mid-flight even when another was resolved", () => {
		const result = evaluateMigrationLedger([
			ledgerRow({
				migration_name: "resolved",
				rolled_back_at: new Date(),
			}),
			ledgerRow({ migration_name: "mid_flight", finished_at: null }),
		]);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("mid_flight");
		expect(result.detail).not.toContain("resolved,");
	});

	it("names the unfinished migration rather than only counting it", () => {
		const result = evaluateMigrationLedger([
			ledgerRow({
				migration_name: "20260202000000_broken",
				finished_at: null,
			}),
		]);
		expect(result.detail).toContain("20260202000000_broken");
	});

	// Fizzy #2237. This detail is the ONE thing an operator sees when a
	// promotion is blocked, and it used to end at the bare command name.
	// `prisma migrate resolve` takes `--applied` or `--rolled-back`, the two are
	// opposites, and a third reachable state takes neither — so the message
	// named a command whose correct form could not be chosen from it. The likely
	// move under deploy pressure is to guess, and one guess records a migration
	// as applied that never ran.
	//
	// A message that sends an operator to a runbook makes that runbook part of
	// the interface, so the path and the section are asserted literally: a
	// renamed heading has to turn this red rather than ship a dead pointer.
	it("sends the operator to the runbook instead of naming a bare command", () => {
		const result = evaluateMigrationLedger([
			ledgerRow({ finished_at: null }),
		]);
		expect(result.ok).toBe(false);
		// Both halves of the two-way decision, so neither reads as the default.
		expect(result.detail).toContain("--applied");
		expect(result.detail).toContain("--rolled-back");
		// The page that decides between them, by path and by section.
		expect(result.detail).toContain("docs/database-promotion.md");
		expect(result.detail).toContain(
			"When an ordinary index build leaves the migration unresolved",
		);
		// Still names what is stuck — the runbook's diagnostic SQL needs it.
		expect(result.detail).toContain("20260101000000_example");
	});

	// The case above pins the message. It cannot pin the DESTINATION: rename the
	// heading in the runbook and that test stays green while the pointer rots
	// into exactly the dead end this card exists to remove. So assert the target
	// too, from the message itself rather than from a second copy of the string
	// — a literal repeated here could drift from the one that ships.
	it("points at a section that actually exists in the runbook", () => {
		const detail = evaluateMigrationLedger([
			ledgerRow({ finished_at: null }),
		]).detail;

		const cited = detail.match(/§ "([^"]+)"/);
		expect(
			cited,
			"the detail should cite a runbook section",
		).not.toBeNull();

		const runbook = readFileSync(
			join(__dirname, "..", "..", "..", "docs", "database-promotion.md"),
			"utf8",
		);
		// Heading, not a passing mention — the message promises a section.
		const headings = runbook
			.split("\n")
			.filter((line) => line.startsWith("#"))
			.map((line) => line.replace(/^#+\s*/, "").trim());
		expect(headings).toContain(cited?.[1]);
	});
});

describe("evaluateLongRunningTransactions", () => {
	it("passes when nothing is long-running", () => {
		expect(
			evaluateLongRunningTransactions([activityRow({ duration_ms: 100 })])
				.ok,
		).toBe(true);
	});

	it("passes on an idle database", () => {
		expect(evaluateLongRunningTransactions([]).ok).toBe(true);
	});

	it("fails on a transaction at or beyond the threshold", () => {
		const result = evaluateLongRunningTransactions([
			activityRow({ pid: 42, duration_ms: DEFAULT_LONG_TX_THRESHOLD_MS }),
		]);
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("pid 42");
	});

	it("honours a custom threshold", () => {
		const rows = [activityRow({ duration_ms: 5_000 })];
		expect(evaluateLongRunningTransactions(rows, 10_000).ok).toBe(true);
		expect(evaluateLongRunningTransactions(rows, 1_000).ok).toBe(false);
	});
});

describe("evaluateAdvisoryLock", () => {
	it("passes when the lock is free", () => {
		expect(evaluateAdvisoryLock(true).ok).toBe(true);
	});

	it("fails when another migration holds it", () => {
		const result = evaluateAdvisoryLock(false);
		expect(result.ok).toBe(false);
		expect(result.detail).toMatch(/another migration is running/i);
	});
});

describe("parseThresholdArg", () => {
	it("returns the fallback when the flag is absent", () => {
		expect(parseThresholdArg([], "--long-tx-threshold-ms", 30_000)).toBe(
			30_000,
		);
	});

	it("reads a valid value", () => {
		expect(
			parseThresholdArg(
				["--long-tx-threshold-ms", "5000"],
				"--long-tx-threshold-ms",
				30_000,
			),
		).toBe(5_000);
	});

	it("falls back on a non-numeric or non-positive value rather than disabling the check", () => {
		expect(
			parseThresholdArg(
				["--long-tx-threshold-ms", "abc"],
				"--long-tx-threshold-ms",
				30_000,
			),
		).toBe(30_000);
		expect(
			parseThresholdArg(
				["--long-tx-threshold-ms", "0"],
				"--long-tx-threshold-ms",
				30_000,
			),
		).toBe(30_000);
		expect(
			parseThresholdArg(
				["--long-tx-threshold-ms", "-1"],
				"--long-tx-threshold-ms",
				30_000,
			),
		).toBe(30_000);
	});
});

describe("summarize", () => {
	it("is ok only when every check passed", () => {
		expect(summarize([{ name: "a", ok: true, detail: "" }]).ok).toBe(true);
		expect(
			summarize([
				{ name: "a", ok: true, detail: "" },
				{ name: "b", ok: false, detail: "" },
			]).ok,
		).toBe(false);
	});

	it("renders one labelled line per check", () => {
		const { report } = summarize([
			{ name: "a", ok: true, detail: "fine" },
			{ name: "b", ok: false, detail: "broken" },
		]);
		expect(report).toContain("PASS  a: fine");
		expect(report).toContain("FAIL  b: broken");
	});
});

// Fizzy #1850 follow-up. The long-transaction check took ONE sample and failed
// the whole promotion on it. On 2026-08-19 a single transaction 37s old, against
// a 30s threshold, aborted a dev deploy and — because the deploy workflow
// serializes on a concurrency group — left every queued deploy behind it waiting
// for over an hour.
//
// An idle transaction a few seconds past the threshold is a fluctuating
// quantity, not a verdict. Waiting a bounded while and re-sampling costs a
// minute in the bad case and saves the pipeline in the common one. It cannot
// make an unsafe migration proceed: a condition that persists still fails.
describe("awaitQuietTransactions", () => {
	const quiet = {
		name: "long-running-transactions",
		ok: true,
		detail: "none",
	};
	const busy = {
		name: "long-running-transactions",
		ok: false,
		detail: "1 transaction(s) open longer than 30000ms",
	};

	it("returns immediately on a clean first sample, without sleeping", async () => {
		const sleeps: number[] = [];
		const result = await awaitQuietTransactions({
			sample: async () => quiet,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			budgetMs: 60_000,
			intervalMs: 5_000,
		});
		expect(result.ok).toBe(true);
		// The healthy path is every ordinary deploy; it must not pay for this.
		expect(sleeps).toEqual([]);
	});

	it("re-samples and passes when the transaction clears", async () => {
		let calls = 0;
		const sleeps: number[] = [];
		const result = await awaitQuietTransactions({
			sample: async () => {
				calls += 1;
				return calls === 1 ? busy : quiet;
			},
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			budgetMs: 60_000,
			intervalMs: 5_000,
		});
		expect(result.ok).toBe(true);
		expect(calls).toBe(2);
		expect(sleeps).toEqual([5_000]);
	});

	it("still fails when the transaction persists, and says how long it waited", async () => {
		let calls = 0;
		const sleeps: number[] = [];
		const result = await awaitQuietTransactions({
			sample: async () => {
				calls += 1;
				return busy;
			},
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			budgetMs: 20_000,
			intervalMs: 5_000,
		});
		expect(result.ok).toBe(false);
		// The whole point of the guard survives: a real blocker still stops the
		// promotion. Only the verdict is slower and better evidenced.
		//
		// FIVE samples and FOUR sleeps for a 20s budget at a 5s interval: the
		// first sample is taken before any waiting, so the budget buys sleeps,
		// not attempts. An earlier version counted the initial sample against the
		// budget and so waited 15s while claiming 20s — raised by the Copilot
		// review on this PR.
		expect(calls).toBe(5);
		expect(sleeps).toEqual([5_000, 5_000, 5_000, 5_000]);
		// Tied to the OBSERVED sleeps rather than to the literal 20000, so the
		// reported number and the real one cannot drift apart again — which is
		// the mistake, not the arithmetic.
		const actuallySlept = sleeps.reduce((a, b) => a + b, 0);
		expect(actuallySlept).toBe(20_000);
		expect(result.detail).toContain(`${actuallySlept}ms`);
	});

	it("samples exactly once when there is no waiting budget", async () => {
		let calls = 0;
		const result = await awaitQuietTransactions({
			sample: async () => {
				calls += 1;
				return busy;
			},
			sleep: async () => {
				throw new Error("must not sleep with a zero budget");
			},
			budgetMs: 0,
			intervalMs: 5_000,
		});
		expect(result.ok).toBe(false);
		expect(calls).toBe(1);
	});
});
