/**
 * `listProjectContextPointIds` / `deleteProjectContextPoints`: the snapshot
 * and targeted delete a re-embed uses to replace a context's points without
 * removing them first.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { scrollMock, deleteMock, ensureCollectionMock, existsMock } = vi.hoisted(
	() => ({
		scrollMock: vi.fn(),
		deleteMock: vi.fn(),
		ensureCollectionMock: vi.fn(),
		existsMock: vi.fn(),
	}),
);

vi.mock("../client", () => ({
	qdrantClient: { scroll: scrollMock, delete: deleteMock },
}));

vi.mock("../../collection-manager", () => ({
	ensureCollection: ensureCollectionMock,
	getCollectionLayout: vi.fn(),
	collectionExistsUncached: existsMock,
	getCollectionName: (base: string, organizationId?: string | null) =>
		organizationId ? `${base}-${organizationId}` : base,
	PROJECT_CONTEXTS_BASE_COLLECTION: "project-contexts",
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { generatePointId } from "../../utils";
import {
	deleteOrphanProjectContextPoints,
	deleteProjectContextPoints,
	listProjectContextPointIds,
} from "../store";

const COLLECTION = "project-contexts-org-1";
const A = "00000000-0000-0000-0000-00000000000a";
const B = "00000000-0000-0000-0000-00000000000b";
const C = "00000000-0000-0000-0000-00000000000c";

beforeEach(() => {
	vi.clearAllMocks();
	ensureCollectionMock.mockResolvedValue(COLLECTION);
	deleteMock.mockResolvedValue({ status: "completed" });
});

describe("listProjectContextPointIds", () => {
	it("pages through every point of the context and includes the base id", async () => {
		scrollMock
			.mockResolvedValueOnce({
				points: [{ id: A }, { id: B }],
				next_page_offset: B,
			})
			.mockResolvedValueOnce({
				points: [{ id: C }],
				next_page_offset: null,
			});

		const ids = await listProjectContextPointIds("ctx-1", "org-1");

		expect(new Set(ids)).toEqual(
			new Set([generatePointId("ctx-1"), A, B, C]),
		);
		expect(scrollMock).toHaveBeenCalledTimes(2);
		expect(scrollMock.mock.calls[0][0]).toBe(COLLECTION);
		expect(scrollMock.mock.calls[0][1]).toMatchObject({
			filter: {
				should: [
					{ key: "originalContextId", match: { value: "ctx-1" } },
					{ key: "contextId", match: { value: "ctx-1" } },
				],
			},
			with_payload: false,
			with_vector: false,
		});
		expect(scrollMock.mock.calls[1][1]).toMatchObject({ offset: B });
	});

	it("rejects when the vector store fails, rather than returning a partial set", async () => {
		scrollMock.mockRejectedValue(new Error("qdrant unavailable"));

		await expect(
			listProjectContextPointIds("ctx-1", "org-1"),
		).rejects.toThrow("qdrant unavailable");
	});
});

describe("deleteProjectContextPoints", () => {
	it("deletes exactly the given ids", async () => {
		await deleteProjectContextPoints([A, B], "org-1");

		expect(deleteMock).toHaveBeenCalledWith(COLLECTION, {
			wait: true,
			points: [A, B],
		});
	});

	it("issues no request for an empty list", async () => {
		await deleteProjectContextPoints([], "org-1");

		expect(deleteMock).not.toHaveBeenCalled();
	});

	it("propagates a failed delete", async () => {
		deleteMock.mockRejectedValue(new Error("qdrant unavailable"));

		await expect(deleteProjectContextPoints([A], "org-1")).rejects.toThrow(
			"qdrant unavailable",
		);
	});
});

// A deleted context row is never re-embedded, so the reprocess removes its
// points (Fizzy #2770) — and nothing else.
describe("deleteOrphanProjectContextPoints", () => {
	const D = "00000000-0000-0000-0000-00000000000d";
	const E = "00000000-0000-0000-0000-00000000000e";
	const F = "00000000-0000-0000-0000-00000000000f";
	const G = "00000000-0000-0000-0000-000000000010";
	const H = "00000000-0000-0000-0000-000000000011";

	it("deletes only context-row points whose row no longer exists", async () => {
		existsMock.mockResolvedValue(true);
		scrollMock
			.mockResolvedValueOnce({
				points: [
					{ id: A, payload: { type: "TEXT", contextId: "ctx-live" } },
					{
						id: B,
						payload: {
							type: "FILE",
							contextId: "ctx-gone_chunk_1",
							originalContextId: "ctx-gone",
						},
					},
					{
						id: C,
						payload: {
							type: "DOCUMENT",
							contextId: "doc-1",
							documentId: "doc-1",
						},
					},
				],
				next_page_offset: C,
			})
			.mockResolvedValueOnce({
				points: [
					// A crawled URL page: its row is live, and it carries its parent.
					{
						id: D,
						payload: {
							type: "LINK",
							contextId: "page-1",
							parentContextId: "ctx-live",
						},
					},
					// A context summary.
					{
						id: E,
						payload: {
							type: "CONTEXT_SUMMARY",
							contextId: "summary-1",
						},
					},
					// A code-index chunk, keyed by no ProjectContext row.
					{
						id: F,
						payload: {
							type: "CODE_FILE",
							contextId: "code:repo:file.ts",
						},
					},
					{
						id: G,
						payload: {
							type: "TEXT",
							contextId: "wizard-1",
							isWizardContext: true,
						},
					},
					{
						id: H,
						payload: {
							type: "TEXT",
							contextId: "bundle-1",
							conversationBundleId: "bundle-1",
						},
					},
				],
				next_page_offset: null,
			});

		const deleted = await deleteOrphanProjectContextPoints({
			projectId: "proj-1",
			organizationId: "org-1",
			liveIds: new Set(["ctx-live", "page-1", "summary-1", "bundle-1"]),
		});

		expect(deleted).toBe(1);
		expect(scrollMock.mock.calls[0][0]).toBe(COLLECTION);
		expect(scrollMock.mock.calls[0][1]).toMatchObject({
			filter: {
				must: [
					{ key: "projectId", match: { value: "proj-1" } },
					{ key: "organizationId", match: { value: "org-1" } },
				],
			},
		});
		expect(deleteMock).toHaveBeenCalledWith(COLLECTION, {
			wait: true,
			points: [B],
		});
	});

	it("keeps URL pages and summaries even if their rows were missed", async () => {
		existsMock.mockResolvedValue(true);
		scrollMock.mockResolvedValueOnce({
			points: [
				{
					id: D,
					payload: {
						type: "LINK",
						contextId: "page-x",
						parentContextId: "ctx-live",
					},
				},
				{
					id: E,
					payload: {
						type: "CONTEXT_SUMMARY",
						contextId: "summary-x",
					},
				},
			],
			next_page_offset: null,
		});
		await expect(
			deleteOrphanProjectContextPoints({
				projectId: "proj-1",
				organizationId: "org-1",
				liveIds: new Set(["ctx-live"]),
			}),
		).resolves.toBe(0);
		expect(deleteMock).not.toHaveBeenCalled();
	});

	it("deletes nothing when the live rows read back empty", async () => {
		existsMock.mockResolvedValue(true);
		await expect(
			deleteOrphanProjectContextPoints({
				projectId: "proj-1",
				organizationId: "org-1",
				liveIds: new Set(),
			}),
		).resolves.toBe(0);
		expect(scrollMock).not.toHaveBeenCalled();
		expect(deleteMock).not.toHaveBeenCalled();
	});

	it("does nothing when the collection was never created", async () => {
		existsMock.mockResolvedValue(false);
		await expect(
			deleteOrphanProjectContextPoints({
				projectId: "proj-1",
				organizationId: "org-1",
				liveIds: new Set(["ctx-live"]),
			}),
		).resolves.toBe(0);
		expect(scrollMock).not.toHaveBeenCalled();
	});
});
