/**
 * Reading OneDrive and SharePoint folders: the one-level listing transcript
 * folders use, the download that has to stop at a size limit whatever Graph
 * reported, and what document folders need on top — SharePoint discovery, a
 * bounded walk of a folder tree, and looking items up by id.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted: vi.mock factories run before module-level consts are initialized.
const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@repo/database", async () => ({
	canUseWorkflowIntegrations: vi.fn().mockResolvedValue(true),
	workflowIntegrationAccessWhere: (
		await import(
			"@repo/database/prisma/queries/workflows/integration-access"
		)
	).workflowIntegrationAccessWhere,
	resolveWorkflowIntegrationForProvider: async (
		...args: Parameters<
			typeof import("@repo/database/prisma/queries/workflows/integration-access").resolveWorkflowIntegrationForProvider
		>
	) => {
		const mocked = await import("@repo/database");
		return mocked.db.workflowIntegration.findFirst({
			where: {
				...mocked.workflowIntegrationAccessWhere(args[1], args[2]),
				provider: args[0],
				isActive: true,
			},
		});
	},
	db: { workflowIntegration: { findFirst, update: vi.fn() } },
}));
vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => v,
}));
vi.mock("@repo/ai", () => ({ extractRelevantExcerpts: vi.fn() }));

import { GRAPH_REQUEST_TIMEOUT_MS } from "../config/limits";
import {
	downloadDriveItem,
	driveItemContentVersion,
	driveProviderForDriveType,
	getDriveItemDetails,
	listDriveFolderChildren,
	listDriveFolderTree,
	listFollowedSharePointSites,
	listSharePointSiteDrives,
	lookupDriveItemsInFolder,
	searchSharePointSites,
} from "../drive-folder";
import { executeMicrosoftTeamsTool } from "../index";
import { MicrosoftRequestTimeoutError } from "../request";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	findFirst.mockReset();
});

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
	const DOWNLOAD_LINK =
		"https://example-my.sharepoint.com/personal/dev/_layouts/15/download.aspx?UniqueId=u&tempauth=secret";

	const item = (overrides: Record<string, unknown> = {}) =>
		json({ id: "item-1", name: "sync.vtt", size: 5, ...overrides });

	const redirectTo = (location: string | null, status = 302) =>
		new Response(null, {
			status,
			headers: location ? { location } : {},
		});

	/** Graph answering the item's metadata and its `/content`. */
	function graph(
		metadata: () => Response = () => item(),
		content: () => Response = () => redirectTo(DOWNLOAD_LINK),
	) {
		return vi.fn(async (url: string, _init?: RequestInit) =>
			url.endsWith("/content") ? content() : metadata(),
		);
	}

	const download = (
		graphFetch: ReturnType<typeof graph>,
		fetchImpl: unknown = vi.fn(async () => new Response("WEBVTT")),
	) =>
		downloadDriveItem({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			itemId: "item-1",
			maxBytes: 100,
			fetchImpl: fetchImpl as typeof fetch,
		});

	it("bounds an injected hung download at 60 seconds, not the Graph deadline", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockRejectedValue(new Error("Default fetch must not be used")),
		);
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const controller = new AbortController();
			setTimeout(
				() =>
					controller.abort(
						new DOMException("Deadline", "TimeoutError"),
					),
				ms,
			);
			return controller.signal;
		});
		const fetchImpl = vi.fn(
			(_url: string | URL | Request, options?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () =>
						reject(options.signal?.reason),
					);
				}),
		);
		let outcome: unknown = "pending";
		const result = download(graph(), fetchImpl).then(
			(value) => {
				outcome = value;
			},
			(error) => {
				outcome = error;
			},
		);
		await vi.advanceTimersByTimeAsync(GRAPH_REQUEST_TIMEOUT_MS);
		expect(outcome).toBe("pending");
		await vi.advanceTimersByTimeAsync(
			60_000 - GRAPH_REQUEST_TIMEOUT_MS - 1,
		);
		expect(outcome).toBe("pending");
		await vi.advanceTimersByTimeAsync(1);
		expect(outcome).toBeInstanceOf(MicrosoftRequestTimeoutError);
		expect((outcome as Error).message).toBe(
			"Microsoft Graph request timed out: GET /personal/dev/_layouts/15/download.aspx",
		);
		await result;
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("reads the file from the link /content redirects to, sending no token", async () => {
		const graphFetch = graph();
		const fetchImpl = vi.fn(
			async (_url: string, _init?: RequestInit) => new Response("WEBVTT"),
		);
		const result = await download(graphFetch, fetchImpl);

		expect(result).toMatchObject({ status: "ok", name: "sync.vtt" });
		expect(result.status === "ok" && result.bytes.toString()).toBe(
			"WEBVTT",
		);
		expect(graphFetch.mock.calls[0][0]).toBe(
			`${GRAPH}/drives/drive-1/items/item-1?$select=id,name,size,file`,
		);
		expect(graphFetch.mock.calls[1]).toEqual([
			`${GRAPH}/drives/drive-1/items/item-1/content`,
			{ redirect: "manual" },
		]);
		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(DOWNLOAD_LINK);
		expect(init.headers).toBeUndefined();
		expect(init.redirect).toBe("error");
	});

	it("reads the bytes Graph serves from /content without a redirect", async () => {
		const fetchImpl = vi.fn();
		const result = await download(
			graph(undefined, () => new Response("WEBVTT")),
			fetchImpl,
		);
		expect(result.status === "ok" && result.bytes.toString()).toBe(
			"WEBVTT",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("returns the file type Graph reports with the bytes", async () => {
		const result = await download(
			graph(() =>
				item({ name: "notes", file: { mimeType: "application/pdf" } }),
			),
			vi.fn(async () => new Response("%PDF")),
		);
		expect(result).toMatchObject({
			status: "ok",
			name: "notes",
			mimeType: "application/pdf",
		});
	});

	it("returns no file type when Graph reports none", async () => {
		const result = await download(graph());
		expect(result).toMatchObject({ status: "ok", mimeType: null });
	});

	it("refuses a file Graph says is too large, without downloading it", async () => {
		const graphFetch = graph(() => item({ size: 500 }));
		const fetchImpl = vi.fn();
		const result = await download(graphFetch, fetchImpl);
		expect(result).toEqual({
			status: "too_large",
			name: "sync.vtt",
			size: 500,
		});
		expect(graphFetch).toHaveBeenCalledTimes(1);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("stops reading when the bytes outgrow the limit Graph reported", async () => {
		const result = await download(
			graph(() => item({ size: 5 })),
			vi.fn(async () => new Response("x".repeat(200))),
		);
		expect(result.status).toBe("too_large");
	});

	it("refuses a redirect to a host OneDrive does not use, naming only the host", async () => {
		const fetchImpl = vi.fn();
		const failure = download(
			graph(undefined, () =>
				redirectTo("https://example.com/file?tempauth=secret"),
			),
			fetchImpl,
		);
		await expect(failure).rejects.toThrow(
			"Microsoft Graph redirected the download to an unexpected host: example.com",
		);
		await expect(failure).rejects.not.toThrow("secret");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("refuses a redirect with no location", async () => {
		await expect(
			download(graph(undefined, () => redirectTo(null))),
		).rejects.toThrow(
			"Microsoft Graph answered 302 with no download location.",
		);
	});

	it("resolves a relative location against Graph, which is no download host", async () => {
		const fetchImpl = vi.fn();
		await expect(
			download(
				graph(undefined, () => redirectTo("/download?tempauth=secret")),
				fetchImpl,
			),
		).rejects.toThrow(
			"Microsoft Graph redirected the download to an unexpected host: graph.microsoft.com",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("reports a refused /content as a Graph error", async () => {
		await expect(
			download(
				graph(undefined, () =>
					json({ error: { code: "accessDenied" } }, 403),
				),
			),
		).rejects.toThrow("can no longer read");
	});

	it("reports a file that was deleted since it was listed", async () => {
		expect(await download(graph(() => json({}, 404)))).toEqual({
			status: "gone",
		});
		expect(await download(graph(undefined, () => json({}, 404)))).toEqual({
			status: "gone",
		});
	});
});

describe("download_drive_item through the Graph request helper", () => {
	it("sends the token to Graph only, and reads the redirect unfollowed", async () => {
		findFirst.mockResolvedValue({
			id: "integration-1",
			credentials: JSON.stringify({
				access_token: "access-token",
				refresh_token: "refresh-token",
			}),
		});
		const link =
			"https://example-my.sharepoint.com/download.aspx?tempauth=secret";
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				const href = String(url);
				calls.push({ url: href, init });
				if (href.endsWith("/content")) {
					return new Response(null, {
						status: 302,
						headers: { location: link },
					});
				}
				if (href === link) {
					return new Response("WEBVTT");
				}
				return json({ id: "item-1", name: "sync.vtt", size: 6 });
			}),
		);

		const result = await executeMicrosoftTeamsTool(
			"download_drive_item",
			{ driveId: "drive-1", itemId: "item-1", maxBytes: 100 },
			"user-1",
		);

		expect(result).toMatchObject({ status: "ok", name: "sync.vtt" });
		const content = calls.find((c) => c.url.endsWith("/content"));
		expect(content?.init?.redirect).toBe("manual");
		expect(
			(content?.init?.headers as Record<string, string>).Authorization,
		).toBe("Bearer access-token");
		const fileRequest = calls.find((c) => c.url === link);
		expect(fileRequest?.init?.redirect).toBe("error");
		expect(fileRequest?.init?.headers).toBeUndefined();
		// Every other request keeps refusing redirects.
		for (const call of calls.filter(
			(c) => c.url !== link && !c.url.endsWith("/content"),
		)) {
			expect(call.init?.redirect).toBe("error");
		}
	});
});

/**
 * A Graph stand-in that answers by path, plus a `page` marker for next links.
 * Anything it does not know is a 404.
 */
function graphRoutes(routes: Record<string, () => Response>) {
	const urls: string[] = [];
	const graphFetch = vi.fn(async (url: string) => {
		urls.push(url);
		const parsed = new URL(url);
		const page = parsed.searchParams.get("page");
		const key =
			parsed.pathname.replace(/^\/v1\.0/, "") +
			(page ? `?page=${page}` : "");
		return (
			routes[key]?.() ?? json({ error: { code: "itemNotFound" } }, 404)
		);
	});
	return { graphFetch, urls };
}

const childrenOf = (folderId: string) =>
	`/drives/drive-1/items/${folderId}/children`;

const page = (value: unknown[], nextPage?: number) => (): Response =>
	json({
		value,
		...(nextPage
			? {
					"@odata.nextLink": `${GRAPH}/drives/drive-1/items/next/children?page=${nextPage}`,
				}
			: {}),
	});

function fileItem(id: string, name: string, overrides = {}) {
	return {
		id,
		name,
		size: 100,
		lastModifiedDateTime: "2026-11-01T10:00:00Z",
		file: {
			mimeType: "application/pdf",
			hashes: { quickXorHash: `hash-${id}` },
		},
		...overrides,
	};
}

function folderItem(id: string, name: string) {
	return { id, name, folder: { childCount: 1 } };
}

function listedFile(id: string, relativePath: string) {
	return {
		id,
		name: relativePath.split("/").at(-1),
		relativePath,
		size: 100,
		mimeType: "application/pdf",
		quickXorHash: `hash-${id}`,
		lastModified: "2026-11-01T10:00:00Z",
		contentVersion: `quickXorHash:hash-${id}`,
	};
}

describe("listDriveFolderTree", () => {
	it("lists every file of a three-level tree with its path below the folder", async () => {
		const { graphFetch, urls } = graphRoutes({
			[childrenOf("folder-root")]: page([
				fileItem("file-a", "Plan.pdf"),
				folderItem("folder-design", "Design"),
				// A shortcut to another drive is neither a file nor a folder here.
				{
					id: "shortcut-1",
					name: "Team share",
					remoteItem: { id: "r-1" },
				},
			]),
			[childrenOf("folder-design")]: page([
				fileItem("file-b", "Spec.pdf"),
				folderItem("folder-drafts", "Drafts"),
			]),
			[childrenOf("folder-drafts")]: page([
				fileItem("file-c", "Notes.pdf"),
			]),
		});

		const result = await listDriveFolderTree({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			itemId: "folder-root",
		});

		expect(urls[0]).toContain(
			`${GRAPH}/drives/drive-1/items/folder-root/children?$top=200`,
		);
		expect(result).toEqual({
			status: "complete",
			files: [
				listedFile("file-a", "Plan.pdf"),
				listedFile("file-b", "Design/Spec.pdf"),
				listedFile("file-c", "Design/Drafts/Notes.pdf"),
			],
		});
	});

	it("reads files five folders down, leaves a sixth unread, and stays complete", async () => {
		const routes: Record<string, () => Response> = {
			[childrenOf("folder-root")]: page([folderItem("level-1", "L1")]),
		};
		for (let level = 1; level <= 6; level++) {
			routes[childrenOf(`level-${level}`)] = page([
				fileItem(`file-${level}`, `${level}.pdf`),
				folderItem(`level-${level + 1}`, `L${level + 1}`),
			]);
		}
		const { graphFetch, urls } = graphRoutes(routes);

		const result = await listDriveFolderTree({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			itemId: "folder-root",
		});

		expect(result.status).toBe("complete");
		expect(
			result.status === "complete" &&
				result.files.map((file) => file.relativePath),
		).toEqual([
			"L1/1.pdf",
			"L1/L2/2.pdf",
			"L1/L2/L3/3.pdf",
			"L1/L2/L3/L4/4.pdf",
			"L1/L2/L3/L4/L5/5.pdf",
		]);
		expect(urls.some((url) => url.includes("level-6"))).toBe(false);
	});

	it("stops at the scan limit in the middle of a page and says so", async () => {
		const { graphFetch } = graphRoutes({
			[childrenOf("folder-root")]: page(
				[1, 2, 3, 4, 5].map((n) => fileItem(`file-${n}`, `${n}.pdf`)),
			),
		});

		const result = await listDriveFolderTree({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			itemId: "folder-root",
			maxItems: 3,
		});

		expect(result).toEqual({
			status: "truncated",
			reason: "scan_limit",
			files: [
				listedFile("file-1", "1.pdf"),
				listedFile("file-2", "2.pdf"),
				listedFile("file-3", "3.pdf"),
			],
		});
	});

	it("stays complete when the tree holds exactly the scan limit", async () => {
		const { graphFetch } = graphRoutes({
			[childrenOf("folder-root")]: page(
				[1, 2, 3].map((n) => fileItem(`file-${n}`, `${n}.pdf`)),
			),
		});

		const result = await listDriveFolderTree({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			itemId: "folder-root",
			maxItems: 3,
		});

		expect(result.status).toBe("complete");
	});

	it("returns the files found so far when a subfolder's page fails", async () => {
		const { graphFetch } = graphRoutes({
			[childrenOf("folder-root")]: page([
				fileItem("file-a", "Plan.pdf"),
				folderItem("folder-restricted", "Restricted"),
				folderItem("folder-open", "Open"),
			]),
			[childrenOf("folder-restricted")]: () =>
				json({ error: { code: "accessDenied" } }, 403),
			[childrenOf("folder-open")]: page([fileItem("file-b", "Spec.pdf")]),
		});

		const result = await listDriveFolderTree({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			itemId: "folder-root",
		});

		expect(result).toEqual({
			status: "truncated",
			reason: "page_failed",
			httpStatus: 403,
			retryAfterSeconds: null,
			files: [listedFile("file-a", "Plan.pdf")],
		});
	});

	it.each([403, 404])(
		"reports a %i on the connected folder as a root failure",
		async (status) => {
			const { graphFetch } = graphRoutes({
				[childrenOf("folder-root")]: () => json({}, status),
			});

			const result = await listDriveFolderTree({
				graphFetch,
				graphBaseUrl: GRAPH,
				driveId: "drive-1",
				itemId: "folder-root",
			});

			expect(result).toEqual({
				status: "root_failed",
				httpStatus: status,
				retryAfterSeconds: null,
			});
		},
	);

	it("builds a missing quickXorHash's version from size and modified time", async () => {
		const { graphFetch } = graphRoutes({
			[childrenOf("folder-root")]: page([
				fileItem("file-a", "Plan.pdf", {
					size: 2048,
					lastModifiedDateTime: "2026-11-02T08:30:00Z",
					file: { mimeType: "application/pdf" },
				}),
			]),
		});

		const result = await listDriveFolderTree({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			itemId: "folder-root",
		});

		expect(result.status === "complete" && result.files[0]).toMatchObject({
			quickXorHash: null,
			contentVersion: "size:2048|modified:2026-11-02T08:30:00Z",
		});
		expect(
			driveItemContentVersion({
				quickXorHash: null,
				size: 2048,
				lastModified: "2026-11-02T08:30:00Z",
			}),
		).toBe("size:2048|modified:2026-11-02T08:30:00Z");
		expect(
			driveItemContentVersion({
				quickXorHash: "abc=",
				size: 2048,
				lastModified: "2026-11-02T08:30:00Z",
			}),
		).toBe("quickXorHash:abc=");
	});
});

describe("list_drive_tree through the Graph request helper", () => {
	/**
	 * Real `executeMicrosoftTeamsTool` with `fetch` stubbed, so the retry and
	 * the progress callback are the ones the activities get. Each path has a
	 * queue of responses whose last one repeats.
	 */
	function stubGraph(routes: Record<string, Array<() => Response>>) {
		const urls: string[] = [];
		const served = new Map<string, number>();
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string | URL) => {
				urls.push(String(url));
				const parsed = new URL(String(url));
				const page = parsed.searchParams.get("page");
				const key =
					parsed.pathname.replace(/^\/v1\.0/, "") +
					(page ? `?page=${page}` : "");
				const queue = routes[key] ?? [() => json({}, 404)];
				const count = served.get(key) ?? 0;
				served.set(key, count + 1);
				return Promise.resolve(
					queue[Math.min(count, queue.length - 1)](),
				);
			}),
		);
		return urls;
	}

	const throttled = (retryAfter: string) => () =>
		new Response(JSON.stringify({ error: { code: "TooManyRequests" } }), {
			status: 429,
			headers: { "Retry-After": retryAfter },
		});

	function connect() {
		vi.useFakeTimers();
		findFirst.mockResolvedValue({
			id: "integration-1",
			credentials: JSON.stringify({
				access_token: "access-token",
				refresh_token: "refresh-token",
			}),
		});
	}

	it("completes when a throttled page succeeds on retry", async () => {
		connect();
		const urls = stubGraph({
			[childrenOf("folder-root")]: [
				throttled("1"),
				page([fileItem("file-a", "Plan.pdf")]),
			],
		});

		const promise = executeMicrosoftTeamsTool(
			"list_drive_tree",
			{ driveId: "drive-1", itemId: "folder-root" },
			"user-1",
		);
		await vi.runAllTimersAsync();

		expect(await promise).toEqual({
			status: "complete",
			files: [listedFile("file-a", "Plan.pdf")],
		});
		expect(urls).toHaveLength(2);
	});

	it("returns an incomplete listing with Retry-After when throttling outlasts the retries", async () => {
		connect();
		const urls = stubGraph({
			[childrenOf("folder-root")]: [
				page([
					fileItem("file-a", "Plan.pdf"),
					folderItem("folder-sub", "Sub"),
				]),
			],
			[childrenOf("folder-sub")]: [throttled("120")],
		});

		const promise = executeMicrosoftTeamsTool(
			"list_drive_tree",
			{ driveId: "drive-1", itemId: "folder-root" },
			"user-1",
		);
		await vi.runAllTimersAsync();

		expect(await promise).toEqual({
			status: "truncated",
			reason: "page_failed",
			httpStatus: 429,
			retryAfterSeconds: 120,
			files: [listedFile("file-a", "Plan.pdf")],
		});
		// The first page, then the subfolder's attempt and its three retries.
		expect(urls).toHaveLength(5);
	});

	it("calls the code-only onProgress once per page", async () => {
		connect();
		stubGraph({
			[childrenOf("folder-root")]: [
				page(
					[
						fileItem("file-a", "Plan.pdf"),
						folderItem("folder-sub", "Sub"),
					],
					2,
				),
			],
			"/drives/drive-1/items/next/children?page=2": [
				page([fileItem("file-b", "Spec.pdf")]),
			],
			[childrenOf("folder-sub")]: [
				page([fileItem("file-c", "Notes.pdf")]),
			],
		});
		const onProgress = vi.fn();

		const promise = executeMicrosoftTeamsTool(
			"list_drive_tree",
			{ driveId: "drive-1", itemId: "folder-root" },
			"user-1",
			undefined,
			undefined,
			{ onProgress },
		);
		await vi.runAllTimersAsync();
		await promise;

		expect(onProgress.mock.calls).toEqual([
			[{ requests: 1, items: 2 }],
			[{ requests: 2, items: 3 }],
			[{ requests: 3, items: 4 }],
		]);
	});

	it("routes the item and SharePoint reads, with progress for lookups", async () => {
		connect();
		const siteId = "example.sharepoint.com,site-1,web-1";
		stubGraph({
			"/drives/drive-1/items/folder-root": [
				() =>
					json({
						id: "folder-root",
						name: "Team",
						folder: {},
						parentReference: {
							driveId: "drive-1",
							driveType: "business",
						},
					}),
			],
			"/drives/drive-1/items/file-inside": [
				() =>
					json({
						id: "file-inside",
						parentReference: { id: "folder-root" },
					}),
			],
			"/sites": [() => json({ value: [{ id: siteId, name: "s" }] })],
			"/me/followedSites": [() => json({}, 400)],
			[`/sites/${siteId}/drives`]: [() => json({ value: [] })],
		});
		const run = async (
			method: string,
			args: Record<string, unknown>,
			options = {},
		) => {
			const promise = executeMicrosoftTeamsTool(
				method,
				args,
				"user-1",
				undefined,
				undefined,
				options,
			);
			await vi.runAllTimersAsync();
			return promise;
		};
		const onProgress = vi.fn();

		expect(
			await run("get_drive_item", {
				driveId: "drive-1",
				itemId: "folder-root",
			}),
		).toMatchObject({ status: "ok", item: { provider: "onedrive" } });
		expect(
			await run(
				"lookup_drive_items",
				{
					driveId: "drive-1",
					folderItemId: "folder-root",
					itemIds: ["file-inside"],
				},
				{ onProgress },
			),
		).toEqual({ items: [{ itemId: "file-inside", state: "inside" }] });
		expect(onProgress).toHaveBeenCalledTimes(2);
		expect(
			await run("search_sharepoint_sites", { query: "Marketing" }),
		).toMatchObject({ status: "ok", sites: [{ id: siteId }] });
		expect(await run("list_followed_sharepoint_sites", {})).toEqual({
			status: "unavailable",
		});
		expect(await run("list_sharepoint_site_drives", { siteId })).toEqual({
			status: "ok",
			drives: [],
		});
	});
});

describe("SharePoint discovery", () => {
	const site = {
		id: "example.sharepoint.com,site-1,web-1",
		displayName: "Marketing",
		name: "marketing",
		webUrl: "https://example.sharepoint.com/sites/marketing",
	};
	const listedSite = {
		id: "example.sharepoint.com,site-1,web-1",
		name: "Marketing",
		webUrl: "https://example.sharepoint.com/sites/marketing",
	};

	it("returns the sites a search finds", async () => {
		const { graphFetch, urls } = graphRoutes({
			"/sites": () => json({ value: [site] }),
		});

		const result = await searchSharePointSites({
			graphFetch,
			graphBaseUrl: GRAPH,
			query: "Marketing plans",
		});

		expect(urls[0]).toBe(`${GRAPH}/sites?search=Marketing%20plans`);
		expect(result).toEqual({ status: "ok", sites: [listedSite] });
	});

	it.each([400, 403, 404])(
		"reports SharePoint unavailable, not an error, on a %i from /sites",
		async (status) => {
			const { graphFetch } = graphRoutes({
				"/sites": () => json({ error: { code: "BadRequest" } }, status),
			});

			expect(
				await searchSharePointSites({
					graphFetch,
					graphBaseUrl: GRAPH,
					query: "Marketing",
				}),
			).toEqual({ status: "unavailable" });
		},
	);

	it("throws, not unavailable, when /sites stays throttled", async () => {
		const { graphFetch } = graphRoutes({
			"/sites": () => json({ error: { code: "TooManyRequests" } }, 429),
		});

		await expect(
			searchSharePointSites({
				graphFetch,
				graphBaseUrl: GRAPH,
				query: "Marketing",
			}),
		).rejects.toThrow();
	});

	it("throws on a server error from /sites", async () => {
		const { graphFetch } = graphRoutes({
			"/sites": () =>
				json({ error: { code: "serviceNotAvailable" } }, 503),
		});

		await expect(
			searchSharePointSites({
				graphFetch,
				graphBaseUrl: GRAPH,
				query: "Marketing",
			}),
		).rejects.toThrow("503");
	});

	it("sends no search for a blank query", async () => {
		const { graphFetch } = graphRoutes({});

		expect(
			await searchSharePointSites({
				graphFetch,
				graphBaseUrl: GRAPH,
				query: "  ",
			}),
		).toEqual({ status: "ok", sites: [] });
		expect(graphFetch).not.toHaveBeenCalled();
	});

	it("lists followed sites, unavailable on a 4xx and empty on any other failure", async () => {
		const ok = graphRoutes({
			"/me/followedSites": () => json({ value: [site] }),
		});
		expect(
			await listFollowedSharePointSites({
				graphFetch: ok.graphFetch,
				graphBaseUrl: GRAPH,
			}),
		).toEqual({ status: "ok", sites: [listedSite] });

		const personal = graphRoutes({
			"/me/followedSites": () => json({}, 400),
		});
		expect(
			await listFollowedSharePointSites({
				graphFetch: personal.graphFetch,
				graphBaseUrl: GRAPH,
			}),
		).toEqual({ status: "unavailable" });

		const busy = graphRoutes({
			"/me/followedSites": () => json({}, 503),
		});
		expect(
			await listFollowedSharePointSites({
				graphFetch: busy.graphFetch,
				graphBaseUrl: GRAPH,
			}),
		).toEqual({ status: "ok", sites: [] });
	});

	it("lists a site's document libraries as SharePoint drives", async () => {
		const { graphFetch, urls } = graphRoutes({
			"/sites/example.sharepoint.com,site-1,web-1/drives": () =>
				json({
					value: [
						{
							id: "drive-docs",
							name: "Documents",
							driveType: "documentLibrary",
							webUrl: "https://example.sharepoint.com/sites/marketing/Shared%20Documents",
						},
					],
				}),
		});

		const result = await listSharePointSiteDrives({
			graphFetch,
			graphBaseUrl: GRAPH,
			siteId: "example.sharepoint.com,site-1,web-1",
		});

		expect(urls[0]).toContain(
			`${GRAPH}/sites/example.sharepoint.com,site-1,web-1/drives?`,
		);
		expect(result).toEqual({
			status: "ok",
			drives: [
				{
					id: "drive-docs",
					name: "Documents",
					driveType: "documentLibrary",
					provider: "sharepoint",
					webUrl: "https://example.sharepoint.com/sites/marketing/Shared%20Documents",
				},
			],
		});
	});

	it("reports a site's libraries unavailable on a 4xx", async () => {
		const { graphFetch } = graphRoutes({});

		expect(
			await listSharePointSiteDrives({
				graphFetch,
				graphBaseUrl: GRAPH,
				siteId: "example.sharepoint.com,site-1,web-1",
			}),
		).toEqual({ status: "unavailable" });
	});
});

describe("driveProviderForDriveType", () => {
	it.each([
		["documentLibrary", "sharepoint"],
		["business", "onedrive"],
		["personal", "onedrive"],
		["somethingElse", null],
		[null, null],
	] as const)("maps %s to %s", (driveType, provider) => {
		expect(driveProviderForDriveType(driveType)).toBe(provider);
	});
});

describe("getDriveItemDetails", () => {
	it("returns a SharePoint folder with its decoded parent path", async () => {
		const { graphFetch } = graphRoutes({
			"/drives/drive-1/items/folder-root": () =>
				json({
					id: "folder-root",
					name: "Team",
					webUrl: "https://example.sharepoint.com/sites/marketing/Shared%20Documents/Plans/Team",
					folder: { childCount: 4 },
					parentReference: {
						driveId: "drive-1",
						driveType: "documentLibrary",
						id: "folder-plans",
						path: "/drives/drive-1/root:/Plans%20and%20Notes",
					},
				}),
		});

		expect(
			await getDriveItemDetails({
				graphFetch,
				graphBaseUrl: GRAPH,
				driveId: "drive-1",
				itemId: "folder-root",
			}),
		).toEqual({
			status: "ok",
			item: {
				id: "folder-root",
				name: "Team",
				driveId: "drive-1",
				driveType: "documentLibrary",
				provider: "sharepoint",
				isFolder: true,
				webUrl: "https://example.sharepoint.com/sites/marketing/Shared%20Documents/Plans/Team",
				parentPath: "/Plans and Notes",
			},
		});
	});

	it("reads the drive's type when the item does not carry it", async () => {
		const { graphFetch } = graphRoutes({
			"/drives/drive-1/items/root": () =>
				json({
					id: "drive-root-id",
					name: "root",
					folder: { childCount: 2 },
					parentReference: { driveId: "drive-1" },
				}),
			"/drives/drive-1": () =>
				json({ id: "drive-1", driveType: "business" }),
		});

		const result = await getDriveItemDetails({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			itemId: "root",
		});

		expect(result).toMatchObject({
			status: "ok",
			item: {
				id: "drive-root-id",
				driveType: "business",
				provider: "onedrive",
				parentPath: null,
			},
		});
	});

	it("returns the status of a failed lookup", async () => {
		const { graphFetch } = graphRoutes({});

		expect(
			await getDriveItemDetails({
				graphFetch,
				graphBaseUrl: GRAPH,
				driveId: "drive-1",
				itemId: "folder-gone",
			}),
		).toEqual({
			status: "failed",
			httpStatus: 404,
			retryAfterSeconds: null,
		});
	});
});

describe("lookupDriveItemsInFolder", () => {
	const item = (id: string, parentId?: string) => () =>
		json({
			id,
			parentReference: {
				driveId: "drive-1",
				...(parentId ? { id: parentId } : {}),
			},
		});

	it("tells a deleted item, one moved out, one still inside and one it could not read apart", async () => {
		const { graphFetch, urls } = graphRoutes({
			"/drives/drive-1/items/folder-root": item(
				"folder-root",
				"drive-root-id",
			),
			"/drives/drive-1/items/file-moved": item(
				"file-moved",
				"folder-elsewhere",
			),
			"/drives/drive-1/items/folder-elsewhere": item(
				"folder-elsewhere",
				"drive-root-id",
			),
			"/drives/drive-1/items/drive-root-id": item("drive-root-id"),
			"/drives/drive-1/items/file-inside": item(
				"file-inside",
				"folder-sub",
			),
			"/drives/drive-1/items/file-inside-2": item(
				"file-inside-2",
				"folder-sub",
			),
			"/drives/drive-1/items/folder-sub": item(
				"folder-sub",
				"folder-root",
			),
			"/drives/drive-1/items/file-busy": () =>
				json({ error: { code: "serviceNotAvailable" } }, 503),
		});

		const result = await lookupDriveItemsInFolder({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			folderItemId: "folder-root",
			itemIds: [
				"file-gone",
				"file-moved",
				"file-inside",
				"file-inside-2",
				"file-busy",
			],
		});

		expect(result).toEqual({
			items: [
				{ itemId: "file-gone", state: "gone" },
				{ itemId: "file-moved", state: "outside" },
				{ itemId: "file-inside", state: "inside" },
				{ itemId: "file-inside-2", state: "inside" },
				{
					itemId: "file-busy",
					state: "unknown",
					httpStatus: 503,
					retryAfterSeconds: null,
				},
			],
		});
		// A shared parent folder is read once.
		expect(
			urls.filter((url) => url.includes("/items/folder-sub?")),
		).toHaveLength(1);
	});

	it("counts an item below the depth limit as outside", async () => {
		const { graphFetch } = graphRoutes({
			"/drives/drive-1/items/folder-root": item("folder-root"),
			"/drives/drive-1/items/file-ok": item("file-ok", "folder-a"),
			"/drives/drive-1/items/file-deep": item("file-deep", "folder-b"),
			"/drives/drive-1/items/folder-b": item("folder-b", "folder-a"),
			"/drives/drive-1/items/folder-a": item("folder-a", "folder-root"),
		});

		const result = await lookupDriveItemsInFolder({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			folderItemId: "folder-root",
			itemIds: ["file-ok", "file-deep"],
			maxDepth: 1,
		});

		expect(result.items).toEqual([
			{ itemId: "file-ok", state: "inside" },
			{ itemId: "file-deep", state: "outside" },
		]);
	});

	it("stops looking up once Graph keeps throttling, leaving the rest unknown", async () => {
		const { graphFetch, urls } = graphRoutes({
			"/drives/drive-1/items/folder-root": item("folder-root"),
			"/drives/drive-1/items/file-1": () =>
				new Response("{}", {
					status: 429,
					headers: { "Retry-After": "30" },
				}),
		});

		const result = await lookupDriveItemsInFolder({
			graphFetch,
			graphBaseUrl: GRAPH,
			driveId: "drive-1",
			folderItemId: "folder-root",
			itemIds: ["file-1", "file-2"],
		});

		expect(result.items).toEqual([
			{
				itemId: "file-1",
				state: "unknown",
				httpStatus: 429,
				retryAfterSeconds: 30,
			},
			{
				itemId: "file-2",
				state: "unknown",
				httpStatus: 429,
				retryAfterSeconds: 30,
			},
		]);
		expect(urls.some((url) => url.includes("file-2"))).toBe(false);
	});
});
