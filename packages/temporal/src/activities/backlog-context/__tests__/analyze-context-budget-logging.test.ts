/**
 * Fizzy #2316 (Phase 2 groundwork) — `applyTokenBudget` records what it evicted.
 *
 * Allocation is greedy in a fixed priority order, so one oversized section
 * silently evicts everything behind it. Whether accumulated context is actually
 * hurting analyses is the open question behind a retention/"compression timer"
 * feature, and it cannot be answered by guessing — so the budget now emits one
 * structured line per run.
 *
 * The property that matters most here is the **denominator**: a measurement
 * that only fires under pressure tells you how often things were dropped but
 * not out of how many runs, which is exactly how a rare event gets mistaken for
 * a common one. So both exit paths log, and `underPressure` distinguishes them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const infoMock = vi.fn();

vi.mock("@repo/logs", () => ({
	logger: {
		info: (...a: unknown[]) => infoMock(...a),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { applyTokenBudget } from "../analyze-context";

/** ~4 chars per token, so 1,000 chars is ~250 tokens. */
const small = "s".repeat(1_000);
/** Large enough to exhaust the 80k-token budget on its own. */
const huge = "h".repeat(400_000);

type BudgetLog = {
	event: string;
	projectId?: string;
	underPressure: boolean;
	droppedSections: string[];
	truncatedSections: string[];
	requestedContextTokens: number;
	sections: Array<{
		key: string;
		requestedTokens: number;
		grantedTokens: number;
		outcome: string;
	}>;
};

function budgetLog(): BudgetLog {
	const call = infoMock.mock.calls.find(
		(c) =>
			(c[1] as { event?: string } | undefined)?.event ===
			"backlog.context_budget",
	);
	if (!call) {
		throw new Error("no backlog.context_budget line was emitted");
	}
	return call[1] as BudgetLog;
}

beforeEach(() => {
	infoMock.mockReset();
});

describe("applyTokenBudget — budget outcome logging", () => {
	it("logs on the happy path too, so the pressure rate has a denominator", () => {
		applyTokenBudget({
			meetingTranscripts: "meetings",
			ragContext: "rag",
			backlog: small,
			systemPrompt: small,
			userPrompt: small,
			projectId: "proj-1",
		});

		const log = budgetLog();
		expect(log.underPressure).toBe(false);
		expect(log.projectId).toBe("proj-1");
		expect(log.droppedSections).toEqual([]);
		expect(log.truncatedSections).toEqual([]);
		expect(log.sections.every((s) => s.outcome === "kept")).toBe(true);
	});

	it("names the sections an oversized source evicted", () => {
		applyTokenBudget({
			// Ranks above notionContent and ragContext, and on its own exceeds
			// the whole budget — so the two behind it cannot survive.
			meetingTranscripts: huge,
			notionContent: "notion",
			ragContext: "rag",
			backlog: small,
			systemPrompt: small,
			userPrompt: small,
			projectId: "proj-1",
		});

		const log = budgetLog();
		expect(log.underPressure).toBe(true);
		expect(log.droppedSections).toEqual(["notionContent", "ragContext"]);
		expect(log.truncatedSections).toEqual(["meetingTranscripts"]);

		// The size of the ask is recorded even for what was refused — that is
		// what tells us how far over the line a project actually is.
		const dropped = log.sections.find((s) => s.key === "ragContext");
		expect(dropped?.grantedTokens).toBe(0);
		expect(dropped?.requestedTokens).toBeGreaterThan(0);
	});

	it("records the total-loss case where fixed content alone exceeds the budget", () => {
		applyTokenBudget({
			meetingTranscripts: "meetings",
			backlog: huge,
			systemPrompt: huge,
			userPrompt: small,
		});

		const log = budgetLog();
		expect(log.underPressure).toBe(true);
		expect(log.sections).toEqual([]);
	});

	it("reports what was asked for, not merely what fit", () => {
		applyTokenBudget({
			meetingTranscripts: huge,
			backlog: small,
			systemPrompt: small,
			userPrompt: small,
		});

		const log = budgetLog();
		// ~400k chars / 4 = ~100k tokens requested against an 80k ceiling.
		expect(log.requestedContextTokens).toBeGreaterThan(80_000);
	});
});
