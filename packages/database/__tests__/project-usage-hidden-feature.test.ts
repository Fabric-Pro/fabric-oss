/**
 * A project reader who may not see one feature's spend (Parlume's, kept for
 * the people who can invite it) gets usage views without that feature's
 * calls, and still gets the calls that carry no feature key.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
const findMany = vi.fn();

type Sql = { strings: readonly string[]; values: unknown[] };

vi.mock("../prisma/client", () => ({
	Prisma: {
		sql: (strings: TemplateStringsArray, ...values: unknown[]): Sql => ({
			strings,
			values,
		}),
		empty: { strings: [""], values: [] },
	},
	db: {
		$queryRaw: queryRaw,
		aiUsageLog: { findMany },
	},
}));

const {
	getProjectUsageBreakdown,
	getProjectUsageRecent,
	getProjectUsageSummary,
	getProjectUsageTimeSeries,
} = await import("../prisma/queries/project-ai-usage");

/** The query's text with every nested fragment and value written in. */
function text(sql: unknown): string {
	if (sql && typeof sql === "object" && "strings" in sql) {
		const { strings, values } = sql as Sql;
		return strings
			.map((part, index) =>
				index < values.length ? part + text(values[index]) : part,
			)
			.join("");
	}
	return sql instanceof Date ? "<date>" : String(sql);
}

beforeEach(() => {
	queryRaw.mockReset().mockResolvedValue([]);
	findMany.mockReset().mockResolvedValue([]);
});

const HIDDEN = '"featureKey" IS DISTINCT FROM parlume';
const scope = { projectId: "p1", hiddenFeatureKey: "parlume" };

describe("project usage with a hidden feature", () => {
	it("leaves the feature out of the summary, breakdown and time series", async () => {
		await getProjectUsageSummary({ ...scope, range: "all" });
		await getProjectUsageBreakdown({
			...scope,
			range: "30d",
			groupBy: "model",
		});
		await getProjectUsageTimeSeries({
			...scope,
			range: "7d",
			bucket: "day",
		});

		expect(queryRaw).toHaveBeenCalledTimes(3);
		for (const [sql] of queryRaw.mock.calls) {
			expect(text(sql)).toContain(HIDDEN);
		}
	});

	it("filters nothing for a caller who may see every feature", async () => {
		await getProjectUsageSummary({ projectId: "p1", range: "all" });

		expect(text(queryRaw.mock.calls[0]?.[0])).not.toContain("featureKey");
	});

	it("leaves the feature out of the recent calls, keeping calls with no key", async () => {
		await getProjectUsageRecent(scope);
		await getProjectUsageRecent({ projectId: "p1" });

		expect(findMany.mock.calls[0]?.[0].where).toEqual({
			projectId: "p1",
			OR: [{ featureKey: null }, { featureKey: { not: "parlume" } }],
		});
		expect(findMany.mock.calls[1]?.[0].where).toEqual({ projectId: "p1" });
	});
});
