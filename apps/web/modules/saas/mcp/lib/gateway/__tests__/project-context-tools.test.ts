/**
 * `fabric_list_project_contexts` / `fabric_get_project_context` tests.
 *
 * These two tools are the MCP equivalent of the Context tab's "Download All"
 * export, so the cases below pin the promises that export cannot make on its
 * own: the inventory stays cheap on a code-indexed project, a monitored
 * integration says why it is empty instead of returning `""`, a crawled URL
 * source is reassembled from its child pages, long transcripts page rather
 * than truncate silently, and a context outside the caller's tenant is
 * indistinguishable from one that does not exist.
 *
 * `@repo/database`, `@repo/storage`, `@repo/config` and `@repo/utils` are
 * mocked — the handlers reach them through dynamic `await import(...)`, so the
 * mock intercepts inside the handler body.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/project-context-tools
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hasProjectAccess: vi.fn(),
	listProjectContextSummaries: vi.fn(),
	getContextById: vi.fn(),
	getCrawledUrlSourceMarkdown: vi.fn(),
	getSignedUrl: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	listProjectContextSummaries: mocks.listProjectContextSummaries,
	getContextById: mocks.getContextById,
	getCrawledUrlSourceMarkdown: mocks.getCrawledUrlSourceMarkdown,
}));

vi.mock("@repo/storage", () => ({
	getSignedUrl: mocks.getSignedUrl,
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { projectContexts: "contexts" } } },
}));

vi.mock("@repo/utils/attachment", () => ({
	buildContentDisposition: (filename: string) =>
		`attachment; filename="${filename}"`,
}));

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../platform-tools";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org-1",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

/** Parse the JSON payload a platform tool packs into its text content block. */
function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

/** A COMPLETED, readable transcript row as `getContextById` returns it. */
function transcriptRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx-1",
		projectId: "proj-1",
		type: "MEETING_TRANSCRIPT",
		content: "Alex: shipping Tuesday.",
		s3Path: null,
		s3Bucket: null,
		originalFilename: null,
		mimeType: null,
		fileSize: null,
		sourceTitle: "Weekly sync",
		sourceUrl: null,
		urlScope: null,
		extractionStatus: "COMPLETED",
		extractionError: null,
		metadata: null,
		createdAt: new Date("2026-08-01T09:00:00Z"),
		updatedAt: new Date("2026-08-01T09:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.listProjectContextSummaries.mockResolvedValue({
		contexts: [],
		total: 0,
		hasMore: false,
		excludedCodeContexts: 0,
	});
	mocks.getContextById.mockResolvedValue(transcriptRow());
	mocks.getCrawledUrlSourceMarkdown.mockResolvedValue("");
	mocks.getSignedUrl.mockResolvedValue("https://storage.example/signed");
});

describe("declarations", () => {
	it.each(["fabric_list_project_contexts", "fabric_get_project_context"])(
		"declares %s as read-only",
		(name) => {
			const definition = PLATFORM_TOOL_DEFINITIONS.find(
				(tool) => tool.name === name,
			);
			expect(definition).toBeDefined();
			expect(definition?.annotations?.readOnlyHint).toBe(true);
			expect(definition?._gateway_source).toBe("platform");
		},
	);
});

describe("fabric_list_project_contexts", () => {
	it("requires projectId", async () => {
		const result = await executePlatformTool(
			"fabric_list_project_contexts",
			{},
			session,
		);

		expect(result.isError).toBe(true);
		expect(mocks.listProjectContextSummaries).not.toHaveBeenCalled();
	});

	it("refuses a project the caller cannot reach", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		const result = await executePlatformTool(
			"fabric_list_project_contexts",
			{ projectId: "proj-other" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(mocks.listProjectContextSummaries).not.toHaveBeenCalled();
	});

	it("hides code-index entries by default and caps the page size", async () => {
		await executePlatformTool(
			"fabric_list_project_contexts",
			{ projectId: "proj-1", limit: 5000 },
			session,
		);

		expect(mocks.listProjectContextSummaries).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				includeCodeContexts: false,
				limit: 200,
			}),
		);
	});

	it("passes the opt-in through when the caller asks for code contexts", async () => {
		await executePlatformTool(
			"fabric_list_project_contexts",
			{ projectId: "proj-1", includeCodeContexts: true },
			session,
		);

		expect(mocks.listProjectContextSummaries).toHaveBeenCalledWith(
			expect.objectContaining({ includeCodeContexts: true }),
		);
	});

	it("explains an empty monitored integration instead of reporting it as readable", async () => {
		mocks.listProjectContextSummaries.mockResolvedValue({
			contexts: [
				{
					id: "ctx-teams",
					type: "INTEGRATION",
					sourceTitle: "Delivery chat",
					originalFilename: null,
					mimeType: null,
					fileSize: null,
					sourceUrl: null,
					extractionStatus: "COMPLETED",
					urlScope: null,
					metadata: { provider: "microsoft-teams" },
					createdAt: new Date("2026-08-01T09:00:00Z"),
					updatedAt: new Date("2026-08-01T09:00:00Z"),
					hasStoredFile: false,
					hasContent: false,
				},
			],
			total: 1,
			hasMore: false,
			excludedCodeContexts: 1200,
		});

		const body = payload(
			await executePlatformTool(
				"fabric_list_project_contexts",
				{ projectId: "proj-1" },
				session,
			),
		);

		expect(body.contexts[0]).toMatchObject({
			id: "ctx-teams",
			title: "Delivery chat",
			source: "microsoft-teams",
			contentAvailable: false,
		});
		expect(body.contexts[0].unavailableReason).toMatch(
			/monitored external conversation/i,
		);
		expect(body.excludedCodeContexts).toBe(1200);
	});
});

describe("fabric_get_project_context", () => {
	it("requires contextId", async () => {
		const result = await executePlatformTool(
			"fabric_get_project_context",
			{},
			session,
		);

		expect(result.isError).toBe(true);
		expect(mocks.getContextById).not.toHaveBeenCalled();
	});

	it("hides a context whose project the caller cannot reach", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		const result = await executePlatformTool(
			"fabric_get_project_context",
			{ contextId: "ctx-1" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/not found or access denied/i);
	});

	it("returns transcript text with the tenant's project access checked", async () => {
		const body = payload(
			await executePlatformTool(
				"fabric_get_project_context",
				{ contextId: "ctx-1" },
				session,
			),
		);

		expect(mocks.hasProjectAccess).toHaveBeenCalledWith(
			"proj-1",
			"user-1",
			"org-1",
		);
		expect(body).toMatchObject({
			id: "ctx-1",
			type: "MEETING_TRANSCRIPT",
			title: "Weekly sync",
			content: "Alex: shipping Tuesday.",
			contentAvailable: true,
			truncated: false,
		});
		expect(body.unavailableReason).toBeUndefined();
	});

	it("pages a long body instead of cutting it silently", async () => {
		mocks.getContextById.mockResolvedValue(
			transcriptRow({ content: "x".repeat(120) }),
		);

		const first = payload(
			await executePlatformTool(
				"fabric_get_project_context",
				{ contextId: "ctx-1", maxLength: 100 },
				session,
			),
		);

		expect(first).toMatchObject({
			contentLength: 120,
			returnedLength: 100,
			offset: 0,
			truncated: true,
			nextOffset: 100,
		});

		const second = payload(
			await executePlatformTool(
				"fabric_get_project_context",
				{ contextId: "ctx-1", maxLength: 100, offset: 100 },
				session,
			),
		);

		expect(second).toMatchObject({
			returnedLength: 20,
			truncated: false,
		});
		expect(second.nextOffset).toBeUndefined();
	});

	it("reassembles a crawled URL source from its child pages", async () => {
		mocks.getContextById.mockResolvedValue(
			transcriptRow({
				id: "ctx-link",
				type: "LINK",
				urlScope: "PATH_PREFIX",
				content: "",
				sourceTitle: "Docs site",
			}),
		);
		mocks.getCrawledUrlSourceMarkdown.mockResolvedValue(
			"## Install\nhttps://example.com/install\n\nRun the installer.\n",
		);

		const body = payload(
			await executePlatformTool(
				"fabric_get_project_context",
				{ contextId: "ctx-link" },
				session,
			),
		);

		expect(mocks.getCrawledUrlSourceMarkdown).toHaveBeenCalledWith(
			"ctx-link",
			{ userId: "user-1", organizationId: "org-1" },
		);
		expect(body.contentAvailable).toBe(true);
		expect(body.content).toContain("Run the installer.");
	});

	it("hands back a presigned link to the original upload alongside its text", async () => {
		mocks.getContextById.mockResolvedValue(
			transcriptRow({
				id: "ctx-file",
				type: "FILE",
				content: "Extracted page one.",
				s3Path: "project-contexts/proj-1/spec.pdf",
				s3Bucket: "contexts",
				originalFilename: "spec.pdf",
				mimeType: "application/pdf",
				fileSize: 20_480,
				sourceTitle: null,
			}),
		);

		const body = payload(
			await executePlatformTool(
				"fabric_get_project_context",
				{ contextId: "ctx-file" },
				session,
			),
		);

		expect(mocks.getSignedUrl).toHaveBeenCalledWith(
			"project-contexts/proj-1/spec.pdf",
			expect.objectContaining({ bucket: "contexts" }),
		);
		expect(body.title).toBe("spec.pdf");
		expect(body.content).toBe("Extracted page one.");
		expect(body.originalFile).toMatchObject({
			filename: "spec.pdf",
			mimeType: "application/pdf",
			sizeBytes: 20_480,
			url: "https://storage.example/signed",
		});
	});

	it("still returns the text when presigning the original fails", async () => {
		mocks.getContextById.mockResolvedValue(
			transcriptRow({
				type: "FILE",
				content: "Extracted page one.",
				s3Path: "project-contexts/proj-1/spec.pdf",
				originalFilename: "spec.pdf",
			}),
		);
		mocks.getSignedUrl.mockRejectedValue(new Error("bucket unreachable"));

		const body = payload(
			await executePlatformTool(
				"fabric_get_project_context",
				{ contextId: "ctx-1" },
				session,
			),
		);

		expect(body.content).toBe("Extracted page one.");
		expect(body.originalFile).toBeUndefined();
	});

	it("treats a whitespace-only extraction as nothing to read", async () => {
		// Found live on staging: a photo-only PDF extracts to "\n\n". The
		// pipeline marks it COMPLETED, so the row looks healthy — but the two
		// newlines are not text, and reporting them as readable is the exact
		// failure this field exists to prevent. The caller is pointed at the
		// original file instead, which is where the information actually is.
		mocks.getContextById.mockResolvedValue(
			transcriptRow({
				type: "DOCUMENT",
				content: "\n\n",
				extractionStatus: "COMPLETED",
				originalFilename: "recovery-photos.pdf",
				mimeType: "application/pdf",
				s3Path: "project-contexts/proj-1/photos.pdf",
				fileSize: 21_049,
				sourceTitle: null,
			}),
		);

		const body = payload(
			await executePlatformTool(
				"fabric_get_project_context",
				{ contextId: "ctx-1" },
				session,
			),
		);

		expect(body.contentAvailable).toBe(false);
		expect(body.unavailableReason).toMatch(/no text was extracted/i);
		expect(body.originalFile?.mimeType).toBe("application/pdf");
	});

	it("still counts a body that is only meaningful after trimming", async () => {
		mocks.getContextById.mockResolvedValue(
			transcriptRow({ content: "  Alex: shipping Tuesday.  " }),
		);

		const body = payload(
			await executePlatformTool(
				"fabric_get_project_context",
				{ contextId: "ctx-1" },
				session,
			),
		);

		expect(body.contentAvailable).toBe(true);
		// The payload itself is untouched — trimming decides the flag, not the text.
		expect(body.content).toBe("  Alex: shipping Tuesday.  ");
		expect(body.contentLength).toBe(27);
	});

	it("reports an in-flight extraction rather than an empty body", async () => {
		mocks.getContextById.mockResolvedValue(
			transcriptRow({
				type: "DOCUMENT",
				content: "",
				extractionStatus: "EXTRACTING",
			}),
		);

		const body = payload(
			await executePlatformTool(
				"fabric_get_project_context",
				{ contextId: "ctx-1" },
				session,
			),
		);

		expect(body.contentAvailable).toBe(false);
		expect(body.unavailableReason).toMatch(/still in progress/i);
	});
});
