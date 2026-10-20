import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAzureDevOpsAssignedStories } from "../src/azure-devops/assigned-stories";
import { getAzureDevOpsStorySnapshots } from "../src/azure-devops/story-snapshots";

const target = { organization: "example-org", projectId: "project-1" };
const project = { id: "project-1", name: "Example Project" };
const asOf = "2026-01-01T12:00:00.0001234Z";
const fetchMock = vi.fn<typeof fetch>();
const json = (value: unknown) =>
	new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
	});
const comment = (id: number, text = "Full comment", version = 1) => ({
	id,
	workItemId: 1,
	version,
	text,
	modifiedDate: asOf,
	isDeleted: false,
});
const page = (
	comments: unknown[],
	totalCount = comments.length,
	continuationToken?: string,
) => ({
	comments,
	count: comments.length,
	totalCount,
	continuationToken,
});
const story = (id: number, fields: Record<string, unknown> = {}) => ({
	id,
	rev: 7,
	fields: {
		"System.TeamProject": project.name,
		"System.WorkItemType": "User Story",
		"System.Title": `Story ${id}`,
		"System.State": "Active",
		"System.AssignedTo": {
			uniqueName: "member@example.com",
			displayName: "Example Member",
		},
		"System.ChangedDate": asOf,
		"System.Description": "Complete requirement",
		"Microsoft.VSTS.Common.AcceptanceCriteria": "Full acceptance criteria",
		...fields,
	},
});
function fixture(url: URL): unknown {
	if (url.pathname.includes("/_apis/projects/")) {
		return project;
	}
	if (url.pathname.endsWith("/comments")) {
		return page([]);
	}
	if (url.pathname.endsWith("/wiql")) {
		return { asOf, workItems: [] };
	}
	return {
		value: url.searchParams
			.get("ids")
			?.split(",")
			.map((id) => story(Number(id))),
	};
}
const snapshots = (ids: number[] = [1]) =>
	getAzureDevOpsStorySnapshots(target, "example-pat", {
		ids,
		requirementsAsOf: asOf,
	});
function mockApi(handler: (url: URL, options?: RequestInit) => unknown) {
	fetchMock.mockImplementation(async (input, options) => {
		const body = handler(new URL(String(input)), options);
		return body instanceof Response ? body : json(body);
	});
}

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockReset();
	mockApi(fixture);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("assigned story enumeration", () => {
	it.each([49, 50, 51])(
		"bounds enumeration at 50 and probes before declaring completeness for %i matches",
		async (count) => {
			mockApi((url, options) => {
				if (!url.pathname.endsWith("/wiql")) {
					return fixture(url);
				}
				const query = JSON.parse(String(options?.body)).query;
				const after = Number(query.match(/\[System.Id\] > (\d+)/)[1]);
				return {
					asOf,
					workItems: Array.from({ length: count }, (_, i) => ({
						id: i + 1,
					}))
						.filter((item) => item.id > after)
						.slice(0, Number(url.searchParams.get("$top"))),
				};
			});
			const result = await listAzureDevOpsAssignedStories(
				target,
				"example-pat",
				{
					assignee: { mode: "current" },
					limit: 50,
				},
			);
			expect(result.ids).toHaveLength(Math.min(count, 50));
			expect(result.complete).toBe(count <= 50);
			expect(result.incompleteReason).toBe(
				count <= 50 ? null : "item_limit",
			);
			expect(result.cursor).toEqual(
				count <= 50 ? null : { afterId: 50, requirementsAsOf: asOf },
			);
			if (count >= 50) {
				const probe = new URL(String(fetchMock.mock.calls[2][0]));
				expect(probe.searchParams.get("$top")).toBe("1");
				expect(
					JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).query,
				).toContain(`ASOF '${asOf}'`);
			}
		},
	);

	it.each([0, -1, 1.5, 1_001, Number.NaN])(
		"rejects an invalid enumeration limit %s before fetch",
		async (limit) => {
			await expect(
				listAzureDevOpsAssignedStories(target, "example-pat", {
					assignee: { mode: "current" },
					limit,
				}),
			).rejects.toMatchObject({ code: "invalid_filter" });
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("uses server @Me and fixed User Story filtering without guessing identity", async () => {
		expect(
			await listAzureDevOpsAssignedStories(target, "example-pat", {
				assignee: { mode: "current" },
			}),
		).toMatchObject({ ids: [], complete: true, requirementsAsOf: asOf });
		const options = fetchMock.mock.calls[1][1];
		const query = JSON.parse(String(options?.body)).query;
		expect(query).toContain("[System.AssignedTo] = @Me");
		expect(query).toContain("[System.TeamProject] = @project");
		expect(query).toContain("[System.WorkItemType] IN ('User Story')");
		expect(query).not.toContain("example.com");
	});

	it("quotes selected members and configured types without accepting caller WIQL", async () => {
		await listAzureDevOpsAssignedStories(target, "example-pat", {
			assignee: { mode: "selected", uniqueName: "o'neil@example.com" },
			workItemTypes: ["Product Backlog Item", "User Story"],
		});
		const query = JSON.parse(
			String(fetchMock.mock.calls[1][1]?.body),
		).query;
		expect(query).toContain('[System.AssignedTo] = "o\'neil@example.com"');
		expect(query).toContain("IN ('Product Backlog Item', 'User Story')");
	});

	it.each(["bad'\"name", "line\nbreak", ""])(
		"rejects unsafe selected identity %j before fetch",
		async (uniqueName) => {
			await expect(
				listAzureDevOpsAssignedStories(target, "example-pat", {
					assignee: { mode: "selected", uniqueName },
				}),
			).rejects.toMatchObject({ code: "invalid_filter" });
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("paginates increasing IDs at one precise ASOF and supports an explicit resume cursor", async () => {
		let wiqlCalls = 0;
		mockApi((url) =>
			url.pathname.endsWith("/wiql")
				? {
						asOf,
						workItems:
							++wiqlCalls === 1
								? Array.from({ length: 200 }, (_, i) => ({
										id: i + 1,
									}))
								: [{ id: 201 }],
					}
				: fixture(url),
		);
		const result = await listAzureDevOpsAssignedStories(
			target,
			"example-pat",
			{
				assignee: { mode: "current" },
			},
		);
		expect(result).toMatchObject({
			complete: true,
			requirementsAsOf: asOf,
		});
		expect(result.ids).toHaveLength(201);
		const secondQuery = JSON.parse(
			String(fetchMock.mock.calls[2][1]?.body),
		).query;
		expect(secondQuery).toContain("[System.Id] > 200");
		expect(secondQuery).toContain(`ASOF '${asOf}'`);
		fetchMock.mockClear();
		mockApi(fixture);
		await listAzureDevOpsAssignedStories(target, "example-pat", {
			assignee: { mode: "current" },
			cursor: { afterId: 201, requirementsAsOf: asOf },
		});
		expect(
			JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).query,
		).toContain(`ASOF '${asOf}'`);
	});

	it("marks a changing ASOF or non-increasing ID response incomplete", async () => {
		mockApi((url) =>
			url.pathname.endsWith("/wiql")
				? { asOf, workItems: [{ id: 2 }, { id: 1 }] }
				: fixture(url),
		);
		expect(
			await listAzureDevOpsAssignedStories(target, "example-pat", {
				assignee: { mode: "current" },
			}),
		).toMatchObject({
			complete: false,
			incompleteReason: "invalid_response",
		});
		mockApi((url) =>
			url.pathname.endsWith("/wiql")
				? { asOf: "2026-01-02T00:00:00Z", workItems: [] }
				: fixture(url),
		);
		expect(
			await listAzureDevOpsAssignedStories(target, "example-pat", {
				assignee: { mode: "current" },
				cursor: { afterId: 2, requirementsAsOf: asOf },
			}),
		).toMatchObject({
			complete: false,
			incompleteReason: "invalid_response",
		});
	});

	it("returns a resumable item-limit result rather than claiming a truncated list is complete", async () => {
		mockApi((url, options) => {
			if (!url.pathname.endsWith("/wiql")) {
				return fixture(url);
			}
			const query = JSON.parse(String(options?.body)).query;
			const after = Number(query.match(/\[System.Id\] > (\d+)/)[1]);
			return {
				asOf,
				workItems: Array.from(
					{ length: Number(url.searchParams.get("$top")) },
					(_, i) => ({ id: after + i + 1 }),
				),
			};
		});
		expect(
			await listAzureDevOpsAssignedStories(target, "example-pat", {
				assignee: { mode: "current" },
			}),
		).toMatchObject({
			complete: false,
			incompleteReason: "item_limit",
			cursor: { afterId: 1000, requirementsAsOf: asOf },
		});
	});
});

describe("project-bound requirement and comment snapshots", () => {
	it("preserves full fields, safe source URLs, revision and separate comment capture metadata", async () => {
		const result = await snapshots();
		expect(result).toMatchObject({
			complete: true,
			unreadIds: [],
			requirementsAsOf: asOf,
		});
		expect(result.snapshots[0]).toMatchObject({
			id: 1,
			rev: 7,
			state: "Active",
			changedDate: asOf,
			requirements: {
				"System.Description": "Complete requirement",
				"Microsoft.VSTS.Common.AcceptanceCriteria":
					"Full acceptance criteria",
			},
			sourceUrl:
				"https://dev.azure.com/example-org/project-1/_workitems/edit/1",
			comments: {
				complete: true,
				comments: [],
				consistency: "two_matching_reads",
				atomicAsOf: false,
			},
		});
		const historical = fetchMock.mock.calls
			.map(([url]) => new URL(String(url)))
			.find((url) => url.searchParams.has("asOf"));
		expect(historical?.searchParams.get("asOf")).toBe(asOf);
		expect(historical?.searchParams.get("errorPolicy")).toBe("Fail");
		expect(result.snapshots[0].comments.capturedAt).toMatch(/^\d{4}-/);
	});

	it("retains over 20 comments and over 1000 characters using actual continuation tokens", async () => {
		const first = Array.from({ length: 25 }, (_, i) =>
			comment(i + 1, "x".repeat(1501)),
		);
		const last = { ...comment(26, "Edited comment", 3), isDeleted: true };
		mockApi((url) => {
			if (!url.pathname.endsWith("/comments")) {
				return fixture(url);
			}
			return url.searchParams.has("continuationToken")
				? page([last], 26)
				: {
						...page(first, 26, "opaque+/token"),
						nextPage: "https://other.example/never-fetch",
					};
		});
		const result = await snapshots();
		expect(result.complete).toBe(true);
		expect(result.snapshots[0].comments.comments).toHaveLength(26);
		expect(result.snapshots[0].comments.comments[0].fullText).toHaveLength(
			1501,
		);
		expect(result.snapshots[0].comments.comments[25]).toMatchObject({
			id: 26,
			version: 3,
			isDeleted: true,
			fullText: "Edited comment",
		});
		const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
		expect(
			urls.every((url) => url.origin === "https://dev.azure.com"),
		).toBe(true);
		expect(
			urls
				.filter((url) => url.pathname.endsWith("/comments"))
				.every(
					(url) =>
						url.searchParams.get("includeDeleted") === "true" &&
						url.searchParams.get("api-version") === "7.1-preview.4",
				),
		).toBe(true);
		expect(
			urls.filter(
				(url) =>
					url.searchParams.get("continuationToken") ===
					"opaque+/token",
			),
		).toHaveLength(2);
	});

	it("accepts the documented commentId example but refuses conflicting ID aliases", async () => {
		const { id: _id, ...value } = comment(1);
		mockApi((url) =>
			url.pathname.endsWith("/comments")
				? page([{ ...value, commentId: 1 }])
				: fixture(url),
		);
		expect((await snapshots()).complete).toBe(true);
		mockApi((url) =>
			url.pathname.endsWith("/comments")
				? page([{ ...comment(1), commentId: 2 }])
				: fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "invalid_response",
		});
	});

	it("captures markdown comments when the provider omits the deletion flag", async () => {
		const text = "## Clarification\n\nKeep **all** requirement details.";
		const { isDeleted: _isDeleted, ...value } = comment(1, text, 3);
		const providerComment = {
			...value,
			createdBy: { displayName: "Example Member" },
			createdDate: asOf,
			modifiedBy: { displayName: "Example Member" },
			format: "markdown",
			renderedText: "<h2>Clarification</h2>",
			mentions: [],
			url: "https://dev.azure.com/example-org/project-1/_apis/wit/workItems/1/comments/1",
		};
		mockApi((url) =>
			url.pathname.endsWith("/comments")
				? page([providerComment])
				: fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: true,
			snapshots: [
				{
					comments: {
						complete: true,
						consistency: "two_matching_reads",
						comments: [
							{
								id: 1,
								version: 3,
								modifiedDate: asOf,
								isDeleted: false,
								fullText: text,
								format: "markdown",
							},
						],
					},
				},
			],
		});
		expect(
			fetchMock.mock.calls.filter(([url]) =>
				new URL(String(url)).pathname.endsWith("/comments"),
			),
		).toHaveLength(2);
	});

	it.each([null, "false", 0, {}, []])(
		"refuses an explicitly malformed deletion flag %j",
		async (isDeleted) => {
			mockApi((url) =>
				url.pathname.endsWith("/comments")
					? page([{ ...comment(1), isDeleted }])
					: fixture(url),
			);
			expect(await snapshots()).toMatchObject({
				complete: false,
				incompleteReason: "invalid_response",
			});
		},
	);

	it.each([null, undefined])(
		"refuses missing comment text %s without an explicit deletion marker",
		async (text) => {
			const { isDeleted: _isDeleted, ...value } = comment(1);
			mockApi((url) =>
				url.pathname.endsWith("/comments")
					? page([{ ...value, text }])
					: fixture(url),
			);
			expect(await snapshots()).toMatchObject({
				complete: false,
				incompleteReason: "invalid_response",
			});
		},
	);

	it("detects a deletion-only change after an omitted deletion flag", async () => {
		let calls = 0;
		const { isDeleted: _isDeleted, ...value } = comment(1);
		mockApi((url) =>
			url.pathname.endsWith("/comments")
				? page([++calls === 1 ? value : { ...value, isDeleted: true }])
				: fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "concurrent_changes",
		});
	});

	it("retains an explicit deletion marker when the provider omits comment text", async () => {
		const { text: _text, ...value } = comment(1, "Deleted text", 3);
		mockApi((url) =>
			url.pathname.endsWith("/comments")
				? page([{ ...value, isDeleted: true }])
				: fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: true,
			snapshots: [
				{
					comments: {
						comments: [
							{ version: 3, isDeleted: true, fullText: null },
						],
					},
				},
			],
		});
	});

	it("detects an edited or deleted comment even if work-item revision and ChangedDate stay unchanged", async () => {
		let calls = 0;
		mockApi((url) =>
			url.pathname.endsWith("/comments")
				? page([
						{
							...comment(
								1,
								++calls === 1 ? "Before" : "After",
								calls,
							),
							isDeleted: calls > 1,
						},
					])
				: fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "concurrent_changes",
			snapshots: [{ complete: false, rev: 7 }],
		});
	});

	it.each([false, true])(
		"refuses a cross-project global ID in current or historical reads: historical=%s",
		async (historical) => {
			mockApi((url) =>
				url.pathname.endsWith("/workitems") &&
				url.searchParams.has("asOf") === historical
					? {
							value: [
								story(1, {
									"System.TeamProject": "Other Project",
								}),
							],
						}
					: fixture(url),
			);
			await expect(snapshots()).rejects.toMatchObject({
				code: "project_mismatch",
			});
			expect(
				fetchMock.mock.calls.some(([url]) =>
					String(url).includes("/comments"),
				),
			).toBe(false);
		},
	);

	it("refuses an item moved out of the project during comment capture", async () => {
		let currentReads = 0;
		mockApi((url) => {
			if (
				url.pathname.endsWith("/workitems") &&
				!url.searchParams.has("asOf") &&
				++currentReads > 1
			) {
				return {
					value: [
						story(1, { "System.TeamProject": "Other Project" }),
					],
				};
			}
			return fixture(url);
		});
		await expect(snapshots()).rejects.toMatchObject({
			code: "project_mismatch",
		});
	});

	it("retains complete configured string fields and explicit absent requirements", async () => {
		mockApi((url) =>
			url.pathname.endsWith("/workitems")
				? {
						value: [
							story(1, {
								"Custom.ReviewNotes": "x".repeat(5000),
							}),
						],
					}
				: fixture(url),
		);
		const result = await getAzureDevOpsStorySnapshots(
			target,
			"example-pat",
			{
				ids: [1],
				requirementsAsOf: asOf,
				requirementFields: [
					"Custom.ReviewNotes",
					"Custom.MissingNotes",
				],
			},
		);
		expect(result.complete).toBe(true);
		expect(
			result.snapshots[0].requirements["Custom.ReviewNotes"],
		).toHaveLength(5000);
		expect(
			result.snapshots[0].requirements["Custom.MissingNotes"],
		).toBeNull();
	});

	it("paginates work-item batches with the same ASOF and a strict batch size", async () => {
		await snapshots(Array.from({ length: 51 }, (_, i) => i + 1));
		const historical = fetchMock.mock.calls
			.map(([url]) => new URL(String(url)))
			.filter((url) => url.searchParams.has("asOf"));
		expect(historical).toHaveLength(2);
		expect(
			historical.map(
				(url) => url.searchParams.get("ids")?.split(",").length,
			),
		).toEqual([50, 1]);
		expect(
			historical.every((url) => url.searchParams.get("asOf") === asOf),
		).toBe(true);
	});

	it("detects a changed total during pagination and accepts deleted comments without retained text", async () => {
		let calls = 0;
		mockApi((url) => {
			if (!url.pathname.endsWith("/comments")) {
				return fixture(url);
			}
			return ++calls === 1
				? page([comment(1)], 2, "next")
				: page([comment(2)], 3);
		});
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "concurrent_changes",
		});
		mockApi((url) =>
			url.pathname.endsWith("/comments")
				? page([{ ...comment(1), text: null, isDeleted: true }])
				: fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: true,
			snapshots: [
				{
					comments: {
						comments: [{ fullText: null, isDeleted: true }],
					},
				},
			],
		});
	});

	it.each([203, 401, 403, 302])(
		"refuses authentication, permission and redirects without exposing upstream bodies: %s",
		async (status) => {
			mockApi(() => new Response("private upstream text", { status }));
			if (status === 302) {
				expect(await snapshots()).toMatchObject({
					complete: false,
					incompleteReason: "unavailable",
				});
			} else {
				await expect(snapshots()).rejects.toMatchObject({
					code: status === 403 ? "permission" : "authentication",
				});
			}
			expect(
				fetchMock.mock.calls.every(
					([, options]) => options?.redirect === "error",
				),
			).toBe(true);
		},
	);

	it("distinguishes failed comments from a successful empty comment list", async () => {
		mockApi((url) =>
			url.pathname.endsWith("/comments")
				? new Response("provider detail", { status: 500 })
				: fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "unavailable",
			snapshots: [
				{ comments: { complete: false, consistency: "unconfirmed" } },
			],
		});
	});

	it.each([
		{ comments: [], count: 0, totalCount: 1 },
		{
			comments: [],
			count: 0,
			totalCount: 0,
			nextPage: "https://other.example/next",
		},
		page([{ ...comment(1), text: undefined }]),
		page([{ ...comment(1), text: null }]),
		page([{ ...comment(1), version: 0 }]),
		page([{ ...comment(1), workItemId: 2 }]),
		page([{ ...comment(1), modifiedDate: "invalid" }]),
	])("marks malformed or omitted comment data incomplete", async (body) => {
		mockApi((url) =>
			url.pathname.endsWith("/comments") ? body : fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "invalid_response",
		});
	});

	it("refuses repeated continuation tokens and does not follow arbitrary nextPage URLs", async () => {
		let id = 0;
		mockApi((url) =>
			url.pathname.endsWith("/comments")
				? page([comment(++id)], 3, "same-token")
				: fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "invalid_response",
		});
	});

	it("bounds comment pages, item counts and response bytes explicitly", async () => {
		let id = 0;
		mockApi((url) =>
			url.pathname.endsWith("/comments")
				? page([comment(++id)], 100, String(id))
				: fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "page_limit",
		});
		mockApi((url) =>
			url.pathname.endsWith("/comments") ? page([], 1001) : fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "item_limit",
		});
		mockApi((url) =>
			url.pathname.endsWith("/comments")
				? page([comment(1, "x".repeat(2 * 1024 * 1024))])
				: fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "response_limit",
		});
	});

	it("bounds aggregate decoded characters without returning a complete truncated snapshot", async () => {
		mockApi((url) => {
			if (!url.pathname.endsWith("/comments")) {
				return fixture(url);
			}
			const id = Number(url.searchParams.get("continuationToken") ?? "1");
			return page(
				[comment(id, "x".repeat(1_700_000))],
				2,
				id === 1 ? "2" : undefined,
			);
		});
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "character_limit",
		});
	});

	it("cancels an oversized streamed response before consuming an unbounded body", async () => {
		let chunks = 0;
		const cancel = vi.fn();
		mockApi((url) => {
			if (!url.pathname.endsWith("/comments")) {
				return fixture(url);
			}
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						chunks++;
						controller.enqueue(
							new TextEncoder().encode("x".repeat(750_000)),
						);
					},
					cancel,
				}),
			);
		});
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "response_limit",
		});
		expect(cancel).toHaveBeenCalledOnce();
		expect(chunks).toBeLessThan(6);
	});

	it("refuses malformed UTF-8 instead of silently replacing source content", async () => {
		mockApi(() => new Response(new Uint8Array([0xff])));
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "invalid_response",
		});
	});

	it("bounds aggregate UTF-8 response bytes separately from decoded characters", async () => {
		mockApi((url) => {
			if (!url.pathname.endsWith("/comments")) {
				return fixture(url);
			}
			const id = Number(url.searchParams.get("continuationToken") ?? "1");
			return page(
				[comment(id, "界".repeat(500_000))],
				3,
				id < 3 ? String(id + 1) : undefined,
			);
		});
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "total_response_limit",
		});
	});

	it("marks request-budget exhaustion incomplete and identifies unread items", async () => {
		const result = await snapshots(
			Array.from({ length: 30 }, (_, i) => i + 1),
		);
		expect(result).toMatchObject({
			complete: false,
			incompleteReason: "request_limit",
		});
		expect(result.snapshots).toEqual([]);
		expect(result.unreadIds).toHaveLength(30);
		expect(fetchMock).toHaveBeenCalledTimes(40);
	});

	it("marks elapsed total time incomplete", async () => {
		let now = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		mockApi((url) => {
			now += 26_000;
			return fixture(url);
		});
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "time_limit",
		});
	});

	it("does not masquerade invalid JSON, missing IDs or non-string requirements as complete", async () => {
		mockApi(() => new Response("not-json"));
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "invalid_response",
		});
		mockApi((url) =>
			url.pathname.endsWith("/workitems") ? { value: [] } : fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "invalid_response",
		});
		mockApi((url) =>
			url.pathname.endsWith("/workitems")
				? {
						value: [
							story(1, {
								"System.Description": { unexpected: true },
							}),
						],
					}
				: fixture(url),
		);
		expect(await snapshots()).toMatchObject({
			complete: false,
			incompleteReason: "invalid_response",
		});
	});

	it("refuses caller-controlled origins and invalid configured field names before sending credentials", async () => {
		await expect(
			getAzureDevOpsStorySnapshots(
				{ ...target, organization: "https://other.example" },
				"example-pat",
				{ ids: [1], requirementsAsOf: asOf },
			),
		).rejects.toMatchObject({ code: "invalid_response" });
		await expect(
			getAzureDevOpsStorySnapshots(target, "example-pat", {
				ids: [1],
				requirementsAsOf: asOf,
				requirementFields: ["System.Title,Other.Field"],
			}),
		).rejects.toMatchObject({ code: "invalid_filter" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not return raw network errors or credentials in incomplete results", async () => {
		fetchMock.mockRejectedValue(
			new Error("example-private-pat provider detail"),
		);
		const result = await snapshots();
		expect(result).toMatchObject({
			complete: false,
			incompleteReason: "unavailable",
		});
		expect(JSON.stringify(result)).not.toContain("example-private-pat");
		expect(JSON.stringify(result)).not.toContain("provider detail");
	});
});
