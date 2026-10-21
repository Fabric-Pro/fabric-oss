/**
 * A project setup creates its documents QUEUED under its own workflow id
 * (Fizzy #2946): until the setup reaches a document, the stale-generation
 * sweep asks Temporal whether the setup still runs before it fails the row,
 * and the setup starts the document only while it still holds it.
 *
 * Under that id the activity is idempotent: a retry after a lost result finds
 * the documents its earlier attempt created and creates only the missing
 * types, in one transaction, so a setup never generates a second set. Outside
 * a workflow's activity there is no id to record, and the rows are created
 * GENERATING with none, as before.
 *
 * The rows live in a small in-memory table the activity reads and writes by
 * the conditions it sends; a transaction that throws is rolled back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
	id: string;
	projectId: string;
	type: string;
	title: string;
	workflowId: string | null;
	status: string;
	createdAt: Date;
	[key: string]: unknown;
};

const store = vi.hoisted(() => ({
	rows: [] as Array<Record<string, unknown>>,
	/** The activity's workflow; `null` means no activity context at all. */
	workflowId: "existing-setup-project-1-1" as string | null,
	/** Fails the create of this type, once. */
	failCreateOf: undefined as string | undefined,
	transactions: 0,
}));

const pick = (row: Record<string, unknown>) => ({
	id: row.id,
	type: row.type,
	title: row.title,
});

vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => {
			if (store.workflowId === null) {
				throw new Error("Activity context not initialized");
			}
			return {
				info: { workflowExecution: { workflowId: store.workflowId } },
			};
		},
	},
}));

vi.mock("@repo/database", () => {
	const projectDocument = {
		findMany: vi.fn(
			async ({
				where,
				orderBy = [],
			}: {
				where: {
					projectId: string;
					workflowId: string;
					type: { in: string[] };
				};
				orderBy?: Array<Record<string, "asc" | "desc">>;
			}) => {
				const found = store.rows.filter(
					(row) =>
						row.projectId === where.projectId &&
						row.workflowId === where.workflowId &&
						where.type.in.includes(row.type as string),
				);
				const compare = (a: unknown, b: unknown) =>
					a instanceof Date && b instanceof Date
						? a.getTime() - b.getTime()
						: String(a).localeCompare(String(b));
				found.sort((a, b) => {
					for (const order of orderBy) {
						for (const [key, direction] of Object.entries(order)) {
							const diff = compare(a[key], b[key]);
							if (diff !== 0) {
								return direction === "asc" ? diff : -diff;
							}
						}
					}
					return 0;
				});
				return found.map(pick);
			},
		),
		create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
			if (store.failCreateOf === data.type) {
				store.failCreateOf = undefined;
				throw new Error("connection reset");
			}
			const row = {
				id: `doc-${store.rows.length + 1}`,
				createdAt: new Date(),
				...data,
			};
			store.rows.push(row);
			return pick(row);
		}),
	};
	return {
		db: {
			projectDocument,
			$transaction: vi.fn(
				async (
					fn: (tx: {
						projectDocument: typeof projectDocument;
					}) => unknown,
				) => {
					store.transactions++;
					const rows = [...store.rows];
					try {
						return await fn({ projectDocument });
					} catch (error) {
						store.rows = rows;
						throw error;
					}
				},
			),
		},
		resolveModelWithCredentials: vi.fn(),
		tenantWhere: vi.fn(),
	};
});
vi.mock("@repo/ai", () => ({ resolveProviderApiKey: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/rag/lib/project-contexts/auto-embed", () => ({
	embedProjectContext: vi.fn(),
}));
vi.mock("../pm-integration/fetch-pm-hierarchy", () => ({
	fetchPMWorkItemsByType: vi.fn(),
}));
vi.mock("../pm-integration/story-sync", () => ({
	discoverPMToolCapabilities: vi.fn(),
}));

import { createExistingProjectDocumentRecords } from "../existing-project-setup";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const SETUP = "existing-setup-project-1-1";
const input = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
	documentTypes: ["PRD", "ARCHITECTURE", "TECHNICAL_SPEC"],
};

const seed = (row: Partial<Row> & { id: string; type: string }) => {
	store.rows.push({
		projectId: "project-1",
		title: row.type,
		workflowId: SETUP,
		status: "QUEUED",
		createdAt: new Date("2026-10-21T11:59:00.000Z"),
		...row,
	});
};
const ids = (result: { documents: Array<{ id: string }> }) =>
	result.documents.map((doc) => doc.id);
const types = (result: { documents: Array<{ type: string }> }) =>
	result.documents.map((doc) => doc.type);

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	store.rows = [];
	store.workflowId = SETUP;
	store.failCreateOf = undefined;
	store.transactions = 0;
});

describe("createExistingProjectDocumentRecords", () => {
	it("creates the documents QUEUED under the setup's workflow, in one transaction", async () => {
		const result = await createExistingProjectDocumentRecords(input);

		expect(types(result)).toEqual([
			"PRD",
			"ARCHITECTURE",
			"TECHNICAL_SPEC",
		]);
		expect(result.documents[0]).toEqual({
			id: expect.any(String),
			type: "PRD",
			title: expect.any(String),
		});
		expect(store.transactions).toBe(1);
		expect(store.rows).toHaveLength(3);
		for (const row of store.rows) {
			expect(row).toMatchObject({
				projectId: "project-1",
				status: "QUEUED",
				workflowId: SETUP,
				content: "",
				generationProgress: 0,
				// The sweep skips a row without one.
				generationStartedAt: NOW,
				userId: "user-1",
				organizationId: "org-1",
			});
		}
	});

	it("answers a retry after a committed attempt with the same documents and creates nothing", async () => {
		const first = await createExistingProjectDocumentRecords(input);

		const retry = await createExistingProjectDocumentRecords(input);

		expect(ids(retry)).toEqual(ids(first));
		expect(retry).toEqual(first);
		expect(store.rows).toHaveLength(3);
	});

	it("creates only the missing types, and answers in the order asked", async () => {
		seed({ id: "doc-arch", type: "ARCHITECTURE" });

		const result = await createExistingProjectDocumentRecords(input);

		expect(types(result)).toEqual([
			"PRD",
			"ARCHITECTURE",
			"TECHNICAL_SPEC",
		]);
		expect(ids(result)[1]).toBe("doc-arch");
		expect(
			store.rows.filter((row) => row.type === "ARCHITECTURE"),
		).toHaveLength(1);
		expect(store.rows).toHaveLength(3);
	});

	it("takes the oldest of a type, and nothing of another setup or project", async () => {
		seed({
			id: "doc-prd-newer",
			type: "PRD",
			createdAt: new Date("2026-10-21T11:59:30.000Z"),
		});
		seed({
			id: "doc-prd-oldest",
			type: "PRD",
			createdAt: new Date("2026-10-21T11:58:00.000Z"),
		});
		seed({
			id: "doc-arch-other-setup",
			type: "ARCHITECTURE",
			workflowId: "existing-setup-project-1-0",
		});
		seed({
			id: "doc-spec-other-project",
			type: "TECHNICAL_SPEC",
			projectId: "project-2",
		});

		const result = await createExistingProjectDocumentRecords(input);

		expect(ids(result)[0]).toBe("doc-prd-oldest");
		expect(ids(result)[1]).not.toBe("doc-arch-other-setup");
		expect(ids(result)[2]).not.toBe("doc-spec-other-project");
		expect(store.rows).toHaveLength(6);
	});

	it("leaves nothing behind when an attempt fails part-way, so its retry creates one set", async () => {
		store.failCreateOf = "ARCHITECTURE";

		await expect(
			createExistingProjectDocumentRecords(input),
		).rejects.toThrow("connection reset");
		expect(store.rows).toEqual([]);

		const retry = await createExistingProjectDocumentRecords(input);
		expect(types(retry)).toEqual(["PRD", "ARCHITECTURE", "TECHNICAL_SPEC"]);
		expect(store.rows).toHaveLength(3);
	});

	it("creates them GENERATING with no workflow id outside an activity, as before", async () => {
		store.workflowId = null;

		const result = await createExistingProjectDocumentRecords(input);

		expect(types(result)).toEqual([
			"PRD",
			"ARCHITECTURE",
			"TECHNICAL_SPEC",
		]);
		expect(store.transactions).toBe(0);
		expect(store.rows).toHaveLength(3);
		for (const row of store.rows) {
			expect(row).toMatchObject({
				status: "GENERATING",
				generationProgress: 0,
				generationStartedAt: NOW,
			});
			expect(row).not.toHaveProperty("workflowId");
		}
	});
});
