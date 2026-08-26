/**
 * Tests for author resolution in `getDocumentVersions`.
 *
 * `DocumentVersion.changedBy` is an FK-less string column (schema.prisma:1818):
 * it holds a `user.id`, the auto-refresh agent's sentinel, or null. Prisma cannot
 * join it, so `getDocumentVersions` resolves it by hand — and this suite pins the
 * three properties that matters for:
 *  - a person, the agent, and a legacy null each resolve correctly;
 *  - a deleted user degrades to a neutral name and NEVER leaks the raw id;
 *  - the lookup is ONE batched query regardless of page size.
 *
 * Run with:
 *   pnpm --filter @repo/database test prisma/queries/projects/documents-version-authors.test.ts
 */

import { AI_REFRESH_AUTHOR_ID } from "@repo/utils/document-version-author";
import { beforeEach, describe, expect, it, vi } from "vitest";

const versionFindManyMock = vi.fn();
const versionCountMock = vi.fn();
const userFindManyMock = vi.fn();

vi.mock("../../client", () => ({
	db: {
		documentVersion: {
			findMany: (...args: unknown[]) => versionFindManyMock(...args),
			count: (...args: unknown[]) => versionCountMock(...args),
		},
		user: {
			findMany: (...args: unknown[]) => userFindManyMock(...args),
		},
	},
	// Referenced at runtime by unrelated exports in the module under test.
	Prisma: { DbNull: Symbol("DbNull") },
}));

const { getDocumentVersions } = await import("./documents");

type VersionRow = {
	id: string;
	version: number;
	content: string;
	changeDescription: string | null;
	changedBy: string | null;
	createdAt: Date;
};

const versionRow = (overrides: Partial<VersionRow> = {}): VersionRow => ({
	id: "ver-1",
	version: 1,
	content: "content",
	changeDescription: null,
	changedBy: "user-1",
	createdAt: new Date("2026-07-01T00:00:00Z"),
	...overrides,
});

/** Stub the page of versions the query returns, plus its total. */
const givenVersions = (rows: VersionRow[]) => {
	versionFindManyMock.mockResolvedValue(rows);
	versionCountMock.mockResolvedValue(rows.length);
};

/** Stub the batched user lookup. Ids with no entry model a deleted account. */
const givenUsers = (users: { id: string; name: string; email: string }[]) => {
	userFindManyMock.mockResolvedValue(users);
};

beforeEach(() => {
	versionFindManyMock.mockReset();
	versionCountMock.mockReset();
	userFindManyMock.mockReset();
	userFindManyMock.mockResolvedValue([]);
});

describe("getDocumentVersions — author resolution", () => {
	it("resolves a real user id to that user's name, flagged HUMAN", async () => {
		givenVersions([versionRow({ changedBy: "user-1" })]);
		givenUsers([
			{ id: "user-1", name: "Ada Lovelace", email: "ada@example.test" },
		]);

		const { versions } = await getDocumentVersions("doc-1");

		expect(versions[0].author).toEqual({
			kind: "HUMAN",
			name: "Ada Lovelace",
		});
	});

	it("resolves the agent sentinel to the refresh agent, flagged AI_AGENT", async () => {
		givenVersions([versionRow({ changedBy: AI_REFRESH_AUTHOR_ID })]);

		const { versions } = await getDocumentVersions("doc-1");

		expect(versions[0].author).toEqual({
			kind: "AI_AGENT",
			name: "Fabric Refresh Agent",
		});
	});

	it("never looks the sentinel up as a user (the agent has no user row)", async () => {
		givenVersions([versionRow({ changedBy: AI_REFRESH_AUTHOR_ID })]);

		await getDocumentVersions("doc-1");

		// No human authors on the page ⇒ the user query is skipped entirely.
		expect(userFindManyMock).not.toHaveBeenCalled();
	});

	it("returns a null author for a legacy row with no changedBy, without crashing", async () => {
		givenVersions([versionRow({ changedBy: null })]);

		const { versions } = await getDocumentVersions("doc-1");

		expect(versions[0].author).toBeNull();
	});

	it("degrades a deleted user to a neutral name and never leaks the raw id", async () => {
		const deletedId = "clxdeleted00000000";
		givenVersions([versionRow({ changedBy: deletedId })]);
		givenUsers([]); // the id matches no row — the account is gone

		const { versions } = await getDocumentVersions("doc-1");

		expect(versions[0].author).toEqual({
			kind: "HUMAN",
			name: "Unknown user",
		});
		expect(JSON.stringify(versions[0].author)).not.toContain(deletedId);
	});

	it("issues ONE batched user query for ten versions by three authors", async () => {
		const humanIds = ["user-1", "user-2", "user-3"];
		givenVersions(
			Array.from({ length: 10 }, (_, i) =>
				versionRow({
					id: `ver-${i}`,
					version: 10 - i,
					// 10 versions cycling across 3 distinct human authors.
					changedBy: humanIds[i % humanIds.length],
				}),
			),
		);
		givenUsers([
			{ id: "user-1", name: "Ada", email: "ada@example.test" },
			{ id: "user-2", name: "Grace", email: "grace@example.test" },
			{ id: "user-3", name: "Alan", email: "alan@example.test" },
		]);

		const { versions } = await getDocumentVersions("doc-1");

		// The guard against an N+1: one query, not ten.
		expect(userFindManyMock).toHaveBeenCalledTimes(1);
		// ...and it asks for each DISTINCT id exactly once.
		const where = userFindManyMock.mock.calls[0][0].where;
		expect([...where.id.in].sort()).toEqual(humanIds);

		expect(versions.map((v) => v.author?.name)).toEqual([
			"Ada",
			"Grace",
			"Alan",
			"Ada",
			"Grace",
			"Alan",
			"Ada",
			"Grace",
			"Alan",
			"Ada",
		]);
	});

	it("resolves a mixed page: human, agent, legacy null, and deleted user", async () => {
		givenVersions([
			versionRow({ id: "v4", version: 4, changedBy: "user-1" }),
			versionRow({
				id: "v3",
				version: 3,
				changedBy: AI_REFRESH_AUTHOR_ID,
			}),
			versionRow({ id: "v2", version: 2, changedBy: null }),
			versionRow({ id: "v1", version: 1, changedBy: "user-gone" }),
		]);
		givenUsers([
			{ id: "user-1", name: "Ada Lovelace", email: "ada@example.test" },
		]);

		const { versions } = await getDocumentVersions("doc-1");

		expect(versions.map((v) => v.author)).toEqual([
			{ kind: "HUMAN", name: "Ada Lovelace" },
			{ kind: "AI_AGENT", name: "Fabric Refresh Agent" },
			null,
			{ kind: "HUMAN", name: "Unknown user" },
		]);
		// The sentinel is excluded from the batch; only the two human ids are.
		expect(userFindManyMock).toHaveBeenCalledTimes(1);
		const where = userFindManyMock.mock.calls[0][0].where;
		expect([...where.id.in].sort()).toEqual(["user-1", "user-gone"]);
	});

	it("skips the user query entirely when no version has an author", async () => {
		givenVersions([
			versionRow({ id: "v2", version: 2, changedBy: null }),
			versionRow({ id: "v1", version: 1, changedBy: null }),
		]);

		await getDocumentVersions("doc-1");

		expect(userFindManyMock).not.toHaveBeenCalled();
	});

	it("preserves the existing version fields, total, and hasMore", async () => {
		givenVersions([versionRow({ changedBy: "user-1" })]);
		versionCountMock.mockResolvedValue(25);
		givenUsers([{ id: "user-1", name: "Ada", email: "ada@example.test" }]);

		const result = await getDocumentVersions("doc-1", 20, 0);

		expect(result.total).toBe(25);
		expect(result.hasMore).toBe(true);
		expect(result.versions[0]).toMatchObject({
			id: "ver-1",
			version: 1,
			content: "content",
			changedBy: "user-1",
		});
	});
});
