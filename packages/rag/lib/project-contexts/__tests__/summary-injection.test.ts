import { beforeEach, describe, expect, it, vi } from "vitest";

const ENGINE_VERSION = 2;

// Mock the dependencies of applyContextSummary: the summary read + the
// covered-raw lookup + reference parsing + engine-version const (@repo/database),
// and the feature flag (@repo/utils).
vi.mock("@repo/database", () => ({
	db: {
		projectContext: { findMany: vi.fn() },
	},
	getLatestCompletedContextSummary: vi.fn(),
	parseSummaryReferences: (value: unknown) =>
		Array.isArray(value) ? value : [],
	// Mirror the real default: only an explicit `context: false` excludes context.
	parseSourceSelection: (value: unknown) => ({
		context: !(
			value &&
			typeof value === "object" &&
			(value as Record<string, unknown>).context === false
		),
		decisions: true,
		roadmap: true,
		codeRepo: true,
	}),
	CONTEXT_SUMMARY_ENGINE_VERSION: 2,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/utils/feature-flag", () => ({
	isContextSummarizationEnabled: vi.fn(),
}));

import { db, getLatestCompletedContextSummary } from "@repo/database";
import { isContextSummarizationEnabled } from "@repo/utils/feature-flag";
import type { RetrievedContext } from "../retrieval";
import {
	applyContextSummary,
	SUMMARY_CONTEXT_TYPE,
} from "../summary-injection";

const flag = vi.mocked(isContextSummarizationEnabled);
const getSummary = vi.mocked(getLatestCompletedContextSummary);
const findMany = vi.mocked(db.projectContext.findMany);

const scope = { projectId: "p1", userId: "u1", organizationId: null };

function ctx(id: string): RetrievedContext {
	return { id, type: "TEXT", content: `raw-${id}`, score: 0.5 };
}

const completedSummary = {
	id: "sum1",
	content: "Compressed history",
	coveredThrough: new Date("2026-06-01T00:00:00Z"),
	coveredContextCount: 7,
	engineVersion: ENGINE_VERSION,
	references: null,
} as unknown as Awaited<ReturnType<typeof getLatestCompletedContextSummary>>;

const legacySummary = {
	id: "legacy1",
	content: "Legacy compressed history",
	coveredThrough: new Date("2026-06-01T00:00:00Z"),
	coveredContextCount: 4,
	engineVersion: 1,
	references: null,
} as unknown as Awaited<ReturnType<typeof getLatestCompletedContextSummary>>;

const summaryWithRefs = {
	id: "sum2",
	content: "Adopted Postgres RLS [S1]",
	coveredThrough: new Date("2026-06-01T00:00:00Z"),
	coveredContextCount: 7,
	engineVersion: ENGINE_VERSION,
	references: [
		{
			marker: "S1",
			sourceType: "TEXT",
			sourceId: "ctx-1",
			sourceTimestamp: "2026-05-01T00:00:00.000Z",
			label: "RLS decision",
		},
	],
} as unknown as Awaited<ReturnType<typeof getLatestCompletedContextSummary>>;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("applyContextSummary", () => {
	it("returns the input unchanged when the flag is off (rollback-safe)", async () => {
		flag.mockReturnValue(false);
		const input = [ctx("a"), ctx("b")];

		const out = await applyContextSummary(input, scope);

		expect(out).toBe(input);
		expect(getSummary).not.toHaveBeenCalled();
		expect(findMany).not.toHaveBeenCalled();
	});

	it("returns the input unchanged when no completed summary exists", async () => {
		flag.mockReturnValue(true);
		getSummary.mockResolvedValue(null);
		const input = [ctx("a")];

		const out = await applyContextSummary(input, scope);

		expect(out).toBe(input);
		expect(findMany).not.toHaveBeenCalled();
	});

	it("prepends the summary, drops covered raw, keeps recent raw", async () => {
		flag.mockReturnValue(true);
		getSummary.mockResolvedValue(completedSummary);
		// "a" is covered by the watermark; "b" is recent (not returned here).
		findMany.mockResolvedValue([{ id: "a" }] as never);
		const input = [ctx("a"), ctx("b")];

		const out = await applyContextSummary(input, scope);

		expect(out).toHaveLength(2);
		const [summaryBlock, survivor] = out;
		expect(summaryBlock.type).toBe(SUMMARY_CONTEXT_TYPE);
		expect(summaryBlock.content).toBe("Compressed history");
		expect(summaryBlock.metadata).toMatchObject({
			isSummary: true,
			coveredContextCount: 7,
		});
		expect(survivor.id).toBe("b");
	});

	it("returns just the summary block when the search returned nothing", async () => {
		flag.mockReturnValue(true);
		getSummary.mockResolvedValue(completedSummary);

		const out = await applyContextSummary([], scope);

		expect(out).toHaveLength(1);
		expect(out[0].type).toBe(SUMMARY_CONTEXT_TYPE);
		// No raw ids to check ⇒ no covered-context query.
		expect(findMany).not.toHaveBeenCalled();
	});

	it("injects a context-EXCLUDED v2 summary additively — never drops raw context", async () => {
		flag.mockReturnValue(true);
		getSummary.mockResolvedValue({
			id: "sum-noctx",
			content: "Roadmap + decisions only",
			coveredThrough: new Date("2026-06-01T00:00:00Z"),
			coveredContextCount: 0,
			engineVersion: ENGINE_VERSION,
			references: null,
			sourceSelection: {
				context: false,
				decisions: true,
				roadmap: true,
				codeRepo: false,
			},
		} as never);
		const input = [ctx("a"), ctx("b")];

		const out = await applyContextSummary(input, scope);

		// The summary never incorporated raw context, so BOTH raw contexts survive
		// and the covered-raw drop query is never issued.
		expect(out).toHaveLength(3);
		expect(out[0].type).toBe(SUMMARY_CONTEXT_TYPE);
		expect(out.slice(1).map((c) => c.id)).toEqual(["a", "b"]);
		expect(findMany).not.toHaveBeenCalled();
	});

	it("injects a LEGACY (v1) summary additively — never drops raw context", async () => {
		flag.mockReturnValue(true);
		getSummary.mockResolvedValue(legacySummary);
		const input = [ctx("a"), ctx("b")];

		const out = await applyContextSummary(input, scope);

		// Summary prepended, but BOTH raw contexts survive (nothing hidden by an
		// untrustworthy watermark) and the covered-raw query is never issued.
		expect(out).toHaveLength(3);
		expect(out[0].type).toBe(SUMMARY_CONTEXT_TYPE);
		expect(out.slice(1).map((c) => c.id)).toEqual(["a", "b"]);
		expect(findMany).not.toHaveBeenCalled();
	});

	it("appends a machine-readable reference legend for a v2 summary with references", async () => {
		flag.mockReturnValue(true);
		getSummary.mockResolvedValue(summaryWithRefs);
		findMany.mockResolvedValue([] as never);

		const out = await applyContextSummary([ctx("z")], scope);

		const summaryBlock = out[0];
		expect(summaryBlock.content).toContain("Adopted Postgres RLS [S1]");
		expect(summaryBlock.content).toContain("SOURCE REFERENCES");
		expect(summaryBlock.content).toContain("sourceId: ctx-1");
		expect(summaryBlock.metadata).toMatchObject({
			isSummary: true,
			engineVersion: ENGINE_VERSION,
		});
	});
});
