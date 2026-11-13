/**
 * Reading a OneDrive transcript folder (Fizzy #3507): the listing a folder
 * connection and the sync both use, and the download that has to stop at the
 * transcript size limit whatever Graph reported.
 */

import { describe, expect, it, vi } from "vitest";
import { downloadDriveItem, listDriveFolderChildren } from "../drive-folder";

const GRAPH = "https://graph.microsoft.com/v1.0";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("listDriveFolderChildren", () => {
	it("lists the signed-in user's OneDrive root when no folder is named", async () => {
		const graphFetch = vi.fn(async (_url: string) =>
			json({
				value: [
					{
						id: "folder-1",
						name: "Transcripts",
						folder: { childCount: 3 },
						parentReference: { driveId: "drive-1" },
					},
				],
			}),
		);
		const result = await listDriveFolderChildren({
			graphFetch,
			graphBaseUrl: GRAPH,
		});
		expect(graphFetch.mock.calls[0]?.[0]).toContain(
			`${GRAPH}/me/drive/root/children`,
		);
		expect(result).toEqual({
			items: [
				{
					id: "folder-1",
					name: "Transcripts",
					driveId: "drive-1",
					isFolder: true,
					childCount: 3,
					size: null,
					webUrl: null,
					lastModified: null,
				},
			],
			truncated: false,
		});
	});

	it("follows Graph's pages and stops at the item limit", async () => {
		const page = (start: number, next?: string) =>
			json({
				value: [0, 1].map((i) => ({
					id: `item-${start + i}`,
					name: `${start + i}.vtt`,
					size: 10,
					file: {},
				})),
				...(next ? { "@odata.nextLink": next } : {}),
			});
		const graphFetch = vi
			.fn()
			.mockResolvedValueOnce(page(0, `${GRAPH}/next-page`))
			.mockResolvedValueOnce(page(2));
		const result = await listDriveFolderChildren({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			itemId: "folder-1",
			maxItems: 3,
		});
		expect(graphFetch.mock.calls[0]?.[0]).toContain(
			`${GRAPH}/drives/drive-1/items/folder-1/children`,
		);
		expect(graphFetch.mock.calls[1]?.[0]).toBe(`${GRAPH}/next-page`);
		expect(result.items.map((item) => item.id)).toEqual([
			"item-0",
			"item-1",
			"item-2",
		]);
		expect(result.truncated).toBe(true);
		expect(result.items[0]?.driveId).toBe("drive-1");
	});

	it("says in words that a folder is gone", async () => {
		const graphFetch = vi.fn(async (_url: string) => json({}, 404));
		await expect(
			listDriveFolderChildren({
				graphFetch,
				graphBaseUrl: GRAPH,
				driveId: "drive-1",
				itemId: "folder-1",
			}),
		).rejects.toThrow("no longer exists in OneDrive");
	});
});

describe("downloadDriveItem", () => {
	const item = (overrides: Record<string, unknown> = {}) =>
		json({
			id: "item-1",
			name: "sync.vtt",
			size: 5,
			"@microsoft.graph.downloadUrl":
				"https://example-my.sharepoint.com/download.aspx?token=t",
			...overrides,
		});

	it("reads the file from its download link, sending no token", async () => {
		const graphFetch = vi.fn(async (_url: string) => item());
		const fetchImpl = vi.fn(
			async (_url: URL, _init?: RequestInit) => new Response("WEBVTT"),
		);
		const result = await downloadDriveItem({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			itemId: "item-1",
			maxBytes: 100,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result).toMatchObject({ status: "ok", name: "sync.vtt" });
		expect(result.status === "ok" && result.bytes.toString()).toBe(
			"WEBVTT",
		);
		const [, init] = fetchImpl.mock.calls[0] as unknown as [
			URL,
			RequestInit,
		];
		expect(init.headers).toBeUndefined();
	});

	it("refuses a file Graph says is too large, without downloading it", async () => {
		const graphFetch = vi.fn(async (_url: string) => item({ size: 500 }));
		const fetchImpl = vi.fn();
		const result = await downloadDriveItem({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			itemId: "item-1",
			maxBytes: 100,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result).toEqual({
			status: "too_large",
			name: "sync.vtt",
			size: 500,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("stops reading when the bytes outgrow the limit Graph reported", async () => {
		const graphFetch = vi.fn(async (_url: string) => item({ size: 5 }));
		const fetchImpl = vi.fn(
			async (_url: URL, _init?: RequestInit) =>
				new Response("x".repeat(200)),
		);
		const result = await downloadDriveItem({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			itemId: "item-1",
			maxBytes: 100,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(result.status).toBe("too_large");
	});

	it("refuses a download link on a host OneDrive does not use", async () => {
		const graphFetch = vi.fn(async (_url: string) =>
			item({
				"@microsoft.graph.downloadUrl": "https://example.com/file",
			}),
		);
		await expect(
			downloadDriveItem({
				graphFetch,
				graphBaseUrl: GRAPH,
				driveId: "drive-1",
				itemId: "item-1",
				maxBytes: 100,
				fetchImpl: vi.fn() as unknown as typeof fetch,
			}),
		).rejects.toThrow("no usable download link");
	});

	it("reports a file that was deleted since it was listed", async () => {
		const graphFetch = vi.fn(async (_url: string) => json({}, 404));
		expect(
			await downloadDriveItem({
				graphFetch,
				graphBaseUrl: GRAPH,
				driveId: "drive-1",
				itemId: "item-1",
				maxBytes: 100,
			}),
		).toEqual({ status: "gone" });
	});
});
