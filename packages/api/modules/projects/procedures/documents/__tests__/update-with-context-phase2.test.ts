/**
 * Phase-2 backstop for `updateDocumentWithContextProcedure`.
 *
 * `updateDocument` skips the content write and version bump when the confirmed
 * content is normalized-identical to the current document. This suite locks the
 * backstop that turns that silent no-op into an informative `applied: false`
 * response, and confirms a real version bump still returns `applied: true` with
 * the new version.
 *
 * Mocks `@repo/database`, `@repo/logs`, the side-effects helper, the shared
 * context-update core, and the oRPC procedure base so the handler can be
 * invoked directly (mirrors `stories/__tests__/update-with-context-attachment-guard`).
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
	session: { id: "s-1", activeOrganizationId: null },
};

const PROJECT_ID = "project-1";
const DOCUMENT_ID = "doc-1";

function makeDocument(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: DOCUMENT_ID,
		projectId: PROJECT_ID,
		title: "PRD",
		content: "# Spec\n\nExisting body.",
		version: 5,
		createdAt: new Date("2026-05-01T00:00:00.000Z"),
		...overrides,
	};
}

function phase2Input(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		input: {
			projectId: PROJECT_ID,
			id: DOCUMENT_ID,
			organizationId: null,
			preview: false,
			confirmedContent: "# Spec\n\nExisting body.",
			...overrides,
		},
		context: ctx,
	};
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		if (typeof (m as { mockReset?: unknown }).mockReset === "function") {
			(m as ReturnType<typeof vi.fn>).mockReset();
		}
	}
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.applyDocumentUpdateSideEffects.mockResolvedValue(undefined);
});

describe("updateWithContextProcedure — phase-2 no-op backstop", () => {
	it("returns applied:false + info summary when the version did not bump", async () => {
		mocks.getDocumentById.mockResolvedValue(makeDocument({ version: 5 }));
		// updateDocument no-oped: the same version comes back.
		mocks.updateDocument.mockResolvedValue(makeDocument({ version: 5 }));

		const result = (await handlers.updateWithContext(phase2Input())) as {
			applied: boolean;
			summary: string;
			documentVersion: number;
		};

		expect(result.applied).toBe(false);
		expect(result.summary).toBe(
			"No changes were applied — the confirmed content matches the current document.",
		);
		expect(result.documentVersion).toBe(5);
		expect(mocks.loggerInfo).toHaveBeenCalledTimes(1);
	});

	it("returns applied:true + the new version when the version bumped", async () => {
		mocks.getDocumentById.mockResolvedValue(makeDocument({ version: 5 }));
		mocks.updateDocument.mockResolvedValue(
			makeDocument({ version: 6, content: "# Spec\n\nUpdated body." }),
		);

		const result = (await handlers.updateWithContext(
			phase2Input({ confirmedContent: "# Spec\n\nUpdated body." }),
		)) as {
			applied: boolean;
			summary: string;
			documentVersion: number;
		};

		expect(result.applied).toBe(true);
		expect(result.summary).toBe("Context update applied successfully.");
		expect(result.documentVersion).toBe(6);
		expect(mocks.loggerInfo).not.toHaveBeenCalled();
	});
});
