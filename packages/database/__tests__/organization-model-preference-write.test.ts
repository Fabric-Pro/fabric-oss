import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, events, rows, locks } = vi.hoisted(() => ({
	db: {
		$transaction: vi.fn(),
		organizationModelPreference: { deleteMany: vi.fn(), upsert: vi.fn() },
	},
	events: [] as string[],
	rows: [] as Array<{
		organizationId: string;
		taskType: string;
		provider: string;
		modelId: string | null;
	}>,
	locks: new Map<string, Promise<void>>(),
}));
vi.mock("../prisma/client", () => ({ db }));

import { replaceOrgModelPreferenceForTask } from "../prisma/queries/organization-model-preference-write";

beforeEach(() => {
	vi.clearAllMocks();
	rows.length = 0;
	events.length = 0;
	locks.clear();
	db.$transaction.mockImplementation(async (callback) => {
		let unlock: (() => void) | undefined;
		const tx = {
			$queryRaw: vi.fn(
				async (sql: TemplateStringsArray, organizationId: string) => {
					expect(sql.join("?")).toBe(
						'SELECT id FROM "organization" WHERE id = ? FOR NO KEY UPDATE',
					);
					const previous =
						locks.get(organizationId) ?? Promise.resolve();
					locks.set(
						organizationId,
						new Promise<void>((resolve) => {
							unlock = resolve;
						}),
					);
					await previous;
					events.push("lock");
					return [{ id: organizationId }];
				},
			),
			organizationModelPreference: {
				deleteMany: vi.fn(async ({ where }) => {
					events.push("delete");
					expect(where.provider).toEqual({
						not: "OPENAI_CHATGPT_PLAN",
					});
					for (let i = rows.length - 1; i >= 0; i--) {
						if (
							rows[i].organizationId === where.organizationId &&
							rows[i].taskType === where.taskType &&
							rows[i].provider !== where.provider.not
						) {
							rows.splice(i, 1);
						}
					}
				}),
				upsert: vi.fn(async ({ create, include }) => {
					events.push("upsert");
					expect(include).toEqual({ model: true });
					rows.push({ ...create });
					return { id: "example-preference", ...create, model: null };
				}),
			},
		};
		try {
			return await callback(tx);
		} finally {
			unlock?.();
		}
	});
});

describe("replace organization task preference", () => {
	it.each(["example-openjev", null])(
		"locks, deletes and writes model %s in one transaction",
		async (modelId) => {
			rows.push({
				organizationId: "example-org",
				taskType: "DECISION",
				provider: "DATABRICKS",
				modelId: "example-old-model",
			});
			const preference = await replaceOrgModelPreferenceForTask({
				organizationId: "example-org",
				taskType: "DECISION",
				provider: "VERCEL_GATEWAY",
				modelId,
			});
			expect(db.$transaction).toHaveBeenCalledTimes(1);
			expect(events).toEqual(["lock", "delete", "upsert"]);
			expect(rows).toEqual([
				{
					organizationId: "example-org",
					taskType: "DECISION",
					provider: "VERCEL_GATEWAY",
					modelId,
				},
			]);
			expect(preference).toMatchObject({
				provider: "VERCEL_GATEWAY",
				modelId,
			});
			expect(
				db.organizationModelPreference.deleteMany,
			).not.toHaveBeenCalled();
			expect(
				db.organizationModelPreference.upsert,
			).not.toHaveBeenCalled();
		},
	);
	it("serializes concurrent provider choices into one decision row", async () => {
		await Promise.all([
			replaceOrgModelPreferenceForTask({
				organizationId: "example-org",
				taskType: "DECISION",
				provider: "VERCEL_GATEWAY",
				modelId: "example-luna",
			}),
			replaceOrgModelPreferenceForTask({
				organizationId: "example-org",
				taskType: "DECISION",
				provider: "DATABRICKS",
				modelId: "example-openjev",
			}),
		]);
		expect(events).toEqual([
			"lock",
			"delete",
			"upsert",
			"lock",
			"delete",
			"upsert",
		]);
		expect(rows).toEqual([
			{
				organizationId: "example-org",
				taskType: "DECISION",
				provider: "DATABRICKS",
				modelId: "example-openjev",
			},
		]);
	});
	it("preserves another organization and a ChatGPT-plan preference", async () => {
		const other = {
			organizationId: "example-other-org",
			taskType: "DECISION",
			provider: "DATABRICKS",
			modelId: "example-other-model",
		};
		const plan = {
			organizationId: "example-org",
			taskType: "CHAT",
			provider: "OPENAI_CHATGPT_PLAN",
			modelId: "example-plan-model",
		};
		rows.push(other, plan);
		await replaceOrgModelPreferenceForTask({
			organizationId: "example-org",
			taskType: "CHAT",
			provider: "DATABRICKS",
			modelId: "example-chat-model",
			customParameters: { temperature: 0.2 },
		});
		expect(rows).toContainEqual(other);
		expect(rows).toContainEqual(plan);
		expect(rows).toContainEqual(
			expect.objectContaining({
				provider: "DATABRICKS",
				customParameters: { temperature: 0.2 },
			}),
		);
	});
});
