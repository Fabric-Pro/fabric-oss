import { beforeEach, describe, expect, it, vi } from "vitest";
import { snapshotFixture } from "./_helpers/task-default-snapshot";

const { mockDb, state } = vi.hoisted(() => {
	const state = { snapshot: null as unknown, competing: null as unknown };
	const delegate = () => ({
		updateMany: vi.fn(async ({ where, data }) => {
			if (where.taskDefaultsSnapshot.equals !== "sql-null") {
				throw new Error("not conditional");
			}
			if (state.competing) {
				state.snapshot = state.competing;
			}
			if (state.snapshot !== null) {
				return { count: 0 };
			}
			state.snapshot = data.taskDefaultsSnapshot;
			return { count: 1 };
		}),
		findUniqueOrThrow: vi.fn(async () => ({
			taskDefaultsSnapshot: state.snapshot,
		})),
	});
	return {
		state,
		mockDb: {
			aiTaskModelDefault: { findMany: vi.fn() },
			aiModel: { findUnique: vi.fn() },
			cloudProviderConfig: delegate(),
			userCloudProviderConfig: delegate(),
		},
	};
});
vi.mock("../prisma/client", () => ({
	db: mockDb,
	Prisma: { DbNull: "sql-null" },
}));

import { getTaskDefaultModel } from "../prisma/queries/ai-models";
import { aiTaskDefaultsCache } from "../prisma/queries/cache";
import {
	captureTaskDefaultsSnapshot,
	materializeTaskDefaultsSnapshot,
	readTaskDefaultsSnapshot,
	TEXT_TASK_TYPES,
	taskDefaultsSnapshotMutation,
} from "../prisma/queries/task-default-snapshots";

const old = snapshotFixture({ CHAT: "example-old" });
let rows: {
	id: string;
	provider: string | null;
	taskType: string;
	priority: number;
	model: { canonicalName: string };
}[];
beforeEach(() => {
	vi.clearAllMocks();
	aiTaskDefaultsCache.clear();
	state.snapshot = null;
	state.competing = null;
	rows = [
		{
			id: "a",
			provider: "OPENAI_DIRECT",
			taskType: "CHAT",
			priority: 100,
			model: { canonicalName: "example-current" },
		},
	];
	mockDb.aiTaskModelDefault.findMany.mockImplementation(
		async ({ where, orderBy, take }) => {
			expect(orderBy).toEqual([{ priority: "desc" }, { id: "asc" }]);
			expect(take).toBe(1);
			expect(where.complexity).toBe("MEDIUM");
			return rows
				.filter(
					(row) =>
						row.taskType === where.taskType &&
						(!where.provider || row.provider === where.provider),
				)
				.sort(
					(a, b) =>
						b.priority - a.priority || a.id.localeCompare(b.id),
				)
				.slice(0, 1);
		},
	);
});
it("captures separate scoped and unscoped results without reading a stale cache", async () => {
	await getTaskDefaultModel("CHAT", "MEDIUM", "OPENAI_DIRECT");
	await getTaskDefaultModel("CHAT", "MEDIUM");
	rows[0].model = { canonicalName: "example-new" };
	const snapshot = await captureTaskDefaultsSnapshot("OPENAI_DIRECT");
	expect(snapshot.scoped).toEqual(
		snapshotFixture({ CHAT: "example-new" }).scoped,
	);
	expect(snapshot.unscoped).toEqual(snapshot.scoped);
	expect(
		(await getTaskDefaultModel("CHAT", "MEDIUM", "OPENAI_DIRECT"))
			?.canonicalName,
	).toBe("example-current");
	rows = [];
	const empty = await captureTaskDefaultsSnapshot("OPENAI_DIRECT");
	expect(empty.scoped).toEqual(snapshotFixture().scoped);
	expect(empty.unscoped).toEqual(empty.scoped);
});
it.each([false, true])(
	"captures creation with isDefault=%s",
	async (isDefault) => {
		expect(
			await taskDefaultsSnapshotMutation(
				"OPENAI_DIRECT",
				null,
				isDefault,
			),
		).toHaveProperty("taskDefaultsSnapshot");
	},
);
it("preserves updates and re-defaulting, and captures a switch", async () => {
	expect(
		await taskDefaultsSnapshotMutation(
			"OPENAI_DIRECT",
			{ isDefault: false },
			false,
		),
	).toEqual({});
	expect(
		await taskDefaultsSnapshotMutation(
			"OPENAI_DIRECT",
			{ isDefault: true },
			true,
		),
	).toEqual({});
	expect(mockDb.aiTaskModelDefault.findMany).not.toHaveBeenCalled();
	expect(
		await taskDefaultsSnapshotMutation(
			"OPENAI_DIRECT",
			{ isDefault: false },
			true,
		),
	).toHaveProperty("taskDefaultsSnapshot");
});
describe.each(["organization", "user"] as const)(
	"NULL materialization on %s connection",
	(source) => {
		// An unconditional update would overwrite old; returning the captured candidate would ignore the winner.
		it("conditionally stores once and keeps the winner on concurrent resolution", async () => {
			const row = {
				id: "example-connection",
				provider: "OPENAI_DIRECT" as const,
				taskDefaultsSnapshot: null,
			};
			const first = await materializeTaskDefaultsSnapshot(row, source);
			rows[0].model = { canonicalName: "example-new" };
			expect(await materializeTaskDefaultsSnapshot(row, source)).toEqual(
				first,
			);
			expect(
				await materializeTaskDefaultsSnapshot(
					{ ...row, taskDefaultsSnapshot: first },
					source,
				),
			).toEqual(first);
			expect(mockDb.aiTaskModelDefault.findMany).toHaveBeenCalledTimes(
				24,
			);
		});
		it("uses a competing switch's snapshot", async () => {
			state.competing = old;
			expect(
				await materializeTaskDefaultsSnapshot(
					{
						id: "example-connection",
						provider: "OPENAI_DIRECT",
						taskDefaultsSnapshot: null,
					},
					source,
				),
			).toEqual(old);
		});
	},
);

it("captures a provider-less fallback independently of an empty provider scope, including NULL providers and ties", async () => {
	rows = [
		{
			id: "z",
			provider: "ANTHROPIC_DIRECT",
			taskType: "REASONING",
			priority: 100,
			model: { canonicalName: "example-z" },
		},
		{
			id: "a",
			provider: null,
			taskType: "REASONING",
			priority: 100,
			model: { canonicalName: "example-a" },
		},
	];
	const captured = await captureTaskDefaultsSnapshot("DATABRICKS");
	expect(captured.scoped).toEqual(snapshotFixture().scoped);
	expect(captured.unscoped).toEqual(
		snapshotFixture({ REASONING: "example-a" }).scoped,
	);
});
it("uses the supplied transaction for both maps", async () => {
	const tx = { aiTaskModelDefault: { findMany: vi.fn(async () => []) } };
	const captured = await captureTaskDefaultsSnapshot(
		"OPENAI_DIRECT",
		tx as unknown as import("../prisma/client").Prisma.TransactionClient,
	);
	expect(captured.scoped).toEqual(snapshotFixture().scoped);
	expect(captured.unscoped).toEqual(captured.scoped);
	expect(tx.aiTaskModelDefault.findMany).toHaveBeenCalledTimes(
		TEXT_TASK_TYPES.length * 2,
	);
	expect(mockDb.aiTaskModelDefault.findMany).not.toHaveBeenCalled();
});
it("drops unknown keys and requires all six keys in both scopes", () => {
	expect(
		readTaskDefaultsSnapshot({
			...old,
			future: true,
			scoped: { ...old.scoped, FUTURE_TASK: { future: true } },
			unscoped: { ...old.unscoped, FUTURE_TASK: "example" },
		}),
	).toEqual(old);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	for (const value of [
		{ ...old, scoped: { CHAT: null } },
		{ ...old, unscoped: {} },
		{ version: 1, capturedAt: old.capturedAt, defaults: old.scoped },
		{ ...old, scoped: { ...old.scoped, CHAT: 3 } },
	]) {
		expect(
			readTaskDefaultsSnapshot(value, "example-connection"),
		).toBeNull();
	}
	expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid"), {
		configId: "example-connection",
	});
	warn.mockRestore();
});

it("keeps frozen names and nulls outside the connection-independent live cache", async () => {
	const live = await getTaskDefaultModel("CHAT", "MEDIUM", "OPENAI_DIRECT");
	const pinned = { canonicalName: "example-pinned", providerMappings: [] };
	mockDb.aiModel.findUnique.mockResolvedValue(pinned);
	const connection = {
		configId: "example-connection",
		provider: "OPENAI_DIRECT",
		taskDefaultsSnapshot: snapshotFixture({ CHAT: pinned.canonicalName }),
	};
	expect(
		await getTaskDefaultModel(
			"CHAT",
			"MEDIUM",
			"OPENAI_DIRECT",
			connection,
		),
	).toEqual(pinned);
	expect(
		await getTaskDefaultModel("CHAT", "MEDIUM", "OPENAI_DIRECT", {
			...connection,
			taskDefaultsSnapshot: snapshotFixture(),
		}),
	).toBeNull();
	expect(
		await getTaskDefaultModel("CHAT", "MEDIUM", "OPENAI_DIRECT"),
	).toEqual(live);
});
