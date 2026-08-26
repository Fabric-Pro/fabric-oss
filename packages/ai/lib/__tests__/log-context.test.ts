/**
 * Tests for the bug-analysis log-context port (Fizzy #1234).
 *
 * The interesting cases are the NEGATIVE ones — FR3 requires that a missing,
 * empty or unreachable log source still yields a successful analysis plus a
 * note explaining the absence, never a thrown error and never a silent gap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils/feature-flag", () => ({
	isBugAnalysisLogContextEnabled: vi.fn(),
}));
vi.mock("@repo/database", async (orig) => {
	const actual = await orig<Record<string, unknown>>();
	return { ...actual, getProjectMemberRole: vi.fn() };
});

import { getProjectMemberRole } from "@repo/database";
import { logger } from "@repo/logs";
import { isBugAnalysisLogContextEnabled } from "@repo/utils/feature-flag";
import type { RawLogEntry } from "@repo/utils/log-redaction";
import {
	applyPropertyPolicy,
	buildBugAnalysisLogContext,
	capEntriesToBudget,
	type LogSourceAdapter,
	renderLogContextClause,
} from "../log-context";

const flag = vi.mocked(isBugAnalysisLogContextEnabled);
const role = vi.mocked(getProjectMemberRole);

function adapterReturning(
	entries: RawLogEntry[],
	overrides: Partial<LogSourceAdapter> = {},
): LogSourceAdapter {
	return {
		kind: "test",
		label: "Test Log Source",
		sharedStore: false,
		fetchLogExcerpts: vi.fn().mockResolvedValue(entries),
		...overrides,
	};
}

const baseArgs = {
	projectId: "proj-1",
	requesterUserId: "user-1",
	surface: "unit-test",
	terms: ["checkout", "timeout"],
};

beforeEach(() => {
	vi.clearAllMocks();
	flag.mockReturnValue(true);
	// PROJECT_ADMIN holds PROJECT_SETTINGS_EDIT; EDITOR does not.
	role.mockResolvedValue("PROJECT_ADMIN" as never);
});

describe("buildBugAnalysisLogContext — gating", () => {
	it("returns disabled and never resolves a source when the flag is off", async () => {
		flag.mockReturnValue(false);
		const resolveAdapter = vi.fn();

		const out = await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter,
		});

		expect(out.status).toBe("disabled");
		expect(out.clause).toBe("");
		expect(resolveAdapter).not.toHaveBeenCalled();
	});

	it("refuses a requester without project-admin rights", async () => {
		role.mockResolvedValue("EDITOR" as never);
		const resolveAdapter = vi.fn();

		const out = await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter,
		});

		expect(out.status).toBe("unauthorized");
		expect(out.clause).toBe("");
		// Authorization is checked BEFORE the source is touched.
		expect(resolveAdapter).not.toHaveBeenCalled();
	});
});

describe("buildBugAnalysisLogContext — FR3 graceful degradation", () => {
	it("reports not-configured with a note when the project has no log source", async () => {
		const out = await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter: async () => null,
		});

		expect(out.status).toBe("not-configured");
		expect(out.clause).toBe("");
		expect(out.note).toMatch(/no log source is configured/i);
	});

	it("reports unavailable rather than throwing when the source errors", async () => {
		const out = await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter: async () => ({
				kind: "test",
				label: "Test Log Source",
				sharedStore: false,
				fetchLogExcerpts: async () => {
					throw new Error("platform down");
				},
			}),
		});

		expect(out.status).toBe("unavailable");
		expect(out.clause).toBe("");
		expect(out.note).toMatch(/could not be reached/i);
	});

	it("logs WHY the source was unreachable in a JSON-serialisable field", async () => {
		// `unavailable` is this feature's single failure mode, and its causes —
		// no credential, no role assignment, a bad workspace id — are
		// indistinguishable from the status alone. An Error's message is
		// non-enumerable, so passing the error object is not enough: it reaches
		// the JSON sink as `{}`.
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter: async () => ({
				kind: "test",
				label: "Test Log Source",
				sharedStore: false,
				fetchLogExcerpts: async () => {
					throw new Error(
						"no managed identity client id configured",
						{
							cause: new Error("underlying platform detail"),
						},
					);
				},
			}),
		});

		const fields = warn.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(fields.reason).toBe("no managed identity client id configured");
		expect(fields.cause).toBe("underlying platform detail");
		expect(JSON.parse(JSON.stringify(fields)).reason).toBe(
			"no managed identity client id configured",
		);

		warn.mockRestore();
	});

	it("reports unavailable when resolving the source itself throws", async () => {
		const out = await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter: async () => {
				throw new Error("config lookup failed");
			},
		});

		expect(out.status).toBe("unavailable");
	});

	it("reports empty when the source returns nothing in scope", async () => {
		const out = await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter: async () => adapterReturning([]),
		});

		expect(out.status).toBe("empty");
		expect(out.clause).toBe("");
	});
});

describe("buildBugAnalysisLogContext — shared-store tenancy", () => {
	it("refuses a shared store when the request carries no organization", async () => {
		const out = await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter: async () =>
				adapterReturning([{ message: "boom" }], { sharedStore: true }),
		});

		expect(out.status).toBe("not-configured");
		expect(out.clause).toBe("");
		expect(out.note).toMatch(/scoped to yours/i);
	});

	it("never queries the store on that refusal", async () => {
		const adapter = adapterReturning([{ message: "boom" }], {
			sharedStore: true,
		});
		await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter: async () => adapter,
		});
		expect(adapter.fetchLogExcerpts).not.toHaveBeenCalled();
	});

	it("refuses a shared store for a personal-context analysis too", async () => {
		const out = await buildBugAnalysisLogContext({
			...baseArgs,
			organizationId: null,
			resolveAdapter: async () =>
				adapterReturning([{ message: "boom" }], { sharedStore: true }),
		});

		expect(out.status).toBe("not-configured");
	});

	it("passes the session organization into the scope for a shared store", async () => {
		const adapter = adapterReturning([{ message: "boom" }], {
			sharedStore: true,
		});
		const out = await buildBugAnalysisLogContext({
			...baseArgs,
			organizationId: "org-9",
			resolveAdapter: async () => adapter,
		});

		expect(adapter.fetchLogExcerpts).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-9" }),
		);
		expect(out.status).toBe("included");
	});

	it("reads a dedicated store without an organization", async () => {
		const out = await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter: async () => adapterReturning([{ message: "boom" }]),
		});

		expect(out.status).toBe("included");
	});
});

describe("buildBugAnalysisLogContext — the happy path", () => {
	it("includes redacted entries and never the raw secret", async () => {
		const out = await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter: async () =>
				adapterReturning([
					{
						timestamp: "2026-08-19T10:00:00Z",
						severity: "error",
						message:
							"checkout failed for shopper@example.com token=abcd1234secretvalue",
					},
				]),
		});

		expect(out.status).toBe("included");
		expect(out.entryCount).toBe(1);
		// The clause is the section BODY; the prompt builder owns the `###`
		// heading, the same as it does for every other context source.
		expect(out.clause).not.toContain("### Application Logs");
		expect(out.clause).toContain("passed through automated redaction");
		expect(out.clause).toContain("checkout failed");
		expect(out.clause).not.toContain("shopper@example.com");
		expect(out.clause).not.toContain("abcd1234secretvalue");
		expect(out.redactionCount).toBeGreaterThan(0);
	});

	it("passes the caller's scope through to the adapter", async () => {
		const adapter = adapterReturning([{ message: "boom" }]);

		await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter: async () => adapter,
			scope: { lookbackMinutes: 30, maxEntries: 5 },
		});

		expect(adapter.fetchLogExcerpts).toHaveBeenCalledWith(
			expect.objectContaining({
				lookbackMinutes: 30,
				maxEntries: 5,
				minSeverity: "error",
				terms: ["checkout", "timeout"],
			}),
		);
	});

	it("surfaces dropped entries rather than hiding them", async () => {
		const out = await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter: async () =>
				adapterReturning([
					{ message: "kept" },
					{ message: null as unknown as string },
				]),
		});

		expect(out.status).toBe("included");
		expect(out.entryCount).toBe(1);
		expect(out.droppedCount).toBe(1);
	});
});

describe("renderLogContextClause", () => {
	it("tells the model what [REDACTED] means so it does not report it as a value", () => {
		const clause = renderLogContextClause(
			[{ message: "x", redactionCount: 0, truncated: false }],
			"Test Log Source",
		);
		expect(clause).toMatch(/\[REDACTED\]/);
		expect(clause).toMatch(/a value was removed here/i);
	});

	it("marks a truncated entry", () => {
		const clause = renderLogContextClause(
			[{ message: "head", redactionCount: 0, truncated: true }],
			"src",
		);
		expect(clause).toContain("(truncated)");
	});
});

describe("capEntriesToBudget — the budget covers the RENDERED clause", () => {
	// Regression, measured against a live Azure Monitor response: counting only
	// message + properties understated the cost by the preamble, timestamps,
	// severity markers and the `properties:` label, so a 12,000-character
	// budget produced a 14,200-character section.
	const entry = (i: number) => ({
		timestamp: `2026-08-19T10:00:${String(i).padStart(2, "0")}.000Z`,
		severity: "error",
		message: "x".repeat(200),
		properties: { requestId: `req-${i}`, detail: "y".repeat(100) },
		redactionCount: 0,
		truncated: false,
	});

	it("keeps the rendered section inside the budget", () => {
		const entries = Array.from({ length: 200 }, (_, i) => entry(i));
		const budget = 4_000;

		const kept = capEntriesToBudget(entries, budget, "Azure Monitor");
		const clause = renderLogContextClause(kept, "Azure Monitor");

		expect(kept.length).toBeGreaterThan(0);
		expect(clause.length).toBeLessThanOrEqual(budget);
	});

	it("reserves the preamble, so a budget under it yields nothing", () => {
		const preamble = renderLogContextClause([], "Azure Monitor").length;
		expect(
			capEntriesToBudget([entry(1)], preamble - 1, "Azure Monitor"),
		).toHaveLength(0);
	});
});

describe("capEntriesToBudget", () => {
	it("keeps only what fits the character budget", () => {
		const entries = Array.from({ length: 10 }, () => ({
			message: "a".repeat(100),
			redactionCount: 0,
			truncated: false,
		}));
		// The budget now covers the rendered section, so the preamble has to be
		// paid for before any entry fits. With no source label the preamble is
		// its smallest, and each entry costs its message plus "- " and a newline.
		const preamble = renderLogContextClause([], "").length;
		expect(capEntriesToBudget(entries, preamble + 350)).toHaveLength(3);
		// The old contract counted content only and would have kept 3 here too,
		// while rendering well past 350 characters.
		expect(capEntriesToBudget(entries, 350)).toHaveLength(0);
	});

	it("counts properties toward the budget", () => {
		const kept = capEntriesToBudget(
			[
				{
					message: "a".repeat(50),
					properties: { detail: "b".repeat(200) },
					redactionCount: 0,
					truncated: false,
				},
			],
			100,
		);
		expect(kept).toHaveLength(0);
	});
});

describe("applyPropertyPolicy — allowlist, not denylist", () => {
	const entries = [
		{
			message: "boom",
			properties: {
				requestId: "req-1",
				connectionString: "Server=x;Password=y",
				RequestId: "casing-differs",
			},
		},
	];

	it("drops the whole properties bag by default", () => {
		// The default is exclusion: an unknown key never reaches redaction, so
		// it cannot be partially matched or half-emitted.
		const [out] = applyPropertyPolicy(entries, []);
		expect(out).not.toHaveProperty("properties");
	});

	it("keeps only the keys an operator allowed", () => {
		const [out] = applyPropertyPolicy(entries, ["requestId"]);
		expect(Object.keys(out?.properties ?? {}).sort()).toEqual([
			"RequestId",
			"requestId",
		]);
		expect(out?.properties).not.toHaveProperty("connectionString");
	});

	it("matches keys case-insensitively, since platforms disagree on casing", () => {
		const [out] = applyPropertyPolicy(entries, ["REQUESTID"]);
		expect(Object.keys(out?.properties ?? {})).toContain("requestId");
	});

	it("omits the bag entirely when nothing survives the allowlist", () => {
		const [out] = applyPropertyPolicy(entries, ["nothing-matches"]);
		expect(out).not.toHaveProperty("properties");
	});

	it("leaves entries that never had properties untouched", () => {
		expect(applyPropertyPolicy([{ message: "m" }], ["requestId"])).toEqual([
			{ message: "m" },
		]);
	});
});

describe("the property policy is enforced through the port", () => {
	it("strips properties before they can reach the model", async () => {
		const out = await buildBugAnalysisLogContext({
			...baseArgs,
			resolveAdapter: async () => ({
				kind: "test",
				label: "Test Log Source",
				sharedStore: false,
				fetchLogExcerpts: async () => [
					{
						message: "checkout failed",
						properties: {
							connectionString: "Server=x;Password=hunter2",
						},
					},
				],
			}),
		});

		expect(out.status).toBe("included");
		expect(out.clause).toContain("checkout failed");
		// Not merely redacted — absent.
		expect(out.clause).not.toContain("connectionString");
		expect(out.clause).not.toContain("hunter2");
		expect(out.clause).not.toContain("properties:");
	});
});
