/**
 * `projects.documents.list` — the `sourceFile` it attaches so the documents
 * list can offer an imported document's original upload.
 *
 * Only a document imported from an uploaded file gets one. Text pulled from an
 * integration or pasted in also leaves a source context behind, but that
 * context downloads as synthesized Markdown, so offering it as "the original"
 * would hand the user a converted file under the wrong label. Nor does a
 * caller the download would refuse — an invited project guest outside the
 * organization can read this list but not `projects.contexts.createDownloadUrl`.
 */

import { contentIdentity } from "@repo/utils/content-identity";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: vi.fn(),
	listDocuments: vi.fn(),
	listStoredSourceContexts: vi.fn(),
}));

// The zod enums only shape the input schema, which the stub below ignores.
vi.mock("@repo/database/prisma/zod", () => ({
	ProjectDocumentStatusSchema: { optional: () => undefined },
	ProjectDocumentTypeSchema: { optional: () => undefined },
}));

const { canReadContexts, isMember } = vi.hoisted(() => ({
	canReadContexts: vi.fn(),
	isMember: vi.fn(),
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: (...args: unknown[]) => isMember(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		userHasProjectPermission: (...args: unknown[]) =>
			canReadContexts(...args),
	};
});

import {
	hasProjectAccess,
	listDocuments,
	listStoredSourceContexts,
} from "@repo/database";
import { listDocumentsProcedure } from "../list-documents";

type Handler = (args: {
	input: { projectId: string; organizationId?: string | null };
	context: { user: { id: string }; session: { id: string } };
}) => Promise<{
	documents: Array<{
		id: string;
		contentHash: string;
		sourceFile: { contextId: string; filename: string | null } | null;
	}>;
	total: number;
	hasMore: boolean;
}>;

const handler = (listDocumentsProcedure as unknown as { handler: Handler })
	.handler;

const caller = { user: { id: "user-1" }, session: { id: "session-1" } };

function doc(
	id: string,
	source: "IMPORTED" | "GENERATED",
	sourceContextId: string | null,
	row: { content?: string; contentHash?: string | null } = {},
) {
	return {
		id,
		projectId: "proj-1",
		source,
		sourceContextId,
		content: `# ${id}`,
		contentHash: null as string | null,
		...row,
	};
}

function listed(...documents: ReturnType<typeof doc>[]) {
	vi.mocked(listDocuments).mockResolvedValueOnce({
		documents,
		total: documents.length,
		hasMore: false,
	} as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(hasProjectAccess).mockResolvedValue(true as never);
	vi.mocked(listStoredSourceContexts).mockResolvedValue([]);
	isMember.mockResolvedValue({ organization: {}, role: "member" });
	canReadContexts.mockResolvedValue(true);
});

describe("projects.documents.list — sourceFile", () => {
	it("offers the uploaded file of a document imported from it", async () => {
		listed(doc("doc-1", "IMPORTED", "ctx-file"));
		vi.mocked(listStoredSourceContexts).mockResolvedValueOnce([
			{
				id: "ctx-file",
				type: "DOCUMENT",
				originalFilename: "brief.docx",
			},
		]);

		const result = await handler({
			input: { projectId: "proj-1", organizationId: "org-1" },
			context: caller,
		});

		expect(listStoredSourceContexts).toHaveBeenCalledWith("proj-1", [
			"ctx-file",
		]);
		expect(result.documents[0]?.sourceFile).toEqual({
			contextId: "ctx-file",
			filename: "brief.docx",
		});
		expect(result.total).toBe(1);
	});

	it("offers an uploaded OpenAPI file re-typed to API_SPEC", async () => {
		listed(doc("doc-spec", "IMPORTED", "ctx-spec"));
		vi.mocked(listStoredSourceContexts).mockResolvedValueOnce([
			{
				id: "ctx-spec",
				type: "API_SPEC",
				originalFilename: "petstore.json",
			},
		]);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: caller,
		});

		expect(result.documents[0]?.sourceFile).toEqual({
			contextId: "ctx-spec",
			filename: "petstore.json",
		});
	});

	it("offers nothing for a document imported from integration text", async () => {
		listed(doc("doc-gdoc", "IMPORTED", "ctx-gdoc"));
		// An integration import can carry a stored text export, so the query
		// alone does not rule it out — its download class does.
		vi.mocked(listStoredSourceContexts).mockResolvedValueOnce([
			{
				id: "ctx-gdoc",
				type: "INTEGRATION",
				originalFilename: "Roadmap.txt",
			},
		]);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: caller,
		});

		expect(result.documents[0]?.sourceFile).toBeNull();
	});

	it("offers nothing when the source has no stored file or was deleted", async () => {
		listed(
			doc("doc-pasted", "IMPORTED", "ctx-text"),
			doc("doc-orphan", "IMPORTED", null),
		);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: caller,
		});

		expect(listStoredSourceContexts).toHaveBeenCalledWith("proj-1", [
			"ctx-text",
		]);
		expect(result.documents.map((d) => d.sourceFile)).toEqual([null, null]);
	});

	it("never looks up the source of a generated document", async () => {
		listed(doc("doc-gen", "GENERATED", "ctx-linked"));

		const result = await handler({
			input: { projectId: "proj-1" },
			context: caller,
		});

		expect(listStoredSourceContexts).not.toHaveBeenCalled();
		// Nothing to offer, so no permission reads either.
		expect(isMember).not.toHaveBeenCalled();
		expect(canReadContexts).not.toHaveBeenCalled();
		expect(result.documents[0]?.sourceFile).toBeNull();
	});

	it("offers nothing to an invited guest outside the organization", async () => {
		listed(doc("doc-1", "IMPORTED", "ctx-file"));
		isMember.mockResolvedValueOnce(null);

		const result = await handler({
			input: { projectId: "proj-1", organizationId: "org-1" },
			context: caller,
		});

		expect(isMember).toHaveBeenCalledWith("org-1", "user-1");
		expect(listStoredSourceContexts).not.toHaveBeenCalled();
		expect(result.documents[0]?.sourceFile).toBeNull();
	});

	it("offers nothing to a caller without context read access", async () => {
		listed(doc("doc-1", "IMPORTED", "ctx-file"));
		canReadContexts.mockResolvedValueOnce(false);

		const result = await handler({
			input: { projectId: "proj-1", organizationId: "org-1" },
			context: caller,
		});

		expect(canReadContexts).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "proj-1",
			permission: "CONTEXT_READ",
		});
		expect(listStoredSourceContexts).not.toHaveBeenCalled();
		expect(result.documents[0]?.sourceFile).toBeNull();
	});

	it("keeps the filename unknown rather than inventing one", async () => {
		listed(doc("doc-1", "IMPORTED", "ctx-file"));
		vi.mocked(listStoredSourceContexts).mockResolvedValueOnce([
			{ id: "ctx-file", type: "FILE", originalFilename: null },
		]);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: caller,
		});

		expect(result.documents[0]?.sourceFile).toEqual({
			contextId: "ctx-file",
			filename: null,
		});
	});

	it("still lists every document when the original-file lookup fails", async () => {
		listed(
			doc("doc-1", "IMPORTED", "ctx-file"),
			doc("doc-2", "GENERATED", null),
		);
		vi.mocked(listStoredSourceContexts).mockRejectedValueOnce(
			new Error("connection reset"),
		);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: caller,
		});

		expect(result.documents.map((d) => [d.id, d.sourceFile])).toEqual([
			["doc-1", null],
			["doc-2", null],
		]);
	});

	it("refuses a caller without access to the project before reading anything", async () => {
		vi.mocked(hasProjectAccess).mockResolvedValueOnce(false as never);

		await expect(
			handler({ input: { projectId: "proj-1" }, context: caller }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(listDocuments).not.toHaveBeenCalled();
		expect(listStoredSourceContexts).not.toHaveBeenCalled();
	});
});

/**
 * Each document's `contentHash` is its body's identity, as `documents.get`
 * returns it (Fizzy #2946): a client may take it from the list as the base of
 * a save. The column of that name belongs to the embedding pipeline — null on
 * a draft nothing has embedded, else the short hash of the body it last
 * embedded.
 */
describe("projects.documents.list — contentHash", () => {
	it("returns each body's identity, never the embed column", async () => {
		listed(
			doc("doc-draft", "GENERATED", null, {
				content: "",
				contentHash: null,
			}),
			doc("doc-embedded", "GENERATED", null, {
				content: "## Scope\n\nThe current body.",
				contentHash: "0123456789abcdef",
			}),
		);

		const result = await handler({
			input: { projectId: "proj-1" },
			context: caller,
		});

		expect(result.documents.map((d) => [d.id, d.contentHash])).toEqual([
			["doc-draft", contentIdentity("")],
			["doc-embedded", contentIdentity("## Scope\n\nThe current body.")],
		]);
	});
});
