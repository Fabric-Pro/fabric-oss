/**
 * Unit tests for `createDocumentWithContent` — the transactional
 * document + version + source-context write the content-supplied create routes
 * use (KTD10, KTD11).
 *
 * The Prisma client is stubbed at `db.$transaction`, and the callback is invoked
 * with a transaction client whose model delegates are spies. That is what makes
 * the atomicity claim testable at unit level: the assertion is not "a database
 * rolled back" but "every write went through the ONE client the transaction
 * callback was handed, and a rejection from any of them propagates". A helper
 * that quietly wrote a row through the outer `db` — the shape of the bug this
 * replaces — would fail these tests.
 *
 * Covered surfaces:
 *   - Document, version, and source context are all written inside a single
 *     `$transaction` callback, through the transaction client.
 *   - A failed document write leaves no orphaned source row, and a failed
 *     version write leaves no document — the rejection reaches the caller
 *     rather than being logged and swallowed (R32).
 *   - `isActive`, `source`, and `sourceContextId` — the three fields the shared
 *     query helper cannot carry — reach the row.
 *   - `link: false` leaves the document's source-context link unset, so the
 *     context stays listed in the Context tab.
 *   - The version row carries the caller's change description, not the shared
 *     helper's hardcoded "Initial version".
 *   - Content is stored as supplied apart from a null-byte strip, and an empty
 *     body produces no version row.
 *   - The resolved tenant reaches all three rows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		transaction: vi.fn(),
		documentCreate: vi.fn(),
		documentUpdateMany: vi.fn(),
		versionCreate: vi.fn(),
		contextCreate: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: { $transaction: mocks.transaction },
}));

// The word count and the null-byte strip are the shared ones, not fresh copies
// — imported for real so a change to their rules shows up here. The whole
// module passes through rather than a hand-listed subset, so adding an import
// to the helper does not silently break this file.
vi.mock("@repo/database/prisma/queries/projects/documents", async () => {
	const actual = await vi.importActual<
		typeof import("@repo/database/prisma/queries/projects/documents")
	>("@repo/database/prisma/queries/projects/documents");
	return actual;
});

import { createDocumentWithContent } from "../create-document-with-content";

const PROJECT_ID = "project-1";
const USER_ID = "user-1";
const ORG_ID = "org-1";
const DOCUMENT_ID = "doc-1";
const CONTEXT_ID = "ctx-1";

/** The transaction client every write must go through. */
const tx = {
	projectDocument: {
		create: mocks.documentCreate,
		updateMany: mocks.documentUpdateMany,
	},
	documentVersion: { create: mocks.versionCreate },
	projectContext: { create: mocks.contextCreate },
};

function baseInput(overrides: Record<string, unknown> = {}) {
	return {
		projectId: PROJECT_ID,
		type: "PRD" as const,
		title: "Product Requirements Document",
		content: "The pasted body.",
		isActive: true,
		changeDescription: "Created from pasted source content",
		lastEditedBy: USER_ID,
		userId: USER_ID,
		organizationId: ORG_ID,
		...overrides,
	};
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.transaction.mockImplementation(
		async (fn: (client: typeof tx) => Promise<unknown>) => await fn(tx),
	);
	mocks.documentCreate.mockResolvedValue({ id: DOCUMENT_ID });
	mocks.versionCreate.mockResolvedValue({ id: "ver-1" });
	mocks.contextCreate.mockResolvedValue({ id: CONTEXT_ID });
});

describe("createDocumentWithContent — atomicity", () => {
	it("writes the context, the document, and the version inside one transaction", async () => {
		await createDocumentWithContent(
			baseInput({
				sourceContext: {
					type: "TEXT",
					content: "The pasted body.",
					link: true,
				},
			}),
		);

		expect(mocks.transaction).toHaveBeenCalledTimes(1);
		expect(mocks.contextCreate).toHaveBeenCalledTimes(1);
		expect(mocks.documentCreate).toHaveBeenCalledTimes(1);
		expect(mocks.versionCreate).toHaveBeenCalledTimes(1);

		// The source has to exist before the document can point at it, and the
		// version after the document it belongs to.
		const [contextOrder] = mocks.contextCreate.mock.invocationCallOrder;
		const [documentOrder] = mocks.documentCreate.mock.invocationCallOrder;
		const [versionOrder] = mocks.versionCreate.mock.invocationCallOrder;
		expect(contextOrder).toBeLessThan(documentOrder);
		expect(documentOrder).toBeLessThan(versionOrder);
	});

	it("propagates a failed document write, leaving no orphaned source", async () => {
		// The rejection is the point. The branch this replaces caught, logged,
		// and returned the context anyway — so a caller could be told the
		// creation succeeded while only the source row existed (R32).
		mocks.documentCreate.mockRejectedValue(
			new Error("document insert failed"),
		);

		await expect(
			createDocumentWithContent(
				baseInput({
					sourceContext: {
						type: "TEXT",
						content: "The pasted body.",
						link: true,
					},
				}),
			),
		).rejects.toThrow("document insert failed");

		// The context write is inside the same transaction callback, so the
		// rollback is the database's job — what this asserts is that the helper
		// does not defeat it by writing the source outside the transaction, and
		// that it never resolves with a partial result.
		expect(mocks.versionCreate).not.toHaveBeenCalled();
	});

	it("propagates a failed version write rather than returning a version-less document", async () => {
		mocks.versionCreate.mockRejectedValue(
			new Error("version insert failed"),
		);

		await expect(createDocumentWithContent(baseInput())).rejects.toThrow(
			"version insert failed",
		);
	});
});

describe("createDocumentWithContent — the fields the shared helper cannot carry", () => {
	it("creates the document inactive when the caller says a document of the type is already active", async () => {
		await createDocumentWithContent(baseInput({ isActive: false }));

		expect(mocks.documentCreate.mock.calls[0]?.[0].data).toMatchObject({
			isActive: false,
		});
	});

	it("stamps the imported source marker and links the document to its context", async () => {
		await createDocumentWithContent(
			baseInput({
				source: "IMPORTED",
				status: "COMPLETE",
				sourceContext: {
					type: "TEXT",
					content: "The pasted body.",
					link: true,
				},
			}),
		);

		expect(mocks.documentCreate.mock.calls[0]?.[0].data).toMatchObject({
			source: "IMPORTED",
			status: "COMPLETE",
			sourceContextId: CONTEXT_ID,
		});
	});

	it("leaves the source-context link unset when the source is a different text from the document", async () => {
		// Used-as-context: the source stays visible in the Context tab. Copying
		// the used-as-is link here would silently hide material the user asked
		// to retain as project context.
		const result = await createDocumentWithContent(
			baseInput({
				content: "",
				sourceContext: {
					type: "TEXT",
					content: "Reference material.",
					link: false,
				},
			}),
		);

		expect(mocks.documentCreate.mock.calls[0]?.[0].data).toMatchObject({
			sourceContextId: null,
		});
		expect(result.context).toEqual({ id: CONTEXT_ID });
	});

	it("gives the version row the caller's change description", async () => {
		await createDocumentWithContent(
			baseInput({
				changeDescription: "Created from pasted source content",
			}),
		);

		expect(mocks.versionCreate.mock.calls[0]?.[0].data).toMatchObject({
			changeDescription: "Created from pasted source content",
		});
		expect(
			mocks.versionCreate.mock.calls[0]?.[0].data.changeDescription,
		).not.toBe("Initial version");
	});
});

describe("createDocumentWithContent — content handling", () => {
	it("stores the supplied body unchanged apart from a null-byte strip", async () => {
		const body = "# Heading\n\n<script>alert(1)</script>\n\nBody text.";

		await createDocumentWithContent(baseInput({ content: `${body}\0` }));

		// Verbatim: this route promises the user's own words, and the content is
		// markdown rendered through the editor's schema-whitelisted parser
		// rather than injected as live HTML — so markup is inert data here, and
		// stripping it would corrupt legitimate documents that discuss markup.
		expect(mocks.documentCreate.mock.calls[0]?.[0].data.content).toBe(body);
		expect(mocks.versionCreate.mock.calls[0]?.[0].data.content).toBe(body);
	});

	it("writes no version row for an empty body", async () => {
		// The generation route creates the row before the model has written
		// anything; there is no content to keep a history of yet.
		await createDocumentWithContent(baseInput({ content: "" }));

		expect(mocks.documentCreate).toHaveBeenCalledTimes(1);
		expect(mocks.versionCreate).not.toHaveBeenCalled();
	});

	it("counts words from the sanitized body", async () => {
		await createDocumentWithContent(
			baseInput({ content: "one two three four" }),
		);

		expect(mocks.documentCreate.mock.calls[0]?.[0].data.wordCount).toBe(4);
	});

	it("does not write a context row when no source was supplied", async () => {
		const result = await createDocumentWithContent(baseInput());

		expect(mocks.contextCreate).not.toHaveBeenCalled();
		expect(result.context).toBeNull();
	});
});

describe("createDocumentWithContent — tenant isolation", () => {
	it("threads the resolved tenant into all three rows", async () => {
		await createDocumentWithContent(
			baseInput({
				sourceContext: {
					type: "TEXT",
					content: "Reference material.",
					link: false,
				},
			}),
		);

		for (const spy of [
			mocks.contextCreate,
			mocks.documentCreate,
			mocks.versionCreate,
		]) {
			expect(spy.mock.calls[0]?.[0].data).toMatchObject({
				userId: USER_ID,
				organizationId: ORG_ID,
			});
		}
	});

	it("carries a personal-context null organization through unchanged", async () => {
		// Personal tenant context is `organizationId: null`, not "absent" — the
		// XOR filter reads the explicit null.
		await createDocumentWithContent(
			baseInput({
				organizationId: null,
				sourceContext: {
					type: "TEXT",
					content: "Reference material.",
					link: false,
				},
			}),
		);

		expect(
			mocks.contextCreate.mock.calls[0]?.[0].data.organizationId,
		).toBeNull();
		expect(
			mocks.documentCreate.mock.calls[0]?.[0].data.organizationId,
		).toBeNull();
	});
});

/**
 * Standing the previous active documents down.
 *
 * The demotion belongs in this transaction and nowhere else. Only active
 * documents reach retrieval, so any gap between the two writes is a gap in
 * which a concurrent generation sees two canonical documents of one type — or,
 * if the order were reversed and the create failed, none at all.
 */
describe("createDocumentWithContent — taking over as the active document", () => {
	it("stands down every active document of the type, not one row", async () => {
		mocks.documentUpdateMany.mockResolvedValue({ count: 2 });

		const result = await createDocumentWithContent(
			baseInput({ takesOverActive: true }),
		);

		expect(mocks.documentUpdateMany).toHaveBeenCalledWith({
			where: { projectId: PROJECT_ID, type: "PRD", isActive: true },
			data: { isActive: false },
		});
		expect(result.displacedCount).toBe(2);
	});

	/**
	 * The case that made this a predicate rather than an id. A project carrying
	 * duplicates from before the rule existed has more than one active document
	 * of a type; demoting a single named row would leave the others standing and
	 * add a new one, so the count would grow. Found on a deployed environment,
	 * where two General documents were active and each create demoted one.
	 */
	it("resolves a project that already had several active", async () => {
		mocks.documentUpdateMany.mockResolvedValue({ count: 3 });

		const result = await createDocumentWithContent(
			baseInput({ takesOverActive: true }),
		);

		expect(result.displacedCount).toBe(3);
		// One call, scoped by type — not one call per row.
		expect(mocks.documentUpdateMany).toHaveBeenCalledTimes(1);
	});

	it("demotes before the new row is created", async () => {
		mocks.documentUpdateMany.mockResolvedValue({ count: 1 });

		await createDocumentWithContent(baseInput({ takesOverActive: true }));

		expect(
			mocks.documentUpdateMany.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.documentCreate.mock.invocationCallOrder[0]);
	});

	it.each([[undefined], [false]])(
		"demotes nothing when not taking over (%s)",
		async (value) => {
			const result = await createDocumentWithContent(
				baseInput({ takesOverActive: value }),
			);

			expect(mocks.documentUpdateMany).not.toHaveBeenCalled();
			expect(result.displacedCount).toBe(0);
		},
	);
});
