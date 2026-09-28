/**
 * Visual slots on the "Update using context" apply (Fizzy #2589, KTD17, R39).
 *
 * The preview is drafted by `runContextUpdate`, which already splices slots
 * back. The apply is a separate request, possibly minutes later, carrying the
 * confirmed text from the client — so it splices again, against the CURRENT
 * stored body rather than trusting the confirmed text:
 *   - a slot the confirmed text lost returns under the same heading (AE5);
 *   - a slot a person deleted after the preview was drafted stays deleted;
 *   - with no slot on either side the confirmed text is saved byte for byte.
 *
 * Mocks mirror the sibling `update-with-context-phase2.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		hasProjectAccess: vi.fn(),
		getDocumentById: vi.fn(),
		updateDocument: vi.fn(),
		applyDocumentUpdateSideEffects: vi.fn(),
		fetchProjectContextSources: vi.fn(),
		runContextUpdate: vi.fn(),
		loggerInfo: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	DocumentVersionConflictError: class DocumentVersionConflictError extends Error {},
	hasProjectAccess: mocks.hasProjectAccess,
	getDocumentById: mocks.getDocumentById,
	updateDocument: mocks.updateDocument,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfo,
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../../../../lib/document-side-effects", () => ({
	applyDocumentUpdateSideEffects: mocks.applyDocumentUpdateSideEffects,
}));

vi.mock("@repo/temporal", () => ({
	fetchProjectContextSources: mocks.fetchProjectContextSources,
	runContextUpdate: mocks.runContextUpdate,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.updateWithContext = fn;
			return { _handler: fn };
		},
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

await import("../update-with-context");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: "org-1" },
};

const PROJECT_ID = "project-1";
const DOCUMENT_ID = "doc-1";

const SLOT =
	'<visual-slot data-slot-id="slot-a" data-kind="timeline"></visual-slot>';

const WITH_SLOT = `# Proposal\n\n## Implementation Phases\n\nPhase one covers discovery.\n\n${SLOT}\n\nPhase two covers delivery.\n`;
const WITHOUT_SLOT =
	"# Proposal\n\n## Implementation Phases\n\nPhase one covers discovery.\n\nPhase two covers delivery.\n";
/** The confirmed preview: updated prose, the slot absent. */
const CONFIRMED =
	"# Proposal\n\n## Implementation Phases\n\nPhase one covers discovery and design.\n\nPhase two covers delivery.\n";

function makeDocument(content: string) {
	return {
		id: DOCUMENT_ID,
		projectId: PROJECT_ID,
		title: "Proposal",
		content,
		version: 5,
		createdAt: new Date("2026-05-01T00:00:00.000Z"),
	};
}

function apply(confirmedContent: string) {
	return handlers.updateWithContext({
		input: {
			projectId: PROJECT_ID,
			id: DOCUMENT_ID,
			organizationId: "org-1",
			preview: false,
			confirmedContent,
		},
		context: ctx,
	});
}

/** The content the handler handed to `updateDocument`. */
function savedContent(): string {
	const [, payload] = mocks.updateDocument.mock.calls[0] as [
		string,
		{ content: string },
	];
	return payload.content;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.applyDocumentUpdateSideEffects.mockResolvedValue(undefined);
	mocks.updateDocument.mockResolvedValue({
		...makeDocument(CONFIRMED),
		version: 6,
	});
});

describe("updateWithContextProcedure apply — visual slots", () => {
	it("returns a slot the confirmed text lost to its heading (AE5)", async () => {
		mocks.getDocumentById.mockResolvedValue(makeDocument(WITH_SLOT));

		await apply(CONFIRMED);

		expect(savedContent()).toBe(
			`# Proposal\n\n## Implementation Phases\n\nPhase one covers discovery and design.\n\n${SLOT}\n\nPhase two covers delivery.\n`,
		);
	});

	it("does not resurrect a slot the person deleted after the preview was drafted", async () => {
		// The preview was drafted while the slot existed, so the confirmed text
		// carries it. The person has since deleted it and the deletion is stored.
		mocks.getDocumentById.mockResolvedValue(makeDocument(WITHOUT_SLOT));

		await apply(
			`# Proposal\n\n## Implementation Phases\n\nPhase one covers discovery and design.\n\n${SLOT}\n\nPhase two covers delivery.\n`,
		);

		expect(savedContent()).toBe(CONFIRMED);
		expect(savedContent()).not.toContain("<visual-slot");
	});

	it("saves the confirmed text byte for byte when neither body has a slot", async () => {
		mocks.getDocumentById.mockResolvedValue(makeDocument(WITHOUT_SLOT));
		// Whitespace a splice might be tempted to tidy. None of it may move.
		const confirmed = "# Proposal\r\n\r\nNew body.  \n\n\n\n| a | b |\n";

		await apply(confirmed);

		expect(savedContent()).toBe(confirmed);
	});

	it("guards the write with the version the slots were lifted from", async () => {
		mocks.getDocumentById.mockResolvedValue(makeDocument(WITH_SLOT));

		await apply(CONFIRMED);

		const [, payload] = mocks.updateDocument.mock.calls[0] as [
			string,
			{ expectedVersion?: number },
		];
		expect(payload.expectedVersion).toBe(5);
	});

	it("reports a conflict and writes nothing when the document moved during the apply", async () => {
		const { DocumentVersionConflictError } = await import("@repo/database");
		mocks.getDocumentById.mockResolvedValue(makeDocument(WITH_SLOT));
		mocks.updateDocument.mockRejectedValue(
			new DocumentVersionConflictError(),
		);

		await expect(apply(CONFIRMED)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.applyDocumentUpdateSideEffects).not.toHaveBeenCalled();
	});

	it("saves the confirmed text byte for byte when the stored body is empty", async () => {
		mocks.getDocumentById.mockResolvedValue({
			...makeDocument(""),
			content: null,
		});

		await apply(CONFIRMED);

		expect(savedContent()).toBe(CONFIRMED);
	});
});
