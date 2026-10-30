/**
 * `updateDocument`'s in-transaction callback (Fizzy #2946): work that must
 * commit or roll back with a guarded write, such as recording a finding as
 * Resolved with the revision that applied it.
 *
 *  - it runs inside the guarded write's transaction, after the row is
 *    written, and gets the saved row (content as sanitized and stored);
 *  - a throw from it rolls the write back and propagates;
 *  - it runs when the body did not change too;
 *  - passed without the whole base, or with a version rewind, it throws
 *    before anything is read;
 *  - a lost race never reaches it.
 */

import { contentIdentity } from "@repo/utils/content-identity";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => ({
	committed: null as Record<string, unknown> | null,
	versions: [] as Record<string, unknown>[],
	transactions: 0,
}));

/**
 * A transaction over one document row: writes land on a copy that replaces
 * the committed row only when the callback returns, so a throw leaves the
 * row and its version history as they were.
 */
function transactionClient(staged: { row: Row; versions: Row[] }) {
	return {
		projectDocument: {
			updateMany: async ({ where, data }: { where: Row; data: Row }) => {
				const matches = Object.entries(where).every(([key, value]) =>
					typeof value === "object" && value !== null
						? true
						: staged.row[key] === value,
				);
				if (!matches) {
					return { count: 0 };
				}
				Object.assign(staged.row, data);
				return { count: 1 };
			},
			findUniqueOrThrow: async () => ({ ...staged.row }),
			findUnique: async () => ({ ...staged.row }),
		},
		documentVersion: {
			findFirst: async () => null,
			create: async ({ data }: { data: Row }) => {
				staged.versions.push(data);
				return data;
			},
		},
	};
}

vi.mock("../prisma/client", () => ({
	db: {
		projectDocument: {
			findUnique: vi.fn(async () =>
				fake.committed ? { ...fake.committed } : null,
			),
			update: vi.fn(),
		},
		documentVersion: { findFirst: vi.fn(), create: vi.fn() },
		$transaction: vi.fn(
			async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
				fake.transactions += 1;
				const staged = {
					row: { ...(fake.committed as Row) },
					versions: [...fake.versions],
				};
				const result = await fn(transactionClient(staged));
				fake.committed = staged.row;
				fake.versions = staged.versions;
				return result;
			},
		),
	},
	Prisma: {},
}));

import {
	DocumentVersionConflictError,
	updateDocument,
} from "../prisma/queries/projects/documents";

const STORED = "# Example proposal\n\n## Scope\n\nWhat the engagement covers.";
const NEXT =
	"# Example proposal\n\n## Scope\n\nWhat the engagement covers, in full.";

function seed(): Row {
	return {
		id: "doc-example",
		projectId: "project-example",
		type: "PROPOSAL",
		status: "COMPLETE",
		content: STORED,
		version: 4,
		lastEditedBy: "user-earlier",
		updatedAt: new Date("2026-10-27T09:00:00Z"),
	};
}

const base = {
	expectedVersion: 4,
	expectedContentHash: contentIdentity(STORED),
};

beforeEach(() => {
	fake.committed = seed();
	fake.versions = [];
	fake.transactions = 0;
});

describe("updateDocument — in-transaction callback", () => {
	it("runs in the guarded write's transaction with the saved, sanitized row", async () => {
		const inTransaction = vi.fn(async () => {});

		const saved = await updateDocument("doc-example", {
			content: `${NEXT}\u0000`,
			userId: "user-saver",
			organizationId: "org-example",
			lastEditedBy: "user-saver",
			...base,
			inTransaction,
		});

		expect(fake.transactions).toBe(1);
		expect(inTransaction).toHaveBeenCalledTimes(1);
		const [tx, row] = inTransaction.mock.calls[0] as unknown as [
			{ projectDocument: unknown },
			Row,
		];
		expect(tx.projectDocument).toBeDefined();
		expect(row).toMatchObject({ content: NEXT, version: 5 });
		expect(saved).toMatchObject({ content: NEXT, version: 5 });
		expect(fake.committed).toMatchObject({ content: NEXT, version: 5 });
		expect(fake.versions).toHaveLength(1);
	});

	it("rolls the write back when it throws, and the error propagates", async () => {
		const failure = new Error("resolved write failed");

		await expect(
			updateDocument("doc-example", {
				content: NEXT,
				userId: "user-saver",
				...base,
				inTransaction: async () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);

		expect(fake.committed).toMatchObject({ content: STORED, version: 4 });
		expect(fake.versions).toHaveLength(0);
	});

	it("runs when the body is unchanged", async () => {
		const inTransaction = vi.fn(async () => {});

		await updateDocument("doc-example", {
			content: STORED,
			userId: "user-saver",
			...base,
			inTransaction,
		});

		expect(inTransaction).toHaveBeenCalledTimes(1);
		expect(fake.committed).toMatchObject({ version: 4 });
	});

	it("is never reached when the base no longer matches", async () => {
		const inTransaction = vi.fn(async () => {});

		await expect(
			updateDocument("doc-example", {
				content: NEXT,
				userId: "user-saver",
				expectedVersion: 3,
				expectedContentHash: base.expectedContentHash,
				inTransaction,
			}),
		).rejects.toBeInstanceOf(DocumentVersionConflictError);

		expect(inTransaction).not.toHaveBeenCalled();
	});

	it.each([
		["without a base", {}],
		["with only a version", { expectedVersion: 4 }],
		[
			"with only a content hash",
			{ expectedContentHash: base.expectedContentHash },
		],
		["with a version rewind", { ...base, skipVersionBump: true }],
	])("throws before anything is read %s", async (_label, extra) => {
		const inTransaction = vi.fn(async () => {});

		await expect(
			updateDocument("doc-example", {
				content: NEXT,
				userId: "user-saver",
				...extra,
				inTransaction,
			}),
		).rejects.toBeInstanceOf(TypeError);

		expect(inTransaction).not.toHaveBeenCalled();
		expect(fake.transactions).toBe(0);
		expect(fake.committed).toMatchObject({ content: STORED, version: 4 });
	});

	it("leaves a guarded write without it exactly as before", async () => {
		const saved = await updateDocument("doc-example", {
			content: NEXT,
			userId: "user-saver",
			...base,
		});

		expect(saved).toMatchObject({ content: NEXT, version: 5 });
	});
});
