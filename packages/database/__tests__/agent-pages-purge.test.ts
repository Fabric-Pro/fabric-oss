/**
 * What a purge leaves of agent pages.
 *
 * `agent_workspace_file` has an `organizationId` and a `projectId` column but
 * no foreign key to either, so deleting an organization or a project does not
 * reach the pages stored there (nor, through them, the records and comments
 * that cascade from a page row). These cases pin what the purge queries do
 * about it:
 *
 *  - the organization purge deletes the organization's pages in the SAME
 *    transaction as the guarded organization delete, and only after it
 *    succeeded, so a restored organization keeps every page;
 *  - the project purge splits a deleted project's pages into the Workspaces
 *    (unlinked, they belong to the organization) and the rest (deleted).
 *
 * The store is a small in-memory fake with transaction rollback. Postgres
 * itself is not exercised.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const store = vi.hoisted(() => ({
	organizations: [] as Row[],
	files: [] as Row[],
	calls: [] as string[],
	failFileDelete: false,
}));

function matchesScalar(actual: unknown, condition: unknown): boolean {
	if (
		condition !== null &&
		typeof condition === "object" &&
		!(condition instanceof Date)
	) {
		const operators = condition as { in?: unknown[]; not?: unknown };
		if (operators.in) {
			return operators.in.includes(actual);
		}
		if ("not" in operators) {
			return (actual ?? null) !== (operators.not ?? null);
		}
		throw new Error(`unsupported operator ${JSON.stringify(condition)}`);
	}
	return (actual ?? null) === (condition ?? null);
}

function matches(row: Row, where: Row): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (key === "metadata") {
			const { path, equals } = condition as {
				path: string[];
				equals: unknown;
			};
			return ((row.metadata ?? {}) as Row)[path[0]] === equals;
		}
		return matchesScalar(row[key], condition);
	});
}

function prismaNotFound() {
	return Object.assign(new Error("An operation failed"), { code: "P2025" });
}

function tables() {
	return {
		organization: {
			delete: async ({ where }: { where: Row }) => {
				store.calls.push("organization.delete");
				const index = store.organizations.findIndex((row) =>
					matches(row, where),
				);
				if (index === -1) {
					throw prismaNotFound();
				}
				const [removed] = store.organizations.splice(index, 1);
				return removed;
			},
		},
		agentWorkspaceFile: {
			findMany: async ({
				where,
				select,
			}: {
				where: Row;
				select?: Record<string, boolean>;
			}) =>
				store.files
					.filter((row) => matches(row, where))
					.map((row) =>
						select
							? Object.fromEntries(
									Object.keys(select).map((key) => [
										key,
										row[key],
									]),
								)
							: row,
					),
			deleteMany: async ({ where }: { where: Row }) => {
				store.calls.push("agentWorkspaceFile.deleteMany");
				if (store.failFileDelete) {
					throw new Error("pages unavailable");
				}
				const doomed = store.files.filter((row) => matches(row, where));
				store.files = store.files.filter(
					(row) => !doomed.includes(row),
				);
				return { count: doomed.length };
			},
			updateMany: async ({ where, data }: { where: Row; data: Row }) => {
				const hit = store.files.filter((row) => matches(row, where));
				for (const row of hit) {
					Object.assign(row, data);
				}
				return { count: hit.length };
			},
		},
	};
}

vi.mock("../prisma/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prisma/client")>();
	return {
		...actual,
		db: {
			...tables(),
			$transaction: async (run: (tx: unknown) => Promise<unknown>) => {
				const before = {
					organizations: [...store.organizations],
					files: [...store.files],
				};
				try {
					return await run(tables());
				} catch (error) {
					store.organizations = before.organizations;
					store.files = before.files;
					throw error;
				}
			},
		},
	};
});

const { permanentDeleteOrganization } = await import(
	"../prisma/queries/organizations/deletion"
);
const {
	deleteFrameOfDeletedProject,
	detachFramesFromProject,
	listFramesOfDeletedProject,
} = await import("../prisma/queries/frames");

const file = (
	id: string,
	organizationId: string | null,
	extra: Row = {},
): Row => ({
	id,
	userId: "owner-1",
	organizationId,
	projectId: null,
	fileType: "FRAME",
	metadata: {},
	...extra,
});

beforeEach(() => {
	store.calls = [];
	store.failFileDelete = false;
	store.organizations = [
		{ id: "org-1", deletedAt: new Date("2026-01-01") },
		{ id: "org-2", deletedAt: new Date("2026-01-01") },
		{ id: "org-live", deletedAt: null },
	];
	store.files = [
		file("a1", "org-1"),
		file("a2", "org-1", { fileType: "DOCUMENT" }),
		file("b1", "org-2"),
		file("p1", null),
		file("live1", "org-live"),
	];
});

describe("permanentDeleteOrganization", () => {
	it("deletes the organization's pages of every file type with it", async () => {
		await permanentDeleteOrganization("org-1");

		expect(store.organizations.map((row) => row.id)).toEqual([
			"org-2",
			"org-live",
		]);
		expect(store.files.map((row) => row.id)).toEqual(["b1", "p1", "live1"]);
	});

	it("never touches another organization's pages, or a personal one", async () => {
		await permanentDeleteOrganization("org-1");

		const survivors = store.files.map((row) => [
			row.id,
			row.organizationId,
		]);
		expect(survivors).toEqual([
			["b1", "org-2"],
			["p1", null],
			["live1", "org-live"],
		]);
	});

	it("deletes nothing for an organization that was restored", async () => {
		await expect(
			permanentDeleteOrganization("org-live"),
		).rejects.toMatchObject({ code: "P2025" });

		expect(store.organizations).toHaveLength(3);
		expect(store.files).toHaveLength(5);
	});

	it("deletes the pages only after the guarded organization delete succeeded", async () => {
		await expect(
			permanentDeleteOrganization("org-live"),
		).rejects.toBeDefined();
		expect(store.calls).toEqual(["organization.delete"]);

		store.calls = [];
		await permanentDeleteOrganization("org-1");
		expect(store.calls).toEqual([
			"organization.delete",
			"agentWorkspaceFile.deleteMany",
		]);
	});

	it("rolls the organization delete back when the pages cannot be deleted", async () => {
		store.failFileDelete = true;

		await expect(permanentDeleteOrganization("org-1")).rejects.toThrow(
			"pages unavailable",
		);

		expect(store.organizations.map((row) => row.id)).toContain("org-1");
		expect(store.files).toHaveLength(5);
	});
});

describe("listFramesOfDeletedProject", () => {
	beforeEach(() => {
		store.files = [
			file("ws", "org-1", {
				projectId: "proj-1",
				metadata: { surface: "workspace" },
			}),
			file("art", "org-1", {
				projectId: "proj-1",
				metadata: { surface: "artifact" },
			}),
			file("old", "org-1", { projectId: "proj-1", metadata: {} }),
			file("slides", "org-1", {
				projectId: "proj-1",
				fileType: "SLIDESHOW",
				metadata: { surface: "artifact" },
			}),
			file("doc", "org-1", { projectId: "proj-1", fileType: "DOCUMENT" }),
			file("other", "org-1", { projectId: "proj-2" }),
		];
	});

	it("splits Workspaces from every other page of the project", async () => {
		const result = await listFramesOfDeletedProject("proj-1");

		expect(result.workspaceFrameIds).toEqual(["ws"]);
		expect(result.artifactFrames.map((frame) => frame.id).sort()).toEqual([
			"art",
			"old",
			"slides",
		]);
	});

	it("returns what the page helper needs to find the files, not the content", async () => {
		const result = await listFramesOfDeletedProject("proj-1");

		const artifact = result.artifactFrames.find(
			(frame) => frame.id === "art",
		);
		expect(artifact).toEqual({
			id: "art",
			userId: "owner-1",
			organizationId: "org-1",
		});
	});
});

describe("detachFramesFromProject", () => {
	it("unlinks the given pages only, and reports none the second time", async () => {
		store.files = [
			file("ws", "org-1", { projectId: "proj-1" }),
			file("keep", "org-1", { projectId: "proj-1" }),
			file("elsewhere", "org-1", { projectId: "proj-2" }),
		];

		const first = await detachFramesFromProject({
			projectId: "proj-1",
			frameIds: ["ws", "elsewhere"],
		});
		const second = await detachFramesFromProject({
			projectId: "proj-1",
			frameIds: ["ws", "elsewhere"],
		});

		expect(first).toBe(1);
		expect(second).toBe(0);
		expect(store.files.map((row) => [row.id, row.projectId])).toEqual([
			["ws", null],
			["keep", "proj-1"],
			["elsewhere", "proj-2"],
		]);
	});
});

describe("deleteFrameOfDeletedProject", () => {
	it("deletes the page of that project, once", async () => {
		store.files = [
			file("art", "org-1", { projectId: "proj-1" }),
			file("moved", "org-1", { projectId: "proj-2" }),
		];

		const first = await deleteFrameOfDeletedProject({
			projectId: "proj-1",
			frameId: "art",
		});
		const second = await deleteFrameOfDeletedProject({
			projectId: "proj-1",
			frameId: "art",
		});
		const moved = await deleteFrameOfDeletedProject({
			projectId: "proj-1",
			frameId: "moved",
		});

		expect([first, second, moved]).toEqual([1, 0, 0]);
		expect(store.files.map((row) => row.id)).toEqual(["moved"]);
	});
});
