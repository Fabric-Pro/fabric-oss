/**
 * `upsertContextBySourcePath` — the one write behind synced knowledge files
 * (Fizzy #2616), shared by `projects.contexts.upsertSyncedFile` and the
 * `fabric_upsert_project_context` MCP tool.
 *
 * What this pins:
 *  - a new path creates one TEXT row carrying the path, the hash and who
 *    wrote it; identical content is a no-op, even when the caller's
 *    `expectedContentHash` is out of date (an idempotent retry);
 *  - the explicit-overwrite rule: changed content replaces the stored version
 *    ONLY when the caller names the hash it is replacing. No hash, or a hash
 *    that is not the stored one, is a conflict that writes nothing and names
 *    the last writer — so two people pushing different versions of one path
 *    never silently clobber each other;
 *  - a replace that loses a race to a concurrent one (zero rows matched) is a
 *    conflict, not an overwrite, and a concurrent FIRST push of one path is
 *    answered from the winner's row instead of failing;
 *  - a named hash on a path that no longer has a row is a conflict with no
 *    current version, never a silent re-create of a deleted source;
 *  - identical content already in the project under another hashed row is
 *    reported as a duplicate and nothing is created;
 *  - tenant scoping: the organization arm does not narrow by user, the
 *    personal arm does, the two never see each other's rows, and another
 *    project's row at the same path is never touched;
 *  - a move (`movedFromSourcePath`, Fizzy #2636) renames the row in place
 *    only when the old path still holds the version the caller named AND the
 *    content sent is that same version; every other case says why the move
 *    was not applied and falls back to the ordinary rules at the new path,
 *    never touching the old row, and never naming a row outside the scope.
 *
 * The transaction client is an in-memory table that evaluates each `where`
 * by equality, so a scope that is too wide or too narrow shows up as the
 * wrong row being read or written, not just as a different call shape.
 *
 * Run with: pnpm --filter @repo/database test -- __tests__/upsert-context-by-source-path.test.ts
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const table = vi.hoisted(() => {
	const state = { rows: [] as Row[], nextId: 1 };

	function matches(row: Row, where: Record<string, unknown>): boolean {
		return Object.entries(where).every(([key, value]) => {
			if (value !== null && typeof value === "object") {
				throw new Error(
					`fake table: unsupported operator on ${key} — the query must stay an equality filter`,
				);
			}
			return (row[key] ?? null) === value;
		});
	}

	function pick(row: Row | undefined, select?: Record<string, boolean>) {
		if (!row) {
			return null;
		}
		if (!select) {
			return { ...row };
		}
		return Object.fromEntries(
			Object.keys(select).map((key) => [key, row[key] ?? null]),
		);
	}

	function uniqueViolation() {
		return Object.assign(
			new Error(
				"Unique constraint failed on the fields: (`projectId`,`sourcePath`)",
			),
			{ code: "P2002" },
		);
	}

	const projectContext = {
		findFirst: vi.fn(
			async (args: {
				where: Record<string, unknown>;
				select?: Record<string, boolean>;
			}) =>
				pick(
					state.rows.find((row) => matches(row, args.where)),
					args.select,
				),
		),
		findFirstOrThrow: vi.fn(
			async (args: {
				where: Record<string, unknown>;
				select?: Record<string, boolean>;
			}) => {
				const row = state.rows.find((r) => matches(r, args.where));
				if (!row) {
					throw new Error("No ProjectContext found");
				}
				return pick(row, args.select);
			},
		),
		updateMany: vi.fn(
			async (args: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				let count = 0;
				for (const row of state.rows) {
					if (matches(row, args.where)) {
						Object.assign(row, args.data);
						count++;
					}
				}
				return { count };
			},
		),
		create: vi.fn(
			async (args: {
				data: Record<string, unknown>;
				select?: Record<string, boolean>;
			}) => {
				const { data } = args;
				if (
					data.sourcePath != null &&
					state.rows.some(
						(row) =>
							row.projectId === data.projectId &&
							row.sourcePath === data.sourcePath,
					)
				) {
					throw uniqueViolation();
				}
				const row: Row = {
					id: `ctx-new-${state.nextId++}`,
					sourceTitle: null,
					originalFilename: null,
					embeddedAt: null,
					metadataUpdatedAt: null,
					metadataUpdatedByUserId: null,
					updatedAt: new Date("2026-09-22T12:00:00Z"),
					...data,
				};
				state.rows.push(row);
				return pick(row, args.select);
			},
		),
	};

	return { state, projectContext, uniqueViolation };
});

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: (fn: (client: unknown) => Promise<unknown>) =>
			fn({ projectContext: table.projectContext }),
	},
	Prisma: { sql: vi.fn(), join: vi.fn() },
}));

import { upsertContextBySourcePath } from "../prisma/queries/projects/contexts";

const sha = (content: string) =>
	createHash("sha256").update(content, "utf8").digest("hex");

const V1 = "# Architecture\n\nThe API talks to one database.\n";
const V2 = "# Architecture\n\nThe API talks to two databases.\n";
const V3 = "# Architecture\n\nThe API talks to three databases.\n";

const ORG = { userId: "user-1", organizationId: "org-1" } as const;

function upsert(
	overrides: Partial<Parameters<typeof upsertContextBySourcePath>[0]> = {},
) {
	return upsertContextBySourcePath({
		projectId: "proj-1",
		sourcePath: "docs/architecture.md",
		content: V1,
		title: "architecture.md",
		...ORG,
		...overrides,
	});
}

/** A row already synced at a path, as a previous push would have left it. */
function seed(overrides: Row = {}): Row {
	const row: Row = {
		id: `ctx-seed-${table.state.nextId++}`,
		projectId: "proj-1",
		type: "TEXT",
		content: V1,
		sourcePath: "docs/architecture.md",
		contentHash: sha(V1),
		contentUpdatedAt: new Date("2026-09-20T09:00:00Z"),
		contentUpdatedByUserId: "user-1",
		metadata: {
			title: "architecture.md",
			sourcePath: "docs/architecture.md",
		},
		sourceTitle: null,
		originalFilename: null,
		embeddedAt: new Date("2026-09-20T09:01:00Z"),
		metadataUpdatedAt: null,
		metadataUpdatedByUserId: null,
		userId: "user-1",
		organizationId: "org-1",
		updatedAt: new Date("2026-09-20T09:01:00Z"),
		...overrides,
	};
	table.state.rows.push(row);
	return row;
}

beforeEach(() => {
	vi.clearAllMocks();
	table.state.rows = [];
	table.state.nextId = 1;
});

describe("upsertContextBySourcePath — a path seen for the first time", () => {
	it("creates one TEXT row carrying the path, the hash and who wrote it", async () => {
		const result = await upsert();

		expect(result.status).toBe("created");
		expect(table.state.rows).toHaveLength(1);
		const [row] = table.state.rows;
		expect(row).toMatchObject({
			projectId: "proj-1",
			type: "TEXT",
			content: V1,
			sourcePath: "docs/architecture.md",
			contentHash: sha(V1),
			contentUpdatedByUserId: "user-1",
			metadata: {
				title: "architecture.md",
				sourcePath: "docs/architecture.md",
			},
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(row.contentUpdatedAt).toBeInstanceOf(Date);
		// The metadata edit's own stamps are not this path's to set.
		expect(row.metadataUpdatedAt).toBeNull();
		expect(row.metadataUpdatedByUserId).toBeNull();
		if (result.status === "created") {
			expect(result.context).toMatchObject({
				id: row.id,
				sourcePath: "docs/architecture.md",
				contentHash: sha(V1),
			});
			// The body never rides along in the read-back.
			expect(result.context).not.toHaveProperty("content");
		}
	});
});

describe("upsertContextBySourcePath — the same content again", () => {
	it("is unchanged and writes nothing", async () => {
		const existing = seed();

		const result = await upsert();

		expect(result).toMatchObject({
			status: "unchanged",
			context: { id: existing.id, contentHash: sha(V1) },
		});
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
		expect(table.projectContext.create).not.toHaveBeenCalled();
		expect(existing.contentUpdatedAt).toEqual(
			new Date("2026-09-20T09:00:00Z"),
		);
	});

	it("is unchanged even when the caller's expected hash is out of date", async () => {
		// A retry whose first attempt landed but whose response was lost
		// re-sends the hash it replaced. It must hear "done", not "conflict".
		seed({ content: V2, contentHash: sha(V2) });

		const result = await upsert({
			content: V2,
			expectedContentHash: sha(V1),
		});

		expect(result.status).toBe("unchanged");
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
	});

	it("is the same row for every member of the organization", async () => {
		// The organization arm does not narrow by user: a teammate's push of
		// the file someone else synced finds that row, not a second one.
		const existing = seed({ userId: "user-1" });

		const result = await upsert({ userId: "user-2" });

		expect(result).toMatchObject({
			status: "unchanged",
			context: { id: existing.id },
		});
		expect(table.projectContext.findFirst.mock.calls[0][0].where).toEqual({
			projectId: "proj-1",
			sourcePath: "docs/architecture.md",
			organizationId: "org-1",
		});
	});
});

describe("upsertContextBySourcePath — explicit overwrite", () => {
	it("refuses changed content without an expected hash, and writes nothing", async () => {
		const existing = seed();

		const result = await upsert({ content: V2 });

		expect(result).toEqual({
			status: "conflict",
			current: {
				contextId: existing.id,
				contentHash: sha(V1),
				contentUpdatedAt: new Date("2026-09-20T09:00:00Z"),
				contentUpdatedByUserId: "user-1",
			},
		});
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
		expect(existing.content).toBe(V1);
	});

	it("refuses a second developer's version and names the first developer and the stored hash", async () => {
		// Developer 1 syncs the file.
		const first = await upsert({ content: V1, userId: "user-1" });
		expect(first.status).toBe("created");

		// Developer 2 edited the version they had checked out, which was not
		// the one developer 1 pushed, and pushes theirs.
		const second = await upsert({
			content: V2,
			userId: "user-2",
			expectedContentHash: sha("an older local copy\n"),
		});

		expect(second.status).toBe("conflict");
		if (second.status === "conflict") {
			expect(second.current?.contentHash).toBe(sha(V1));
			expect(second.current?.contentUpdatedByUserId).toBe("user-1");
		}
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
		expect(table.state.rows).toHaveLength(1);
		expect(table.state.rows[0].content).toBe(V1);
	});

	it("replaces the content when the expected hash is the stored one", async () => {
		const existing = seed({
			metadata: {
				title: "Old title",
				sourcePath: "docs/architecture.md",
				importedBy: "cli",
			},
			sourceType: "Knowledge Base",
		});

		const result = await upsert({
			content: V2,
			title: "Architecture",
			userId: "user-2",
			expectedContentHash: sha(V1),
		});

		expect(result.status).toBe("updated");
		if (result.status === "updated") {
			expect(result.previousHash).toBe(sha(V1));
			expect(result.context).toMatchObject({
				id: existing.id,
				contentHash: sha(V2),
				contentUpdatedByUserId: "user-2",
			});
		}
		expect(existing).toMatchObject({
			content: V2,
			contentHash: sha(V2),
			contentUpdatedByUserId: "user-2",
			// Cleared so the row reads as not-yet-indexed until the re-embed.
			embeddedAt: null,
			// Other metadata keys survive; title and path are refreshed.
			metadata: {
				title: "Architecture",
				sourcePath: "docs/architecture.md",
				importedBy: "cli",
			},
			// Untouched by a content write.
			sourceType: "Knowledge Base",
			metadataUpdatedAt: null,
			metadataUpdatedByUserId: null,
		});
		expect(existing.contentUpdatedAt).not.toEqual(
			new Date("2026-09-20T09:00:00Z"),
		);
	});

	it("keys the write on the stored hash and the full scope", async () => {
		const existing = seed();

		await upsert({ content: V2, expectedContentHash: sha(V1) });

		expect(table.projectContext.updateMany.mock.calls[0][0].where).toEqual({
			id: existing.id,
			projectId: "proj-1",
			organizationId: "org-1",
			contentHash: sha(V1),
		});
	});

	it("is a conflict, not an overwrite, when the stored hash moved between the read and the write", async () => {
		const existing = seed();
		// A concurrent replace lands after this call read the row and before
		// its conditional write.
		table.projectContext.findFirst.mockImplementationOnce(async (args) => {
			const snapshot = { ...existing };
			Object.assign(existing, {
				content: V3,
				contentHash: sha(V3),
				contentUpdatedByUserId: "user-3",
				contentUpdatedAt: new Date("2026-09-22T11:59:00Z"),
			});
			return Object.fromEntries(
				Object.keys(args.select ?? snapshot).map((key) => [
					key,
					snapshot[key] ?? null,
				]),
			);
		});

		const result = await upsert({
			content: V2,
			userId: "user-2",
			expectedContentHash: sha(V1),
		});

		expect(result).toEqual({
			status: "conflict",
			current: {
				contextId: existing.id,
				contentHash: sha(V3),
				contentUpdatedAt: new Date("2026-09-22T11:59:00Z"),
				contentUpdatedByUserId: "user-3",
			},
		});
		expect(existing.content).toBe(V3);
	});
});

describe("upsertContextBySourcePath — a named version whose path is gone", () => {
	it("is a conflict with no current version, and creates nothing, when the caller names a hash and no row is at the path", async () => {
		// The caller last saw V1 here; since then the source was deleted in
		// the app. Recreating it silently would undo that deletion.
		const result = await upsert({
			content: V2,
			expectedContentHash: sha(V1),
		});

		expect(result).toEqual({ status: "conflict", current: null });
		expect(table.projectContext.create).not.toHaveBeenCalled();
		expect(table.state.rows).toHaveLength(0);
	});

	it("is that conflict rather than a duplicate when identical content sits under another path", async () => {
		seed({
			sourcePath: "notes/architecture-copy.md",
			content: V2,
			contentHash: sha(V2),
		});

		const result = await upsert({
			content: V2,
			expectedContentHash: sha(V1),
		});

		expect(result).toEqual({ status: "conflict", current: null });
		expect(table.projectContext.create).not.toHaveBeenCalled();
	});

	it("is that conflict when the row is deleted between the read and the conditional write", async () => {
		const existing = seed();
		table.projectContext.findFirst.mockImplementationOnce(async (args) => {
			const snapshot = { ...existing };
			table.state.rows = [];
			return Object.fromEntries(
				Object.keys(args.select ?? snapshot).map((key) => [
					key,
					snapshot[key] ?? null,
				]),
			);
		});

		const result = await upsert({
			content: V2,
			expectedContentHash: sha(V1),
		});

		expect(result).toEqual({ status: "conflict", current: null });
		expect(table.projectContext.create).not.toHaveBeenCalled();
		expect(table.state.rows).toHaveLength(0);
	});

	it("still creates the path when no hash is named", async () => {
		const result = await upsert({ content: V2 });

		expect(result.status).toBe("created");
	});
});

describe("upsertContextBySourcePath — identical content under another path", () => {
	it("reports the existing row as a duplicate and creates nothing", async () => {
		const other = seed({ sourcePath: "notes/architecture-copy.md" });

		const result = await upsert({ sourcePath: "docs/architecture.md" });

		expect(result).toMatchObject({
			status: "duplicate",
			existing: {
				id: other.id,
				sourcePath: "notes/architecture-copy.md",
			},
		});
		expect(table.projectContext.create).not.toHaveBeenCalled();
		expect(table.state.rows).toHaveLength(1);
		expect(table.projectContext.findFirst.mock.calls[1][0].where).toEqual({
			projectId: "proj-1",
			contentHash: sha(V1),
			organizationId: "org-1",
		});
	});

	it("does not see a row without a hash, so a manual upload is not a duplicate yet", async () => {
		seed({ sourcePath: null, contentHash: null, type: "FILE" });

		const result = await upsert();

		expect(result.status).toBe("created");
	});

	it("does not look outside the project", async () => {
		seed({ projectId: "proj-2", sourcePath: "notes/elsewhere.md" });

		const result = await upsert();

		expect(result.status).toBe("created");
	});
});

describe("upsertContextBySourcePath — concurrent first pushes of one path", () => {
	it("answers from the winner's row when both pushed the same content", async () => {
		// Both requests found no row; the other one's insert landed first.
		table.projectContext.create.mockImplementationOnce(async () => {
			seed({ contentUpdatedByUserId: "user-2", userId: "user-2" });
			throw table.uniqueViolation();
		});

		const result = await upsert();

		expect(result.status).toBe("unchanged");
		expect(table.state.rows).toHaveLength(1);
	});

	it("is a conflict when the winner pushed different content", async () => {
		table.projectContext.create.mockImplementationOnce(async () => {
			seed({
				content: V2,
				contentHash: sha(V2),
				contentUpdatedByUserId: "user-2",
			});
			throw table.uniqueViolation();
		});

		const result = await upsert();

		expect(result).toMatchObject({
			status: "conflict",
			current: { contentHash: sha(V2), contentUpdatedByUserId: "user-2" },
		});
		expect(table.state.rows).toHaveLength(1);
	});

	it("does not swallow an error that is not the path's unique key", async () => {
		table.projectContext.create.mockRejectedValueOnce(
			Object.assign(new Error("connection reset"), { code: "P1001" }),
		);

		await expect(upsert()).rejects.toThrow("connection reset");
	});
});

describe("upsertContextBySourcePath — tenant scoping", () => {
	it("uses the exclusive personal arm, never an OR, without an organization", async () => {
		await upsert({ organizationId: null });

		for (const call of table.projectContext.findFirst.mock.calls) {
			expect(call[0].where).toMatchObject({
				organizationId: null,
				userId: "user-1",
			});
			expect(call[0].where).not.toHaveProperty("OR");
		}
		expect(table.state.rows[0]).toMatchObject({
			organizationId: null,
			userId: "user-1",
		});
	});

	it("never reads or writes an organization row from the personal arm", async () => {
		const orgRow = seed({ content: V1, contentHash: sha(V1) });

		// Same project, same path, different content, and even the right
		// hash: under the personal filter the organization row does not
		// exist, so this can neither update it nor be told about it — the
		// answer is the no-row conflict, naming nothing.
		const result = await upsert({
			organizationId: null,
			content: V2,
			expectedContentHash: sha(V1),
		});

		expect(result).toEqual({ status: "conflict", current: null });
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
		expect(table.projectContext.create).not.toHaveBeenCalled();
		expect(orgRow).toMatchObject({ content: V1, contentHash: sha(V1) });
	});

	it("never reads or writes a personal row from the organization arm", async () => {
		const personalRow = seed({ organizationId: null, userId: "user-1" });

		const result = await upsert({
			content: V2,
			expectedContentHash: sha(V1),
		});

		expect(result).toEqual({ status: "conflict", current: null });
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
		expect(table.projectContext.create).not.toHaveBeenCalled();
		expect(personalRow).toMatchObject({
			content: V1,
			organizationId: null,
		});
	});

	it("does not reach another user's personal row", async () => {
		seed({
			organizationId: null,
			userId: "user-2",
			sourcePath: "notes/copy.md",
		});

		const result = await upsert({ organizationId: null });

		// The other user's identical row is not a duplicate for this caller.
		expect(result.status).toBe("created");
	});

	it("never touches another project's row at the same path", async () => {
		const otherProject = seed({
			projectId: "proj-2",
			content: V1,
			contentHash: sha(V1),
		});

		// The hash names proj-2's row, which this project cannot see: the
		// path is empty here, so it is the no-row conflict, never a write
		// to (or a report of) the other project's row.
		const named = await upsert({
			content: V2,
			expectedContentHash: sha(V1),
		});
		expect(named).toEqual({ status: "conflict", current: null });

		// Without a hash the path is created here, beside it.
		const created = await upsert({ content: V2 });
		expect(created.status).toBe("created");
		expect(otherProject).toMatchObject({
			content: V1,
			contentHash: sha(V1),
		});
		expect(table.state.rows).toHaveLength(2);
	});
});

describe("upsertContextBySourcePath — a move (movedFromSourcePath)", () => {
	const FROM = "notes/arch.md";
	const TO = "docs/architecture.md";

	/** The row a previous push left at the old path. */
	function seedAtOldPath(overrides: Row = {}): Row {
		return seed({
			sourcePath: FROM,
			metadata: { title: "arch.md", sourcePath: FROM, importedBy: "cli" },
			...overrides,
		});
	}

	function move(overrides: Partial<Parameters<typeof upsert>[0]> = {}) {
		return upsert({
			sourcePath: TO,
			title: "architecture.md",
			movedFromSourcePath: FROM,
			expectedContentHash: sha(V1),
			userId: "user-2",
			...overrides,
		});
	}

	it("renames the row in place when the old path holds the named version and the content is that version", async () => {
		const existing = seedAtOldPath();

		const result = await move();

		expect(result.status).toBe("moved");
		if (result.status === "moved") {
			expect(result.movedFromSourcePath).toBe(FROM);
			expect(result.context).toMatchObject({
				id: existing.id,
				sourcePath: TO,
				contentHash: sha(V1),
				contentUpdatedByUserId: "user-2",
			});
		}
		expect(table.state.rows).toHaveLength(1);
		expect(table.projectContext.create).not.toHaveBeenCalled();
		expect(existing).toMatchObject({
			sourcePath: TO,
			// The content is untouched: a move is a rename, never a replace.
			content: V1,
			contentHash: sha(V1),
			contentUpdatedByUserId: "user-2",
			// Cleared so the row reads as not yet indexed until the re-embed
			// refreshes the path the index carries.
			embeddedAt: null,
			// The title followed the file name; other keys survive.
			metadata: {
				title: "architecture.md",
				sourcePath: TO,
				importedBy: "cli",
			},
		});
		expect(existing.contentUpdatedAt).not.toEqual(
			new Date("2026-09-20T09:00:00Z"),
		);
	});

	it("keeps a title somebody chose instead of the old file name", async () => {
		const existing = seedAtOldPath({
			metadata: { title: "Architecture overview", sourcePath: FROM },
		});

		await move();

		expect(existing.metadata).toEqual({
			title: "Architecture overview",
			sourcePath: TO,
		});
	});

	it("keys the rename on the row, the project, the tenant, the old path and the stored hash", async () => {
		const existing = seedAtOldPath();

		await move();

		expect(table.projectContext.updateMany.mock.calls[0][0].where).toEqual({
			id: existing.id,
			projectId: "proj-1",
			organizationId: "org-1",
			sourcePath: FROM,
			contentHash: sha(V1),
		});
	});

	it("is a conflict naming the old path's version, and writes nothing, when it changed since the caller saw it", async () => {
		const existing = seedAtOldPath({
			content: V2,
			contentHash: sha(V2),
			contentUpdatedByUserId: "user-3",
		});

		const result = await move({ content: V1 });

		expect(result).toEqual({
			status: "conflict",
			current: {
				contextId: existing.id,
				contentHash: sha(V2),
				contentUpdatedAt: new Date("2026-09-20T09:00:00Z"),
				contentUpdatedByUserId: "user-3",
			},
			moveNotApplied: {
				movedFromSourcePath: FROM,
				reason: "source-changed",
			},
		});
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
		expect(table.projectContext.create).not.toHaveBeenCalled();
		expect(existing.sourcePath).toBe(FROM);
	});

	it("creates the new path, and says the old one is gone, when no row is at the old path", async () => {
		const result = await move();

		expect(result).toMatchObject({
			status: "created",
			context: { sourcePath: TO, contentHash: sha(V1) },
			moveNotApplied: {
				movedFromSourcePath: FROM,
				reason: "source-missing",
			},
		});
		expect(table.state.rows).toHaveLength(1);
	});

	it("answers duplicate at the new path when the old path is gone and the content lives elsewhere", async () => {
		const other = seed({ sourcePath: "elsewhere/copy.md" });

		const result = await move();

		expect(result).toMatchObject({
			status: "duplicate",
			existing: { id: other.id },
			moveNotApplied: {
				movedFromSourcePath: FROM,
				reason: "source-missing",
			},
		});
		expect(table.projectContext.create).not.toHaveBeenCalled();
	});

	it("ignores the move and confirms the new path when it already holds this content, leaving the old row alone", async () => {
		const old = seedAtOldPath();
		const target = seed({ sourcePath: TO, metadata: { title: "x" } });

		const result = await move();

		expect(result).toMatchObject({
			status: "unchanged",
			context: { id: target.id },
			moveNotApplied: {
				movedFromSourcePath: FROM,
				reason: "target-exists",
			},
		});
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
		expect(old).toMatchObject({ sourcePath: FROM, content: V1 });
	});

	it("is the new path's own conflict when it holds other content: the hash named the old path, never the new one", async () => {
		const old = seedAtOldPath();
		const target = seed({
			sourcePath: TO,
			content: V2,
			contentHash: sha(V2),
		});

		const result = await move();

		expect(result).toMatchObject({
			status: "conflict",
			current: { contextId: target.id, contentHash: sha(V2) },
			moveNotApplied: {
				movedFromSourcePath: FROM,
				reason: "target-exists",
			},
		});
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
		expect(target.content).toBe(V2);
		expect(old.sourcePath).toBe(FROM);
	});

	it("does not replace the new path's row even when it happens to hold the named version", async () => {
		// The hash names what the caller last saw at the OLD path. The new
		// path holds that same text under its own row; sending V2 there must
		// not read as "replace V1 at the new path".
		seed({ sourcePath: TO });

		const result = await move({ content: V2 });

		expect(result.status).toBe("conflict");
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
	});

	it("says the old row is gone rather than kept when the new path exists and the old one does not", async () => {
		seed({ sourcePath: TO });

		const result = await move();

		expect(result).toMatchObject({
			status: "unchanged",
			moveNotApplied: {
				movedFromSourcePath: FROM,
				reason: "source-missing",
			},
		});
	});

	it("does not rename and replace in one call: different content is created at the new path and the old row is left", async () => {
		const old = seedAtOldPath();

		const result = await move({ content: V2 });

		expect(result).toMatchObject({
			status: "created",
			context: { sourcePath: TO, contentHash: sha(V2) },
			moveNotApplied: {
				movedFromSourcePath: FROM,
				reason: "content-differs",
			},
		});
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
		expect(old).toMatchObject({ sourcePath: FROM, content: V1 });
		expect(table.state.rows).toHaveLength(2);
	});

	it("answers from the new path when a concurrent push created it before the rename landed", async () => {
		const old = seedAtOldPath();
		table.projectContext.updateMany.mockImplementationOnce(async () => {
			seed({ sourcePath: TO, contentUpdatedByUserId: "user-3" });
			throw table.uniqueViolation();
		});

		const result = await move();

		expect(result).toMatchObject({
			status: "unchanged",
			moveNotApplied: {
				movedFromSourcePath: FROM,
				reason: "target-exists",
			},
		});
		expect(old.sourcePath).toBe(FROM);
	});

	it("is a conflict when the old row changed between the read and the rename", async () => {
		const old = seedAtOldPath();
		table.projectContext.updateMany.mockImplementationOnce(async () => {
			Object.assign(old, {
				content: V3,
				contentHash: sha(V3),
				contentUpdatedByUserId: "user-3",
			});
			return { count: 0 };
		});

		const result = await move();

		expect(result).toMatchObject({
			status: "conflict",
			current: { contextId: old.id, contentHash: sha(V3) },
			moveNotApplied: {
				movedFromSourcePath: FROM,
				reason: "source-changed",
			},
		});
		expect(old.sourcePath).toBe(FROM);
	});

	it("creates the new path when the old row was deleted between the read and the rename", async () => {
		seedAtOldPath();
		table.projectContext.updateMany.mockImplementationOnce(async () => {
			table.state.rows = [];
			return { count: 0 };
		});

		const result = await move();

		expect(result).toMatchObject({
			status: "created",
			context: { sourcePath: TO },
			moveNotApplied: {
				movedFromSourcePath: FROM,
				reason: "source-missing",
			},
		});
	});

	it("never moves or names another project's row at the old path", async () => {
		const other = seedAtOldPath({ projectId: "proj-2" });

		const result = await move();

		expect(result).toMatchObject({
			status: "created",
			moveNotApplied: { reason: "source-missing" },
		});
		expect(other).toMatchObject({ projectId: "proj-2", sourcePath: FROM });
		expect(table.projectContext.updateMany).not.toHaveBeenCalled();
	});

	it("never moves or names a personal row from the organization arm", async () => {
		const personal = seedAtOldPath({ organizationId: null });

		const result = await move();

		expect(result).toMatchObject({
			status: "created",
			moveNotApplied: { reason: "source-missing" },
		});
		expect(personal.sourcePath).toBe(FROM);
		for (const call of table.projectContext.findFirst.mock.calls) {
			expect(call[0].where).toMatchObject({ organizationId: "org-1" });
			expect(call[0].where).not.toHaveProperty("OR");
		}
	});

	it("never moves another organization's row", async () => {
		const foreign = seedAtOldPath({ organizationId: "org-2" });

		const result = await move();

		expect(result.status).toBe("created");
		expect(foreign.sourcePath).toBe(FROM);
	});
});
