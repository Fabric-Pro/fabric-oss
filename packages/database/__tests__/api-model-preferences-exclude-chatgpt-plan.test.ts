/**
 * API model preferences and ChatGPT plan model choices share one table
 * (Fizzy #2770 F5). The API readers must not return the plan's rows, and the
 * API writers must not delete them: saving or clearing a task's API model used
 * to wipe the organization's plan choice for the same task.
 *
 * An in-memory table evaluates each query's `where`, so these pin which rows
 * survive rather than the query shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const { orgRows, userRows } = vi.hoisted(() => ({
	orgRows: [] as Record<string, unknown>[],
	userRows: [] as Record<string, unknown>[],
}));

vi.mock("../prisma/queries/cache", () => ({
	aiTaskDefaultsCache: {
		getOrSet: async (_key: string, factory: () => Promise<unknown>) =>
			factory(),
	},
	aiModelCatalogCache: {
		getOrSet: async (_key: string, factory: () => Promise<unknown>) =>
			factory(),
	},
}));

vi.mock("../prisma/queries/ai-credits", () => ({
	estimateAiUsageCostUsd: vi.fn(),
}));

vi.mock("../prisma/client", () => {
	function matches(row: Row, where: Row): boolean {
		return Object.entries(where).every(([key, condition]) => {
			if (
				condition !== null &&
				typeof condition === "object" &&
				"not" in (condition as Row)
			) {
				return row[key] !== (condition as Row).not;
			}
			return row[key] === condition;
		});
	}
	const table = (rows: Row[]) => ({
		findMany: vi.fn(
			async ({
				where,
				orderBy = [],
			}: {
				where: Row;
				orderBy?: Row | Row[];
			}) => {
				const ordering = Array.isArray(orderBy) ? orderBy : [orderBy];
				return rows
					.filter((row) => matches(row, where))
					.sort((left, right) => {
						for (const clause of ordering) {
							const [field, direction] =
								Object.entries(clause)[0] ?? [];
							if (!field || left[field] === right[field]) {
								continue;
							}
							const comparison =
								left[field] instanceof Date &&
								right[field] instanceof Date
									? left[field].getTime() -
										right[field].getTime()
									: String(left[field]).localeCompare(
											String(right[field]),
										);
							if (comparison === 0) {
								continue;
							}
							return direction === "desc"
								? -comparison
								: comparison;
						}
						return 0;
					});
			},
		),
		deleteMany: vi.fn(async ({ where }: { where: Row }) => {
			const before = rows.length;
			for (let i = rows.length - 1; i >= 0; i--) {
				if (matches(rows[i], where)) {
					rows.splice(i, 1);
				}
			}
			return { count: before - rows.length };
		}),
	});
	return {
		db: {
			organizationModelPreference: table(orgRows),
			userModelPreference: table(userRows),
		},
	};
});

const {
	deleteOrgModelPreferencesByTaskType,
	getOrgModelPreferences,
	getUserModelPreferences,
} = await import("../prisma/queries/ai-models");

const ORG = "org-1";

beforeEach(() => {
	orgRows.length = 0;
	userRows.length = 0;
	orgRows.push(
		{ organizationId: ORG, taskType: "CHAT", provider: "OPENAI_DIRECT" },
		{
			organizationId: ORG,
			taskType: "CHAT",
			provider: "OPENAI_CHATGPT_PLAN",
		},
	);
	userRows.push(
		{ userId: "user-1", taskType: "CHAT", provider: "OPENAI_DIRECT" },
		{ userId: "user-1", taskType: "CHAT", provider: "OPENAI_CHATGPT_PLAN" },
	);
});

describe("API model preference readers", () => {
	it("return no ChatGPT plan row for an organization", async () => {
		const rows = await getOrgModelPreferences(ORG);

		expect(rows.map((row) => row.provider)).toEqual(["OPENAI_DIRECT"]);
	});

	it("return no ChatGPT plan row for a user", async () => {
		const rows = await getUserModelPreferences("user-1");

		expect(rows.map((row) => row.provider)).toEqual(["OPENAI_DIRECT"]);
	});

	it("still return a named provider's rows when asked for one", async () => {
		const rows = await getOrgModelPreferences(ORG, "OPENAI_CHATGPT_PLAN");

		expect(rows.map((row) => row.provider)).toEqual([
			"OPENAI_CHATGPT_PLAN",
		]);
	});

	it("puts the latest IMAGE choice first with a stable id tie-break", async () => {
		orgRows.push(
			{
				id: "image-z-vercel-old",
				organizationId: ORG,
				taskType: "IMAGE",
				provider: "VERCEL_GATEWAY",
				modelId: "image-model-vercel-old",
				updatedAt: new Date("2026-10-20T00:00:00.000Z"),
			},
			{
				id: "image-a-vercel-latest",
				organizationId: ORG,
				taskType: "IMAGE",
				provider: "VERCEL_GATEWAY",
				modelId: "image-model-vercel-latest",
				updatedAt: new Date("2026-10-21T00:00:00.000Z"),
			},
			{
				id: "image-z-openai-latest",
				organizationId: ORG,
				taskType: "IMAGE",
				provider: "OPENAI_DIRECT",
				modelId: "image-model-openai-latest",
				updatedAt: new Date("2026-10-21T00:00:00.000Z"),
			},
		);

		const rows = await getOrgModelPreferences(ORG);

		expect(
			rows.filter((row) => row.taskType === "IMAGE").map((row) => row.id),
		).toEqual([
			"image-z-openai-latest",
			"image-a-vercel-latest",
			"image-z-vercel-old",
		]);
	});
});

describe("deleteOrgModelPreferencesByTaskType", () => {
	it("clears the task's API rows and keeps the plan's choice", async () => {
		await deleteOrgModelPreferencesByTaskType(ORG, "CHAT");

		expect(orgRows).toEqual([
			{
				organizationId: ORG,
				taskType: "CHAT",
				provider: "OPENAI_CHATGPT_PLAN",
			},
		]);
	});
});
