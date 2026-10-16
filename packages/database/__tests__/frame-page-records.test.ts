/**
 * What a published page keeps between visits (`FramePageRecord`).
 *
 * The queries run over an in-memory table that answers the `where` shapes they
 * build (see `_helpers/in-memory-rows.ts`), so each case drives the real
 * predicates and checks which rows come back, not the arguments. The row lock,
 * the unique key and the foreign key are a real database's work and are pinned
 * in `frame-page-records.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere, type Row, sortRows } from "./_helpers/in-memory-rows";

const store = vi.hoisted(() => ({
	records: [] as Array<Record<string, unknown>>,
	users: [] as Array<{ id: string; name: string }>,
	frames: [] as Array<{ id: string; organizationId: string }>,
	clock: 0,
	locks: 0,
	transactionOptions: [] as unknown[],
	transactionFailure: null as unknown,
}));

vi.mock("../prisma/client", async () => {
	const { matchesWhere, sortRows } = await import(
		"./_helpers/in-memory-rows"
	);
	const tick = () => new Date(Date.UTC(2026, 9, 15) + ++store.clock * 1000);
	const rows = () => store.records as Row[];
	const fakeDb = {
		framePageRecord: {
			findMany: async ({
				where,
				orderBy,
				take,
			}: {
				where: Row;
				orderBy?: Array<Record<string, "asc" | "desc">>;
				take?: number;
			}) =>
				sortRows(
					rows().filter((r) => matchesWhere(r, where)),
					orderBy,
				).slice(0, take),
			findFirst: async ({ where }: { where: Row }) =>
				rows().find((r) => matchesWhere(r, where)) ?? null,
			create: async ({ data }: { data: Row }) => {
				const at = tick();
				const row = {
					id: `rec-${store.records.length + 1}`,
					ownerUserId: "",
					version: 1,
					...data,
					createdAt: at,
					updatedAt: at,
				};
				store.records.push(row);
				return row;
			},
			update: async ({
				where,
				data,
			}: {
				where: { id: string };
				data: Row & { version: { increment: number } };
			}) => {
				const row = rows().find((r) => r.id === where.id);
				if (!row) {
					throw new Error("not found");
				}
				const { version, ...rest } = data;
				Object.assign(row, rest, {
					version: (row.version as number) + version.increment,
					updatedAt: tick(),
				});
				return row;
			},
			deleteMany: async ({ where }: { where: Row }) => {
				const doomed = rows().filter((r) => matchesWhere(r, where));
				store.records = store.records.filter(
					(r) => !doomed.includes(r),
				);
				return { count: doomed.length };
			},
			aggregate: async ({ where }: { where: Row }) => {
				const matching = rows().filter((r) => matchesWhere(r, where));
				return {
					_count: { _all: matching.length },
					_sum: {
						size: matching.length
							? matching.reduce(
									(sum, r) => sum + (r.size as number),
									0,
								)
							: null,
					},
				};
			},
		},
		agentWorkspaceFile: {
			findFirst: async ({ where }: { where: Row }) =>
				(store.frames as Row[]).find((f) => matchesWhere(f, where)) ??
				null,
		},
		user: {
			findMany: async ({ where }: { where: Row }) =>
				(store.users as Row[]).filter((u) => matchesWhere(u, where)),
		},
		$executeRaw: async () => {
			store.locks += 1;
			return 0;
		},
		$transaction: async (
			fn: (tx: unknown) => Promise<unknown>,
			options?: unknown,
		) => {
			store.transactionOptions.push(options);
			if (store.transactionFailure) {
				throw store.transactionFailure;
			}
			return fn(fakeDb);
		},
	};
	return { db: fakeDb, Prisma: { JsonNull: Symbol("JsonNull") } };
});

import { Prisma } from "../prisma/client";
import {
	deletePageRecords,
	getPageRecord,
	listPageRecords,
	PAGE_RECORD_LIMITS,
	PageRecordBusyError,
	PageRecordInputError,
	PageRecordLimitError,
	PageRecordVersionConflictError,
	setPageRecords,
} from "../prisma/queries/frame-page-records";

const ORG = "org-a";
const OTHER_ORG = "org-b";
const FRAME = "frame-1";
const OWNER = "user-owner";
const ANA = "user-ana";
const BEN = "user-ben";

function write(
	actorUserId: string,
	collection: string,
	records: Array<{
		key: string;
		value?: unknown;
		scope?: "shared" | "mine";
		expectedVersion?: number;
	}>,
	extra: {
		allowReserved?: boolean;
		frameId?: string;
		organizationId?: string;
	} = {},
) {
	return setPageRecords({
		frameId: extra.frameId ?? FRAME,
		organizationId: extra.organizationId ?? ORG,
		actorUserId,
		collection,
		records: records.map((r) => ({
			...r,
			value: ("value" in r ? r.value : { ok: true }) as never,
		})),
		allowReserved: extra.allowReserved,
	});
}

function list(
	viewerUserId: string,
	collection: string,
	extra: Partial<Parameters<typeof listPageRecords>[0]> = {},
) {
	return listPageRecords({
		frameId: FRAME,
		organizationId: ORG,
		viewerUserId,
		collection,
		scope: "shared",
		limit: 50,
		...extra,
	});
}

function remove(
	actorUserId: string,
	collection: string,
	keys: string[],
	isPageOwner = false,
	allowReserved?: boolean,
) {
	return deletePageRecords({
		frameId: FRAME,
		organizationId: ORG,
		actorUserId,
		isPageOwner,
		collection,
		keys,
		allowReserved,
	});
}

function seedRows(count: number, size: number, collection = "bulk") {
	for (let i = 0; i < count; i++) {
		store.records.push({
			id: `seed-${collection}-${i}`,
			frameId: FRAME,
			organizationId: ORG,
			collection,
			key: `k${i}`,
			ownerUserId: "",
			value: {},
			size,
			version: 1,
			createdBy: OWNER,
			updatedBy: OWNER,
			createdAt: new Date(Date.UTC(2026, 0, 1)),
			updatedAt: new Date(Date.UTC(2026, 0, 1)),
		});
	}
}

beforeEach(() => {
	store.records = [];
	store.clock = 0;
	store.locks = 0;
	store.transactionOptions = [];
	store.transactionFailure = null;
	store.users = [
		{ id: OWNER, name: "Olga Owner" },
		{ id: ANA, name: "Ana" },
		{ id: BEN, name: "Ben" },
	];
	store.frames = [{ id: FRAME, organizationId: ORG }];
});

describe("setPageRecords", () => {
	it("creates a shared record stamped with the writer's id and name", async () => {
		const { records } = await write(ANA, "signups", [
			{ key: "slot-1", value: { name: "Ana" } },
		]);

		expect(records).toEqual([
			expect.objectContaining({
				key: "slot-1",
				value: { name: "Ana" },
				version: 1,
				scope: "shared",
				createdBy: { id: ANA, name: "Ana" },
				updatedBy: { id: ANA, name: "Ana" },
			}),
		]);
	});

	it("keeps the creator and moves the editor and version on a second write", async () => {
		await write(ANA, "notes", [{ key: "n1", value: { text: "one" } }]);

		const { records } = await write(BEN, "notes", [
			{ key: "n1", value: { text: "two" } },
		]);

		expect(records[0]).toMatchObject({
			value: { text: "two" },
			version: 2,
			createdBy: { id: ANA, name: "Ana" },
			updatedBy: { id: BEN, name: "Ben" },
		});
		expect(store.records).toHaveLength(1);
	});

	it("names a writer who left the organization 'Former member'", async () => {
		await write(ANA, "notes", [{ key: "n1" }]);
		store.users = store.users.filter((u) => u.id !== ANA);

		const { records } = await list(BEN, "notes");

		expect(records[0]?.createdBy).toEqual({
			id: ANA,
			name: "Former member",
		});
	});

	it("turns an @me key into the writer's id, so each person gets one record", async () => {
		await write(ANA, "votes", [{ key: "@me", value: "yes" }]);
		await write(BEN, "votes", [{ key: "@me", value: "no" }]);
		await write(ANA, "votes", [{ key: "@me", value: "maybe" }]);

		const { records } = await list(OWNER, "votes");

		expect(records.map((r) => [r.key, r.value, r.version])).toEqual([
			[ANA, "maybe", 2],
			[BEN, "no", 1],
		]);
	});

	it("keeps a mine record to its writer, apart from a shared record of the same key", async () => {
		await write(ANA, "prefs", [
			{ key: "theme", value: "dark", scope: "mine" },
			{ key: "theme", value: "page-default" },
		]);

		expect((await list(ANA, "prefs", { scope: "mine" })).records).toEqual([
			expect.objectContaining({
				key: "theme",
				value: "dark",
				scope: "mine",
			}),
		]);
		expect((await list(BEN, "prefs", { scope: "mine" })).records).toEqual(
			[],
		);
		expect((await list(BEN, "prefs")).records).toEqual([
			expect.objectContaining({ value: "page-default", scope: "shared" }),
		]);
	});

	describe("expectedVersion", () => {
		it("refuses a write made against an old version and leaves the record alone", async () => {
			await write(ANA, "doc", [{ key: "d", value: "v1" }]);
			await write(BEN, "doc", [{ key: "d", value: "v2" }]);

			const attempt = write(ANA, "doc", [
				{ key: "d", value: "mine", expectedVersion: 1 },
			]);

			await expect(attempt).rejects.toMatchObject({
				name: "PageRecordVersionConflictError",
				key: "d",
				expectedVersion: 1,
				currentVersion: 2,
			});
			expect((await list(OWNER, "doc")).records[0]?.value).toBe("v2");
		});

		it("accepts a write made against the current version", async () => {
			await write(ANA, "doc", [{ key: "d", value: "v1" }]);

			const { records } = await write(BEN, "doc", [
				{ key: "d", value: "v2", expectedVersion: 1 },
			]);

			expect(records[0]).toMatchObject({ value: "v2", version: 2 });
		});

		it("treats a missing record as version 0: 0 creates, anything else conflicts", async () => {
			await expect(
				write(ANA, "doc", [{ key: "new", expectedVersion: 3 }]),
			).rejects.toBeInstanceOf(PageRecordVersionConflictError);

			const { records } = await write(ANA, "doc", [
				{ key: "new", expectedVersion: 0 },
			]);

			expect(records[0]?.version).toBe(1);
			await expect(
				write(BEN, "doc", [{ key: "new", expectedVersion: 0 }]),
			).rejects.toMatchObject({ currentVersion: 1 });
		});

		it("writes none of a batch when one record conflicts", async () => {
			await write(ANA, "doc", [{ key: "a", value: "a1" }]);

			await expect(
				write(BEN, "doc", [
					{ key: "b", value: "b1" },
					{ key: "a", value: "a2", expectedVersion: 5 },
				]),
			).rejects.toBeInstanceOf(PageRecordVersionConflictError);

			expect(store.records.map((r) => r.key)).toEqual(["a"]);
		});

		it("refuses a version that is not a whole number from 0", async () => {
			await expect(
				write(ANA, "doc", [{ key: "a", expectedVersion: -1 }]),
			).rejects.toMatchObject({ problem: "expected_version" });
			await expect(
				write(ANA, "doc", [{ key: "a", expectedVersion: 1.5 }]),
			).rejects.toMatchObject({ problem: "expected_version" });
		});
	});

	describe("collections", () => {
		it.each(["$files", "$comments", "$anything"])(
			"refuses a page write to %s",
			async (collection) => {
				await expect(
					write(ANA, collection, [{ key: "x" }]),
				).rejects.toMatchObject({ problem: "reserved_collection" });
			},
		);

		it("lets the host write its two reserved collections and no other $ name", async () => {
			const { records } = await write(
				OWNER,
				"$comments",
				[{ key: "c1", value: { text: "hi" } }],
				{ allowReserved: true },
			);

			expect(records).toHaveLength(1);
			await expect(
				write(OWNER, "$secret", [{ key: "x" }], {
					allowReserved: true,
				}),
			).rejects.toMatchObject({ problem: "reserved_collection" });
		});

		it.each(["", "a b", "x/y", "a".repeat(65)])(
			"refuses the collection name %j",
			async (collection) => {
				await expect(
					write(ANA, collection, [{ key: "x" }]),
				).rejects.toMatchObject({ problem: "collection" });
			},
		);
	});

	describe("keys and values", () => {
		it.each(["", "k".repeat(129), "bad\nkey"])(
			"refuses the key %j",
			async (key) => {
				await expect(write(ANA, "c", [{ key }])).rejects.toMatchObject({
					problem: "key",
				});
			},
		);

		it("refuses two records with one key in one write", async () => {
			await expect(
				write(ANA, "c", [{ key: "a" }, { key: "a" }]),
			).rejects.toMatchObject({ problem: "duplicate_key" });
		});

		it("allows one key in both scopes in one write", async () => {
			const { records } = await write(ANA, "c", [
				{ key: "a" },
				{ key: "a", scope: "mine" },
			]);

			expect(records.map((r) => r.scope)).toEqual(["shared", "mine"]);
		});

		it("refuses a value over 16 KB and takes one at the limit", async () => {
			const atLimit = "x".repeat(PAGE_RECORD_LIMITS.maxValueBytes - 2);

			await expect(
				write(ANA, "c", [{ key: "a", value: atLimit }]),
			).resolves.toBeDefined();
			await expect(
				write(ANA, "c", [{ key: "b", value: `${atLimit}xx` }]),
			).rejects.toMatchObject({
				name: "PageRecordLimitError",
				limit: "value_bytes",
			});
		});

		it("counts a value's size in bytes, not characters", async () => {
			const multibyte = "é".repeat(PAGE_RECORD_LIMITS.maxValueBytes / 2);

			await expect(
				write(ANA, "c", [{ key: "a", value: multibyte }]),
			).rejects.toMatchObject({ limit: "value_bytes" });
		});

		it("stores a JSON null as the database's JSON null", async () => {
			await write(ANA, "c", [{ key: "a", value: null }]);

			expect(store.records[0]?.value).toBe(Prisma.JsonNull);
		});

		it("refuses more than 25 records in one write", async () => {
			const batch = Array.from({ length: 26 }, (_, i) => ({
				key: `k${i}`,
			}));

			await expect(write(ANA, "c", batch)).rejects.toMatchObject({
				limit: "batch_size",
			});
		});
	});

	describe("page limits", () => {
		it("refuses a new record when the page holds 2,000", async () => {
			seedRows(PAGE_RECORD_LIMITS.maxRecordsPerPage, 10);

			await expect(
				write(ANA, "c", [{ key: "one-more" }]),
			).rejects.toMatchObject({
				name: "PageRecordLimitError",
				limit: "records",
			});
			expect(store.records).toHaveLength(
				PAGE_RECORD_LIMITS.maxRecordsPerPage,
			);
		});

		it("still lets a full page change a record it already has", async () => {
			seedRows(PAGE_RECORD_LIMITS.maxRecordsPerPage, 10);

			const { records } = await write(ANA, "bulk", [
				{ key: "k0", value: "new" },
			]);

			expect(records[0]?.version).toBe(2);
		});

		it("refuses a write that takes the page past 5 MB, and allows one that shrinks it", async () => {
			const fourMb = 4 * 1024 * 1024;
			seedRows(1, fourMb);
			seedRows(
				1,
				PAGE_RECORD_LIMITS.maxBytesPerPage - fourMb - 100,
				"rest",
			);

			await expect(
				write(ANA, "c", [{ key: "big", value: "y".repeat(200) }]),
			).rejects.toMatchObject({
				name: "PageRecordLimitError",
				limit: "page_bytes",
			});
			await expect(
				write(ANA, "bulk", [{ key: "k0", value: "tiny" }]),
			).resolves.toBeDefined();
		});
	});

	describe("the page and the organization", () => {
		it("writes nothing for a page of another organization", async () => {
			await expect(
				write(ANA, "c", [{ key: "a" }], { organizationId: OTHER_ORG }),
			).rejects.toMatchObject({ problem: "frame_not_found" });
			expect(store.records).toEqual([]);
		});

		it("serialises writers to one page on a lock", async () => {
			await write(ANA, "c", [{ key: "a" }]);

			expect(store.locks).toBe(1);
		});

		it("needs a user", async () => {
			await expect(write("", "c", [{ key: "a" }])).rejects.toMatchObject({
				problem: "user",
			});
		});
	});

	describe("writers queued on a busy page", () => {
		it("waits up to 10 seconds for a connection and for its turn, not Prisma's 2 and 5", async () => {
			await write(ANA, "c", [{ key: "a" }]);

			expect(store.transactionOptions).toEqual([
				{ maxWait: 10_000, timeout: 10_000 },
			]);
		});

		it("answers a transaction that could not start or ran out of time (P2028) with a busy error", async () => {
			store.transactionFailure = Object.assign(
				new Error("Transaction API error"),
				{ code: "P2028" },
			);

			await expect(
				write(ANA, "c", [{ key: "a" }]),
			).rejects.toBeInstanceOf(PageRecordBusyError);
			expect(store.records).toEqual([]);
		});

		it("answers a page deleted while its writer queued as a page that is not there", async () => {
			store.transactionFailure = Object.assign(new Error("Foreign key"), {
				code: "P2003",
			});

			await expect(write(ANA, "c", [{ key: "a" }])).rejects.toMatchObject(
				{
					name: "PageRecordInputError",
					problem: "frame_not_found",
				},
			);
		});

		it("lets any other failure through as it is", async () => {
			const failure = Object.assign(new Error("connection reset"), {
				code: "ECONNRESET",
			});
			store.transactionFailure = failure;

			await expect(write(ANA, "c", [{ key: "a" }])).rejects.toBe(failure);
		});
	});
});

describe("reading", () => {
	it("keeps a page's records out of another organization's reads", async () => {
		await write(ANA, "c", [{ key: "a" }]);

		const other = await listPageRecords({
			frameId: FRAME,
			organizationId: OTHER_ORG,
			viewerUserId: ANA,
			collection: "c",
			scope: "shared",
			limit: 10,
		});
		const one = await getPageRecord({
			frameId: FRAME,
			organizationId: OTHER_ORG,
			viewerUserId: ANA,
			collection: "c",
			key: "a",
			scope: "shared",
		});

		expect(other.records).toEqual([]);
		expect(one).toBeNull();
	});

	it("gets one record by key, @me included", async () => {
		await write(ANA, "votes", [{ key: "@me", value: "yes" }]);

		const mine = await getPageRecord({
			frameId: FRAME,
			organizationId: ORG,
			viewerUserId: ANA,
			collection: "votes",
			key: "@me",
			scope: "shared",
		});
		const bens = await getPageRecord({
			frameId: FRAME,
			organizationId: ORG,
			viewerUserId: BEN,
			collection: "votes",
			key: "@me",
			scope: "shared",
		});

		expect(mine).toMatchObject({ key: ANA, value: "yes" });
		expect(bens).toBeNull();
	});

	it("returns null for a key that is not there", async () => {
		const none = await getPageRecord({
			frameId: FRAME,
			organizationId: ORG,
			viewerUserId: ANA,
			collection: "c",
			key: "nope",
			scope: "shared",
		});

		expect(none).toBeNull();
	});

	describe("paging", () => {
		beforeEach(async () => {
			for (let i = 1; i <= 7; i++) {
				await write(ANA, "log", [{ key: `e${i}`, value: i }]);
			}
		});

		it("walks every record once, oldest first, by cursor", async () => {
			const keys: string[] = [];
			let cursor: string | undefined;
			let pages = 0;
			do {
				const page = await list(BEN, "log", { limit: 3, cursor });
				keys.push(...page.records.map((r) => r.key));
				cursor = page.nextCursor;
				pages += 1;
			} while (cursor && pages < 20);

			expect(keys).toEqual(["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
			expect(pages).toBe(3);
		});

		it("gives no cursor on the last page", async () => {
			const page = await list(BEN, "log", { limit: 7 });

			expect(page.records).toHaveLength(7);
			expect(page.nextCursor).toBeUndefined();
		});

		it("returns only what changed after `since`", async () => {
			const before = (await list(BEN, "log")).records[2]?.updatedAt;
			await write(ANA, "log", [{ key: "e1", value: "edited" }]);

			const { records } = await list(BEN, "log", { since: before });

			expect(records.map((r) => r.key)).toEqual([
				"e1",
				"e4",
				"e5",
				"e6",
				"e7",
			]);
		});

		it("accepts `since` as an ISO string", async () => {
			const { records } = await list(BEN, "log", {
				since: new Date(Date.UTC(2099, 0, 1)).toISOString(),
			});

			expect(records).toEqual([]);
		});

		it("takes the default for a limit of 0 and caps a huge one at 100", async () => {
			const defaulted = await list(BEN, "log", { limit: 0 });
			const single = await list(BEN, "log", { limit: 1 });
			seedRows(150, 1, "wide");
			const capped = await list(BEN, "wide", { limit: 5000 });

			expect(defaulted.records).toHaveLength(7);
			expect(single.records).toHaveLength(1);
			expect(capped.records).toHaveLength(100);
			expect(capped.nextCursor).toBeDefined();
		});

		it("refuses a cursor it did not issue", async () => {
			await expect(
				list(BEN, "log", { cursor: "not-a-cursor" }),
			).rejects.toMatchObject({ problem: "cursor" });
		});
	});
});

describe("deletePageRecords", () => {
	beforeEach(async () => {
		await write(ANA, "c", [{ key: "ana-note" }]);
		await write(BEN, "c", [{ key: "ben-note" }]);
		await write(BEN, "c", [{ key: "secret", scope: "mine" }]);
	});

	it("lets a person delete the shared record they created", async () => {
		expect(await remove(ANA, "c", ["ana-note"])).toEqual({ deleted: 1 });
		expect(store.records.map((r) => r.key)).not.toContain("ana-note");
	});

	it("does not let a person delete another person's shared record", async () => {
		expect(await remove(ANA, "c", ["ben-note"])).toEqual({ deleted: 0 });
		expect(store.records.map((r) => r.key)).toContain("ben-note");
	});

	it("lets the page's owner delete any shared record", async () => {
		expect(
			await remove(OWNER, "c", ["ana-note", "ben-note"], true),
		).toEqual({
			deleted: 2,
		});
	});

	it("keeps another person's private record from everyone, the owner included", async () => {
		expect(await remove(OWNER, "c", ["secret"], true)).toEqual({
			deleted: 0,
		});
		expect(await remove(ANA, "c", ["secret"])).toEqual({ deleted: 0 });
		expect(await remove(BEN, "c", ["secret"])).toEqual({ deleted: 1 });
	});

	it("resolves @me to the person deleting", async () => {
		await write(ANA, "votes", [{ key: "@me" }]);
		await write(BEN, "votes", [{ key: "@me" }]);

		expect(await remove(ANA, "votes", ["@me"])).toEqual({ deleted: 1 });
		expect(
			store.records.filter((r) => r.collection === "votes"),
		).toHaveLength(1);
	});

	it("never deletes through a reserved collection without the host's flag", async () => {
		await write(OWNER, "$comments", [{ key: "c1" }], {
			allowReserved: true,
		});

		await expect(
			remove(OWNER, "$comments", ["c1"], true),
		).rejects.toMatchObject({
			problem: "reserved_collection",
		});
		expect(await remove(OWNER, "$comments", ["c1"], true, true)).toEqual({
			deleted: 1,
		});
	});

	it("does nothing for an empty list, and refuses more than 25 keys", async () => {
		expect(await remove(ANA, "c", [])).toEqual({ deleted: 0 });
		await expect(
			remove(
				ANA,
				"c",
				Array.from({ length: 26 }, (_, i) => `k${i}`),
			),
		).rejects.toBeInstanceOf(PageRecordLimitError);
	});

	it("needs a user: an empty one would match every shared record", async () => {
		await expect(
			remove("", "c", ["ana-note"], true),
		).rejects.toBeInstanceOf(PageRecordInputError);
		expect(store.records.map((r) => r.key)).toContain("ana-note");
	});
});

describe("the in-memory table the cases above rely on", () => {
	it("tells a row that matches from one that does not", () => {
		const row = { a: 1, b: new Date(5), c: "Hello" };

		expect(matchesWhere(row, { a: 1, b: { gt: new Date(4) } })).toBe(true);
		expect(
			matchesWhere(row, { OR: [{ a: 2 }, { c: { contains: "ell" } }] }),
		).toBe(true);
		expect(matchesWhere(row, { a: 2 })).toBe(false);
		expect(() => matchesWhere(row, { a: { startsWith: "x" } })).toThrow(
			/unsupported operator/,
		);
		expect(sortRows([{ n: 1 }, { n: 2 }], [{ n: "desc" }])).toEqual([
			{ n: 2 },
			{ n: 1 },
		]);
	});
});
