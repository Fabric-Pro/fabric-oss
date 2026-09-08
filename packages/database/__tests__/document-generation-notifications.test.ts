/**
 * `emitDocumentGenerationNotification` — the one message a requester whose
 * generation had to queue will ever see (Fizzy #2199).
 *
 * The properties pinned here are the ones a reader cannot check by looking:
 *
 *  - the claim takes exactly once per document, so a retried activity or two
 *    terminal paths racing cannot notify the same person twice;
 *  - the claim is refused when the persisted status is not one the announced
 *    outcome could have produced, so the bell cannot get ahead of the write it
 *    is describing;
 *  - the failure row says nothing about WHY. The run's error is whatever a
 *    model call, an activity or a dependency refusal produced, and the
 *    notifications list API returns snippets and payloads to the client;
 *  - the row carries `projectId`, which is the only thing that lets
 *    `filterByCurrentAccess` drop it once the recipient loses access to the
 *    project;
 *  - the link is context-relative, because the inbox prepends the
 *    notification's own workspace base.
 *
 * The Prisma client is mocked over a tiny in-memory document store rather than
 * with a fixed `{ count }`, so the claim is exercised as the guarded write it
 * is: the same predicate the transaction sends is what decides the count.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/document-generation-notifications.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type StoredDocument = {
	projectId: string;
	organizationId: string | null;
	title: string;
	status: string;
	generationNotificationEmittedAt: Date | null;
};

const {
	documents,
	notifications,
	createManyMock,
	resetNotificationWriter,
	findUniqueMock,
	updateManyMock,
	transaction,
} = vi.hoisted(() => {
	const documents = new Map<string, StoredDocument>();
	/** Every notification row that actually landed, in insert order. */
	const notifications: Record<string, unknown>[] = [];
	const createManyMock = vi.fn();

	/**
	 * `createMany({ skipDuplicates })` over an in-memory stand-in for
	 * `notification_userId_dedupeKey_live_uq` — unique on (userId, dedupeKey)
	 * among rows that are neither read nor archived.
	 *
	 * Modelled rather than stubbed because the collision is the whole point of
	 * the regeneration case: a `create()` here would have thrown P2002 and, in
	 * Postgres, aborted the surrounding transaction along with the claim. What
	 * this asserts is that the conflict is absorbed by the INSERT itself.
	 */
	const defaultCreateMany = async ({
		data,
		skipDuplicates,
	}: {
		data: Record<string, unknown>[];
		skipDuplicates?: boolean;
	}) => {
		let count = 0;
		for (const row of data) {
			const clash = notifications.some(
				(existing) =>
					existing.userId === row.userId &&
					existing.dedupeKey != null &&
					existing.dedupeKey === row.dedupeKey &&
					existing.readAt == null &&
					existing.archivedAt == null,
			);
			if (clash) {
				if (!skipDuplicates) {
					throw Object.assign(
						new Error(
							"Unique constraint failed on the fields: (`userId`,`dedupeKey`)",
						),
						{ code: "P2002" },
					);
				}
				continue;
			}
			notifications.push({ readAt: null, archivedAt: null, ...row });
			count++;
		}
		return { count };
	};

	function resetNotificationWriter(): void {
		notifications.length = 0;
		createManyMock.mockImplementation(defaultCreateMany);
	}

	const findUniqueMock = vi.fn(
		async ({ where }: { where: { id: string } }) =>
			documents.get(where.id) ?? null,
	);

	/**
	 * The claim, evaluated against the store exactly as Postgres would:
	 * both predicates must hold, and the write is what makes the second one
	 * false for everybody afterwards.
	 */
	const updateManyMock = vi.fn(
		async ({
			where,
			data,
		}: {
			where: {
				id: string;
				status: { in: string[] };
				generationNotificationEmittedAt: null;
			};
			data: { generationNotificationEmittedAt: Date };
		}) => {
			const document = documents.get(where.id);
			if (!document) {
				return { count: 0 };
			}
			if (!where.status.in.includes(document.status)) {
				return { count: 0 };
			}
			if (document.generationNotificationEmittedAt !== null) {
				return { count: 0 };
			}
			document.generationNotificationEmittedAt =
				data.generationNotificationEmittedAt;
			return { count: 1 };
		},
	);

	const transaction = vi.fn(
		async (callback: (tx: unknown) => Promise<unknown>) =>
			callback({
				projectDocument: { updateMany: updateManyMock },
				notification: { createMany: createManyMock },
			}),
	);

	return {
		documents,
		notifications,
		createManyMock,
		resetNotificationWriter,
		findUniqueMock,
		updateManyMock,
		transaction,
	};
});

vi.mock("../prisma/client", () => ({
	db: {
		projectDocument: { findUnique: findUniqueMock },
		$transaction: transaction,
	},
	Prisma: {},
	NotificationCategory: { SYSTEM: "SYSTEM" },
	NotificationType: {
		DOCUMENT_GENERATION_COMPLETED: "DOCUMENT_GENERATION_COMPLETED",
		DOCUMENT_GENERATION_FAILED: "DOCUMENT_GENERATION_FAILED",
	},
}));

import { emitDocumentGenerationNotification } from "../prisma/queries/projects/document-generation-notifications";

/** The raw workflow error. It must not reach any field of any row. */
const RAW_ERROR =
	"ActivityFailure: generateDocumentWithAgent timed out after 900s (run_id=abc123)";

function seedDocument(
	id: string,
	overrides: Partial<StoredDocument> = {},
): void {
	documents.set(id, {
		projectId: "proj-1",
		organizationId: "org-1",
		title: "Architecture Overview",
		status: "COMPLETE",
		generationNotificationEmittedAt: null,
		...overrides,
	});
}

/** Every notification row that landed, in order. */
function rows(): Record<string, unknown>[] {
	return notifications;
}

beforeEach(() => {
	vi.clearAllMocks();
	documents.clear();
	resetNotificationWriter();
});

describe("a generation that finished", () => {
	it("writes one SYSTEM row of the completed type, pointing at the project and the document", async () => {
		seedDocument("doc-1");

		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "COMPLETED",
		});

		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			type: "DOCUMENT_GENERATION_COMPLETED",
			// Always-on, the peer of REPORT_COMPLETED: a run the user started
			// themselves finishing is not noise to suppress.
			category: "SYSTEM",
			title: "Architecture Overview is ready",
			// Without `projectId` the read-time access filter has nothing to
			// check, and a member removed from the project keeps receiving bell
			// entries about that project's documents.
			projectId: "proj-1",
			documentId: "doc-1",
		});
		expect(rows()[0].payload).toEqual({
			documentId: "doc-1",
			projectId: "proj-1",
			status: "COMPLETED",
		});
	});

	it("links context-relatively, with no leading slash", async () => {
		seedDocument("doc-1");

		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "COMPLETED",
		});

		// The inbox prepends the notification's OWN workspace base
		// (`resolveNotificationLink`). A leading slash would make this an
		// absolute path and strand an organization's recipient in `/app`.
		const link = rows()[0].link as string;
		expect(link).toBe("projects/proj-1/documents/doc-1");
		expect(link.startsWith("/")).toBe(false);
	});
});

describe("a generation that failed", () => {
	it("writes the failure type with a generic snippet, and no trace of the error", async () => {
		seedDocument("doc-1", { status: "FAILED" });

		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "FAILED",
		});

		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toMatchObject({
			type: "DOCUMENT_GENERATION_FAILED",
			title: "Architecture Overview could not be generated",
			snippet: "Open the document to see what went wrong",
		});

		// The writer is never handed the error at all — this asserts the
		// consequence, which is what a future refactor would break first.
		const serialized = JSON.stringify(rows()[0]);
		expect(serialized).not.toContain(RAW_ERROR);
		expect(serialized).not.toContain("ActivityFailure");
		expect(rows()[0].payload).not.toHaveProperty("error");
		expect(Object.keys(rows()[0].payload as object).sort()).toEqual([
			"documentId",
			"projectId",
			"status",
		]);
	});
});

describe("the claim", () => {
	it("takes once, however many times the writer is called", async () => {
		seedDocument("doc-1");

		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "COMPLETED",
		});
		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "COMPLETED",
		});

		expect(rows()).toHaveLength(1);
		// The second call never opened a transaction: the fast path saw the
		// claim already set.
		expect(transaction).toHaveBeenCalledTimes(1);
	});

	it("still writes only one row when the fast path cannot see the claim", async () => {
		// The race the transaction exists for: two terminal writers read the
		// document before either of them claimed it, so both reach the guarded
		// update and only one may win.
		seedDocument("doc-1");
		// The row as BOTH callers read it: a snapshot taken before either claim
		// landed, which is exactly what a concurrent read returns.
		const unclaimed = { ...(documents.get("doc-1") as StoredDocument) };
		findUniqueMock
			.mockResolvedValueOnce(unclaimed)
			.mockResolvedValueOnce(unclaimed);

		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "COMPLETED",
		});
		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "COMPLETED",
		});

		// Both got past the fast path and into the guarded update; only one of
		// them came out of it with a row.
		expect(transaction).toHaveBeenCalledTimes(2);
		expect(updateManyMock).toHaveBeenCalledTimes(2);
		expect(rows()).toHaveLength(1);
	});

	it("does not take when the document's status contradicts the outcome", async () => {
		// A document that completed cannot be announced as a failure...
		seedDocument("doc-1", { status: "COMPLETE" });
		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "FAILED",
		});

		// ...and one that is still waiting on its dependencies cannot be
		// announced as ready.
		seedDocument("doc-2", { status: "QUEUED" });
		await emitDocumentGenerationNotification({
			documentId: "doc-2",
			userId: "user-1",
			outcome: "COMPLETED",
		});

		expect(rows()).toHaveLength(0);
		// The claim column is untouched, so the run that DID produce that state
		// can still notify.
		expect(
			documents.get("doc-1")?.generationNotificationEmittedAt,
		).toBeNull();
		expect(
			documents.get("doc-2")?.generationNotificationEmittedAt,
		).toBeNull();
	});

	it("lets a run refused before it ever generated report its own failure", async () => {
		// A dependency that will not arrive, or a requester who lost access
		// while they waited, throws while the row still reads QUEUED. That
		// requester is exactly the one owed an explanation.
		seedDocument("doc-1", { status: "QUEUED" });

		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "FAILED",
		});

		expect(rows()).toHaveLength(1);
		expect(rows()[0].type).toBe("DOCUMENT_GENERATION_FAILED");
	});
});

describe("a document generated twice", () => {
	/**
	 * The regression this guards: `dedupeKey` is unique among a user's LIVE
	 * (unread, unarchived) notifications, so a second generation of the same
	 * document, requested before the first notice was opened, collides. Written
	 * as a bare `create()` that collision raised P2002 inside the claim
	 * transaction — and Postgres aborts a transaction on the first failed
	 * statement, so the COMMIT degraded to a ROLLBACK and the run lost BOTH the
	 * notification and the claim it had just written.
	 */
	it("coalesces onto the unread notice instead of losing the claim", async () => {
		seedDocument("doc-1");
		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "COMPLETED",
		});
		expect(rows()).toHaveLength(1);

		// The regeneration: same document, same requester, a fresh run — so a
		// fresh claim, against the same still-unread bell entry.
		seedDocument("doc-1");

		await expect(
			emitDocumentGenerationNotification({
				documentId: "doc-1",
				userId: "user-1",
				outcome: "COMPLETED",
			}),
		).resolves.toBeUndefined();

		// One row still, and the second run's claim STAYS SET: this document is
		// done announcing itself, so a retried activity cannot come back and
		// notify again.
		expect(rows()).toHaveLength(1);
		expect(
			documents.get("doc-1")?.generationNotificationEmittedAt,
		).toBeInstanceOf(Date);
	});

	it("absorbs the collision in the INSERT rather than in a catch", async () => {
		// The distinction that matters: `skipDuplicates` compiles to
		// `ON CONFLICT DO NOTHING`, so nothing ever throws and the surrounding
		// transaction is never poisoned. A `create()` plus a `catch (P2002)`
		// would look equivalent in a mock and be wrong against Postgres.
		seedDocument("doc-1");

		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "COMPLETED",
		});

		expect(createManyMock).toHaveBeenCalledWith(
			expect.objectContaining({ skipDuplicates: true }),
		);
	});

	it("still notifies once the first notice has been read", async () => {
		// The partial index only covers live rows, so a read notification is no
		// longer in the way — the next run gets its own bell entry, which is the
		// behaviour the coalesce must not take away.
		seedDocument("doc-1");
		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "COMPLETED",
		});
		notifications[0].readAt = new Date();

		seedDocument("doc-1");
		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "COMPLETED",
		});

		expect(rows()).toHaveLength(2);
	});
});

describe("a shared dependency releasing several documents", () => {
	it("notifies once per document, not once per wait", async () => {
		// One extraction finishing clears the wait for every document queued
		// behind it. Each is its own run, its own claim and its own row.
		for (const id of ["doc-1", "doc-2", "doc-3"]) {
			seedDocument(id, { title: `Document ${id}` });
		}

		for (const id of ["doc-1", "doc-2", "doc-3"]) {
			await emitDocumentGenerationNotification({
				documentId: id,
				userId: "user-1",
				outcome: "COMPLETED",
			});
		}

		expect(rows()).toHaveLength(3);
		expect(rows().map((row) => row.documentId)).toEqual([
			"doc-1",
			"doc-2",
			"doc-3",
		]);
		// Per (document, recipient) — three documents are three keys, so the
		// live-unread partial unique index coalesces none of them.
		expect(rows().map((row) => row.dedupeKey)).toEqual([
			"document-generation:doc-1:user-1",
			"document-generation:doc-2:user-1",
			"document-generation:doc-3:user-1",
		]);
	});
});

describe("skip paths (no throw, no row)", () => {
	it("skips a document that no longer exists", async () => {
		await expect(
			emitDocumentGenerationNotification({
				documentId: "gone",
				userId: "user-1",
				outcome: "COMPLETED",
			}),
		).resolves.toBeUndefined();
		expect(transaction).not.toHaveBeenCalled();
	});

	it("skips when there is no recipient to tell", async () => {
		seedDocument("doc-1");

		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "",
			outcome: "COMPLETED",
		});

		expect(findUniqueMock).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
	});

	it("rethrows a failed write so the caller's retry gets a clean run", async () => {
		seedDocument("doc-1");
		createManyMock.mockRejectedValueOnce(new Error("db connection lost"));

		await expect(
			emitDocumentGenerationNotification({
				documentId: "doc-1",
				userId: "user-1",
				outcome: "COMPLETED",
			}),
		).rejects.toThrow("db connection lost");
	});
});

describe("the row's tenant", () => {
	it("is copied from the document, not from the caller", async () => {
		// No slug lookup and no ambient session: the inbox re-bases the link
		// from this column, so a wrong one sends the recipient to a workspace
		// the document is not in.
		seedDocument("doc-1", { organizationId: null });

		await emitDocumentGenerationNotification({
			documentId: "doc-1",
			userId: "user-1",
			outcome: "COMPLETED",
		});

		expect(rows()[0].organizationId).toBeNull();
	});
});
