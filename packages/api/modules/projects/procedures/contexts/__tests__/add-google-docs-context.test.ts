/**
 * Unit tests for `addGoogleDocsContextProcedure` — ingest selected Google
 * Docs into the project-context RAG pipeline.
 *
 * Strategy mirrors `list-available-google-docs.test.ts`: mock the
 * `../../../../orpc/procedures` builder so `.use/.route/.input/.output/
 * .handler` collapse to `{ handler }`, declare the Drive error classes via
 * `vi.hoisted`, then call `.handler({ input, context })` directly.
 *
 * Asserts behavior (a context row is created + the processing workflow is
 * started per doc; the per-file try/catch isolates failures and reports
 * `{ created, failed }`), not internals.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockCreateContext,
	mockUpdateContextExtractionStatus,
	mockCountContextsByType,
	mockFindManyContexts,
	mockGetGoogleDriveAccessToken,
	mockExportGoogleDocText,
	mockUploadContextText,
	mockWorkflowStart,
	GoogleDriveNotConnectedError,
	GoogleDriveTokenExpiredError,
} = vi.hoisted(() => {
	class GoogleDriveNotConnectedError extends Error {
		constructor() {
			super("Google account not connected");
			this.name = "GoogleDriveNotConnectedError";
		}
	}
	class GoogleDriveTokenExpiredError extends Error {
		constructor() {
			super("Google session expired");
			this.name = "GoogleDriveTokenExpiredError";
		}
	}
	return {
		mockHasProjectAccess: vi.fn(),
		mockCreateContext: vi.fn(),
		mockUpdateContextExtractionStatus: vi.fn(),
		mockCountContextsByType: vi.fn(),
		mockFindManyContexts: vi.fn(),
		mockGetGoogleDriveAccessToken: vi.fn(),
		mockExportGoogleDocText: vi.fn(),
		mockUploadContextText: vi.fn(),
		mockWorkflowStart: vi.fn(),
		GoogleDriveNotConnectedError,
		GoogleDriveTokenExpiredError,
	};
});

// Partial-mock: spread the real module so transitive importers
// (`@repo/payments` reads `setAiUsageRecorder` from `@repo/database` at load
// time) still resolve, and override only the three helpers we exercise.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		hasProjectAccess: mockHasProjectAccess,
		createContext: mockCreateContext,
		updateContextExtractionStatus: mockUpdateContextExtractionStatus,
		countContextsByType: mockCountContextsByType,
		// Minimal db stub — the handler only touches projectContext.findMany
		// (dedup lookup). Don't spread actual.db: accessing its model accessors
		// would initialize Prisma (no DATABASE_URL in unit tests).
		db: {
			projectContext: {
				findMany: mockFindManyContexts,
			},
		},
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mockWorkflowStart },
	})),
}));

vi.mock("../../../../integrations/lib/google-drive-token", () => ({
	getGoogleDriveAccessToken: mockGetGoogleDriveAccessToken,
	GoogleDriveNotConnectedError,
	GoogleDriveTokenExpiredError,
}));

vi.mock("../../../../integrations/lib/google-drive-rest", () => ({
	exportGoogleDocText: mockExportGoogleDocText,
	GoogleDriveExportAuthError: class extends Error {
		readonly status: number;
		constructor(status = 401) {
			super(`Google Drive export auth error (${status})`);
			this.name = "GoogleDriveExportAuthError";
			this.status = status;
		}
	},
	GoogleDriveExportNotFoundError: class extends Error {
		constructor() {
			super("Google Drive export error 404");
			this.name = "GoogleDriveExportNotFoundError";
		}
	},
	GoogleDriveExportTransientError: class extends Error {
		readonly status: number;
		constructor(status = 500) {
			super(`Google Drive export transient error (${status})`);
			this.name = "GoogleDriveExportTransientError";
			this.status = status;
		}
	},
}));

vi.mock("../../lib/s3-context-upload", () => ({
	uploadContextText: mockUploadContextText,
	deleteUploadedContextText: vi.fn(async () => {}),
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (opts: unknown) => opts,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => {
			if (input) {
				return input;
			}
			if (input === null) {
				return undefined;
			}
			return session?.activeOrganizationId ?? undefined;
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: {
		projectId: string;
		organizationId?: string | null;
		files: Array<{ id: string; title: string; url?: string | null }>;
	};
	context: {
		user: { id: string; name?: string; email?: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<{
	created: number;
	failed: number;
	skipped: number;
	duplicates: number;
	authFailed: number;
}>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../add-google-docs-context");
	return (
		mod.addGoogleDocsContextProcedure as unknown as { handler: Handler }
	).handler;
}

const personalCtx = {
	user: { id: "user-1", name: "Test User", email: "test@example.com" },
	session: { activeOrganizationId: undefined },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockCountContextsByType.mockResolvedValue({});
	mockFindManyContexts.mockResolvedValue([]);
	mockGetGoogleDriveAccessToken.mockResolvedValue("tok-abc");
	mockExportGoogleDocText.mockResolvedValue("doc body");
	mockUploadContextText.mockResolvedValue({
		s3Path: "projects/p1/ctx_x.txt",
		s3Bucket: "project-contexts",
		fileSize: 8,
	});
	mockCreateContext.mockResolvedValue({ id: "ctx-1" });
	mockUpdateContextExtractionStatus.mockResolvedValue(undefined);
	mockWorkflowStart.mockResolvedValue(undefined);
});

describe("addGoogleDocsContext", () => {
	it("creates a context row and starts the processing workflow per doc", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				files: [{ id: "d1", title: "Spec", url: "http://x" }],
			},
			context: personalCtx,
		});

		expect(result).toEqual({
			created: 1,
			failed: 0,
			skipped: 0,
			duplicates: 0,
			authFailed: 0,
		});
		expect(mockExportGoogleDocText).toHaveBeenCalledWith({
			token: "tok-abc",
			fileId: "d1",
		});
		expect(mockCreateContext).toHaveBeenCalledTimes(1);
		expect(mockCreateContext).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p1",
				type: "INTEGRATION",
				mimeType: "text/plain",
				sourceTitle: "Spec",
				s3Path: "projects/p1/ctx_x.txt",
				s3Bucket: "project-contexts",
			}),
		);
		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-1",
			"EXTRACTING",
		);
		expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
		expect(mockWorkflowStart).toHaveBeenCalledWith(
			"projectContextProcessingWorkflow",
			expect.objectContaining({
				taskQueue: "project-documents",
				workflowId: "project-context-processing-ctx-1",
				args: [
					expect.objectContaining({
						contextId: "ctx-1",
						projectId: "p1",
						userId: "user-1",
					}),
				],
			}),
		);
	});

	it("ingests multiple docs and returns the created count", async () => {
		mockCreateContext
			.mockResolvedValueOnce({ id: "ctx-1" })
			.mockResolvedValueOnce({ id: "ctx-2" });

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				files: [
					{ id: "d1", title: "One" },
					{ id: "d2", title: "Two" },
				],
			},
			context: personalCtx,
		});

		expect(result).toEqual({
			created: 2,
			failed: 0,
			skipped: 0,
			duplicates: 0,
			authFailed: 0,
		});
		expect(mockWorkflowStart).toHaveBeenCalledTimes(2);
	});

	it("isolates a per-doc failure and marks the created row FAILED", async () => {
		// First doc succeeds; second doc's export blows up.
		mockExportGoogleDocText
			.mockResolvedValueOnce("body one")
			.mockRejectedValueOnce(new Error("403 inaccessible"));
		mockCreateContext.mockResolvedValueOnce({ id: "ctx-1" });

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				files: [
					{ id: "d1", title: "One" },
					{ id: "d2", title: "Two" },
				],
			},
			context: personalCtx,
		});

		expect(result).toEqual({
			created: 1,
			failed: 1,
			skipped: 0,
			duplicates: 0,
			authFailed: 0,
		});
		// Only the first doc created a row + started a workflow.
		expect(mockCreateContext).toHaveBeenCalledTimes(1);
		expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
		// The failing doc never created a row, so no FAILED bookkeeping for it;
		// the successful doc only flips to EXTRACTING.
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalledWith(
			expect.anything(),
			"FAILED",
			expect.anything(),
		);
	});

	it("marks the row FAILED when the workflow fails to start after the row exists", async () => {
		mockWorkflowStart.mockRejectedValueOnce(new Error("temporal down"));

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "p1", files: [{ id: "d1", title: "One" }] },
			context: personalCtx,
		});

		expect(result).toEqual({
			created: 0,
			failed: 1,
			skipped: 0,
			duplicates: 0,
			authFailed: 0,
		});
		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-1",
			"FAILED",
			expect.objectContaining({
				extractionError: expect.stringContaining("temporal down"),
			}),
		);
	});

	it("skips files once the per-project INTEGRATION cap is reached", async () => {
		// 29 existing INTEGRATION contexts; cap is 30, so only one more can be
		// created and the second file must be skipped (not failed).
		mockCountContextsByType.mockResolvedValueOnce({ INTEGRATION: 29 });

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				files: [
					{ id: "d1", title: "One" },
					{ id: "d2", title: "Two" },
				],
			},
			context: personalCtx,
		});

		expect(result).toEqual({
			created: 1,
			failed: 0,
			skipped: 1,
			duplicates: 0,
			authFailed: 0,
		});
		expect(mockCreateContext).toHaveBeenCalledTimes(1);
		expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
	});

	it("does not re-add a Doc already ingested into the project (dedup)", async () => {
		// d1 is already present as an INTEGRATION context (by googleFileId).
		mockFindManyContexts.mockResolvedValueOnce([
			{ metadata: { googleFileId: "d1", source: "google-docs" } },
		]);

		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				files: [
					{ id: "d1", title: "One (already added)" },
					{ id: "d2", title: "Two (new)" },
				],
			},
			context: personalCtx,
		});

		expect(result).toEqual({
			created: 1,
			failed: 0,
			skipped: 0,
			duplicates: 1,
			authFailed: 0,
		});
		// Only the new doc was exported + created; the duplicate was skipped
		// before any export/S3/workflow work.
		expect(mockExportGoogleDocText).toHaveBeenCalledTimes(1);
		expect(mockExportGoogleDocText).toHaveBeenCalledWith({
			token: "tok-abc",
			fileId: "d2",
		});
		expect(mockCreateContext).toHaveBeenCalledTimes(1);
	});

	it("dedupes a Doc repeated within the same batch", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: {
				projectId: "p1",
				files: [
					{ id: "d1", title: "One" },
					{ id: "d1", title: "One again" },
				],
			},
			context: personalCtx,
		});

		expect(result).toEqual({
			created: 1,
			failed: 0,
			skipped: 0,
			duplicates: 1,
			authFailed: 0,
		});
		expect(mockCreateContext).toHaveBeenCalledTimes(1);
	});

	it("throws FORBIDDEN when the user has no project access", async () => {
		mockHasProjectAccess.mockResolvedValueOnce(false);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { projectId: "p1", files: [{ id: "d1", title: "One" }] },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mockGetGoogleDriveAccessToken).not.toHaveBeenCalled();
	});

	it("maps a not-connected error to a BAD_REQUEST for the whole batch (AC-10)", async () => {
		mockGetGoogleDriveAccessToken.mockRejectedValueOnce(
			new GoogleDriveNotConnectedError(),
		);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { projectId: "p1", files: [{ id: "d1", title: "One" }] },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mockCreateContext).not.toHaveBeenCalled();
	});

	it("maps an expired-token error to UNAUTHORIZED with a reconnect prompt (AC-5)", async () => {
		mockGetGoogleDriveAccessToken.mockRejectedValueOnce(
			new GoogleDriveTokenExpiredError(),
		);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { projectId: "p1", files: [{ id: "d1", title: "One" }] },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(mockCreateContext).not.toHaveBeenCalled();
	});
});
