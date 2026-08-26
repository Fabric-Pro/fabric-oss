/**
 * Fizzy #2139 — MIME normalization at the two workspace-document persistence
 * points, `confirmUploadProcedure` and `serverUploadProcedure`.
 *
 * A caller that bypasses the picker (a REST client, or a browser whose OS has
 * no registration for the extension) sends an empty MIME. The row it persists
 * later fails extraction with "no extractor found" and still consumes a
 * workspace document slot, because capacity counts rows regardless of status.
 *
 * These procedures normalize; they do NOT gate. They have always validated size
 * only, and a type that resolves to nothing is still persisted as declared —
 * adding a rejection here would refuse uploads that succeed today.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockCanEditWorkspace,
	mockCreateWorkspaceDocument,
	mockHasDocumentCapacity,
	mockUpdateWorkspaceDocument,
	mockUploadFile,
	mockGetTemporalClient,
} = vi.hoisted(() => ({
	mockCanEditWorkspace: vi.fn(),
	mockCreateWorkspaceDocument: vi.fn(),
	mockHasDocumentCapacity: vi.fn(),
	mockUpdateWorkspaceDocument: vi.fn(),
	mockUploadFile: vi.fn(),
	mockGetTemporalClient: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	canEditWorkspace: (...args: unknown[]) => mockCanEditWorkspace(...args),
	createWorkspaceDocument: (...args: unknown[]) =>
		mockCreateWorkspaceDocument(...args),
	deleteWorkspaceDocument: vi.fn(),
	getDocumentStats: vi.fn(),
	getWorkspaceDocumentById: vi.fn(),
	hasDocumentCapacity: (...args: unknown[]) =>
		mockHasDocumentCapacity(...args),
	hasWorkspaceAccess: vi.fn(),
	listWorkspaceDocuments: vi.fn(),
	retryFailedDocument: vi.fn(),
	updateWorkspaceDocument: (...args: unknown[]) =>
		mockUpdateWorkspaceDocument(...args),
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({
		type: "s3",
		supportsPresignedUrls: true,
	})),
	uploadFile: (...args: unknown[]) => mockUploadFile(...args),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: () => mockGetTemporalClient(),
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		Permissions: { WORKSPACE_UPDATE: "workspace:update" },
		requirePermission: () => vi.fn(),
		resolveOrganizationId: () => null,
		tenantProtectedProcedure: chainable,
	};
});

const context = {
	user: { id: "user_1" },
	session: { activeOrganizationId: null },
};

type PersistedDocument = { mimeType: string };

type ProcedureHandler = (args: {
	input: Record<string, unknown>;
	context: typeof context;
}) => Promise<unknown>;

async function loadHandlers() {
	const mod = await import("../documents");
	const unwrap = (procedure: unknown) =>
		(procedure as { _handler: ProcedureHandler })._handler;
	return {
		confirmUpload: unwrap(mod.confirmUploadProcedure),
		serverUpload: unwrap(mod.serverUploadProcedure),
	};
}

function persistedMime(): string {
	const call = mockCreateWorkspaceDocument.mock.calls.at(-1);
	return (call?.[0] as PersistedDocument).mimeType;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	mockCanEditWorkspace.mockResolvedValue(true);
	mockHasDocumentCapacity.mockResolvedValue(true);
	mockCreateWorkspaceDocument.mockResolvedValue({
		id: "doc_1",
		filename: "design.md",
		originalFilename: "design.md",
		status: "PENDING",
		createdAt: new Date("2026-08-10T00:00:00.000Z"),
	});
	mockUpdateWorkspaceDocument.mockResolvedValue(undefined);
	mockUploadFile.mockResolvedValue({ url: "https://example.com/design.md" });
	mockGetTemporalClient.mockResolvedValue({
		workflow: {
			start: vi.fn().mockResolvedValue({ workflowId: "wf_1" }),
		},
	});
});

describe("confirmUploadProcedure — MIME normalization", () => {
	const baseInput = {
		workspaceId: "ws_1",
		filename: "123-design.md",
		originalFilename: "design.md",
		size: 12,
		s3Bucket: "workspace-documents",
		s3Path: "ws_1/123-design.md",
	};

	it("persists a resolved type when the caller supplies an empty one", async () => {
		const { confirmUpload } = await loadHandlers();
		await confirmUpload({
			input: { ...baseInput, mimeType: "" },
			context,
		});
		expect(persistedMime()).toBe("text/markdown");
	});

	it("resolves the generic placeholder the same way", async () => {
		const { confirmUpload } = await loadHandlers();
		await confirmUpload({
			input: { ...baseInput, mimeType: "application/octet-stream" },
			context,
		});
		expect(persistedMime()).toBe("text/markdown");
	});

	it("leaves a recognised type unchanged", async () => {
		const { confirmUpload } = await loadHandlers();
		await confirmUpload({
			input: {
				...baseInput,
				filename: "123-report.pdf",
				originalFilename: "report.pdf",
				s3Path: "ws_1/123-report.pdf",
				mimeType: "application/pdf",
			},
			context,
		});
		expect(persistedMime()).toBe("application/pdf");
	});

	it("persists an unresolvable type rather than refusing it — this is not a gate", async () => {
		const { confirmUpload } = await loadHandlers();
		await expect(
			confirmUpload({
				input: {
					...baseInput,
					filename: "123-photo.png",
					originalFilename: "photo.png",
					s3Path: "ws_1/123-photo.png",
					mimeType: "image/png",
				},
				context,
			}),
		).resolves.toBeDefined();
		expect(persistedMime()).toBe("image/png");
	});

	it("persists a file with neither a usable type nor an extension", async () => {
		const { confirmUpload } = await loadHandlers();
		await confirmUpload({
			input: {
				...baseInput,
				filename: "123-mystery",
				originalFilename: "mystery",
				s3Path: "ws_1/123-mystery",
				mimeType: "",
			},
			context,
		});
		expect(persistedMime()).toBe("");
		expect(mockCreateWorkspaceDocument).toHaveBeenCalledTimes(1);
	});
});

describe("serverUploadProcedure — MIME normalization", () => {
	const fileData = Buffer.from("# Design").toString("base64");
	const baseInput = {
		workspaceId: "ws_1",
		filename: "design.md",
		size: Buffer.from("# Design").length,
		fileData,
	};

	it("persists a resolved type when the caller supplies an empty one", async () => {
		const { serverUpload } = await loadHandlers();
		await serverUpload({ input: { ...baseInput, mimeType: "" }, context });
		expect(persistedMime()).toBe("text/markdown");
	});

	it("stores the object with the resolved Content-Type", async () => {
		const { serverUpload } = await loadHandlers();
		await serverUpload({ input: { ...baseInput, mimeType: "" }, context });
		expect(mockUploadFile).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Buffer),
			expect.objectContaining({ contentType: "text/markdown" }),
		);
	});

	it("leaves a recognised type unchanged", async () => {
		const { serverUpload } = await loadHandlers();
		await serverUpload({
			input: {
				...baseInput,
				filename: "report.pdf",
				mimeType: "application/pdf",
			},
			context,
		});
		expect(persistedMime()).toBe("application/pdf");
	});

	it("persists an unresolvable type rather than refusing it — this is not a gate", async () => {
		const { serverUpload } = await loadHandlers();
		await expect(
			serverUpload({
				input: {
					...baseInput,
					filename: "photo.png",
					mimeType: "image/png",
				},
				context,
			}),
		).resolves.toBeDefined();
		expect(persistedMime()).toBe("image/png");
	});
});
