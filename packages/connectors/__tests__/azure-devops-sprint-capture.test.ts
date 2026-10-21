import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAzureDevOpsAssignedStories } from "../src/azure-devops/assigned-stories";
import { captureAzureDevOpsSprintStories } from "../src/azure-devops/sprint-capture";
import { sprintRelationItemId } from "../src/azure-devops/sprint-selection";
import { getAzureDevOpsStorySnapshots } from "../src/azure-devops/story-snapshots";
import {
	asOf,
	type FixtureItem,
	item,
	json,
	link,
	member,
	options,
	other,
	project,
	sprintFixture,
	target,
	taskTypes,
} from "./helpers/azure-devops-sprint-fixture";

const fetchMock = vi.fn<typeof fetch>();
let items: Map<number, FixtureItem>;
let discoveryIds: number[];
let override: ((url: URL, init?: RequestInit) => unknown) | undefined;

function fixture(url: URL, init?: RequestInit): unknown {
	return sprintFixture(url, init, items, discoveryIds);
}
const capture = (input = options()) =>
	captureAzureDevOpsSprintStories(target, "example-pat", input);

beforeEach(() => {
	items = new Map([
		[1, item(1, "DevBE Task", {}, [link(100)])],
		[
			2,
			item(
				2,
				"QA Task",
				{
					"System.AssignedTo": other,
					"Custom.Engineer": member.uniqueName,
					"System.IterationPath": "Example Project\\Sprint 1",
				},
				[link(100)],
			),
		],
		[3, item(3, "ToDo Task", {}, [link(300)])],
		[
			4,
			item(
				4,
				"DevFE Task",
				{ "System.IterationPath": "Example Project\\Sprint 0" },
				[link(300)],
			),
		],
		[
			100,
			item(100, "User Story", {}, [
				link(200, "System.LinkTypes.Hierarchy-Forward"),
				link(200, "System.LinkTypes.Hierarchy-Forward"),
				link(201, "System.LinkTypes.Related"),
			]),
		],
		[
			200,
			item(200, "AA Task", {}, [link(202, "System.LinkTypes.Related")]),
		],
		[201, item(201, "Bug")],
		[202, item(202, "Task")],
		[300, item(300, "User Story")],
	]);
	discoveryIds = [1, 2, 3, 4];
	override = undefined;
	fetchMock.mockReset();
	fetchMock.mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		const body = override?.(url, init) ?? fixture(url, init);
		return body instanceof Response ? body : json(body);
	});
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("sprint graph capture", () => {
	it("captures two sprints and each item's own requirements/comments", async () => {
		const result = await capture();
		expect(result).toMatchObject({
			complete: true,
			discoveryComplete: true,
			requirementsAsOf: asOf,
			incompleteReason: null,
			unreadItemIds: [],
		});
		expect(result.assignedItems.map((value) => value.id)).toEqual([
			1, 2, 3,
		]);
		expect(result.assignedItems[0]).toMatchObject({
			discovery: { matchedAssignmentFields: ["System.AssignedTo"] },
			parentResolution: "parent_followed",
			storyIds: [100],
		});
		expect(result.assignedItems[1]).toMatchObject({
			engineer: member.uniqueName,
			discovery: { matchedAssignmentFields: ["Custom.Engineer"] },
			storyIds: [100],
		});
		expect(result.assignedItems[2]).toMatchObject({
			parentResolution: "parent_source_excluded",
			storyIds: [],
			parentCandidates: [],
		});
		expect(result.stories).toHaveLength(1);
		expect(result.stories[0]?.discoverySources).toEqual([
			{ assignedItemId: 1, kind: "parent" },
			{ assignedItemId: 2, kind: "parent" },
		]);
		expect(result.stories[0]?.edges).toEqual([
			{ sourceId: 100, targetId: 200, kind: "child" },
			{ sourceId: 100, targetId: 201, kind: "related" },
		]);
		expect(
			result.stories[0]?.contextItems.map((value) => value.id),
		).toEqual([200, 201]);
		for (const snapshot of [
			result.stories[0]?.story,
			...(result.stories[0]?.contextItems ?? []),
		]) {
			expect(snapshot).toMatchObject({
				complete: true,
				requirementsAsOf: asOf,
				requirements: {
					"System.Description": "TBD",
					"Custom.BusinessRules": `Full specification ${snapshot?.id}`,
				},
				comments: {
					complete: true,
					consistency: "two_matching_reads",
					atomicAsOf: false,
					comments: [
						{
							id: 1,
							version: 3,
							fullText: `Item ${snapshot?.id} own PO answer`,
						},
					],
				},
			});
			expect(snapshot?.sourceUrl).toBe(
				`https://dev.azure.com/example-org/project-1/_workitems/edit/${snapshot?.id}`,
			);
		}
		const calls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
		expect(
			calls.every(
				(url) =>
					url.origin === "https://dev.azure.com" &&
					url.pathname.startsWith("/example-org/"),
			),
		).toBe(true);
		expect(
			calls
				.filter((url) => url.pathname.endsWith("/workitems"))
				.every(
					(url) =>
						url.pathname ===
							"/example-org/project-1/_apis/wit/workitems" &&
						url.searchParams.get("errorPolicy") === "Fail",
				),
		).toBe(true);
		expect(
			calls
				.filter((url) => url.searchParams.has("asOf"))
				.every((url) => url.searchParams.get("asOf") === asOf),
		).toBe(true);
		const historical = calls.filter((url) => url.searchParams.has("asOf"));
		expect(historical).toHaveLength(6);
		for (let index = 0; index < historical.length; index += 2) {
			const fields = historical[index];
			const expanded = historical[index + 1];
			expect(fields?.searchParams.has("fields")).toBe(true);
			expect(fields?.searchParams.has("$expand")).toBe(false);
			expect(expanded?.searchParams.get("$expand")).toBe("relations");
			expect(expanded?.searchParams.has("fields")).toBe(false);
			expect(expanded?.searchParams.get("ids")).toBe(
				fields?.searchParams.get("ids"),
			);
		}
		expect(fetchMock).toHaveBeenCalledTimes(18);
		expect(
			calls.some((url) =>
				url.searchParams
					.get("ids")
					?.split(",")
					.some((id) => ["202", "300"].includes(id)),
			),
		).toBe(false);
		const query = JSON.parse(
			String(fetchMock.mock.calls[1]?.[1]?.body),
		).query;
		expect(query).toContain(
			"[System.IterationPath] IN ('Example Project\\Sprint 2', 'Example Project\\Sprint 1')",
		);
		expect(query).toContain(
			"([System.AssignedTo] = 'engineer@example.com' OR [Custom.Engineer] = 'engineer@example.com')",
		);
		expect(query).toContain("[System.State] NOT IN ('Removed')");
		expect(query).not.toContain("WorkItemLinks");
	});

	it("keeps selected fields authoritative over expanded fields and extra provider data", async () => {
		discoveryIds = [1];
		const input = options();
		input.selection.assignmentFields = ["System.AssignedTo"];
		override = (url, init) => {
			if (!url.searchParams.has("asOf")) {
				return undefined;
			}
			const body = fixture(url, init);
			if (
				typeof body !== "object" ||
				body === null ||
				!("value" in body) ||
				!Array.isArray(body.value)
			) {
				throw new Error("Invalid fixture");
			}
			return {
				value: body.value.map((entry) => ({
					...entry,
					fields: {
						...entry.fields,
						"Custom.Engineer": "unselected-provider-value",
						"Custom.Extra": "unselected-provider-value",
						...(url.searchParams.has("$expand")
							? { "System.Description": "expanded-field-value" }
							: {}),
					},
				})),
			};
		};
		const result = await capture(input);
		expect(result.complete).toBe(true);
		expect(result.assignedItems[0]?.engineer).toBeNull();
		expect(result.stories[0]?.story.requirements).toEqual({
			"System.Description": "TBD",
			"Custom.BusinessRules": "Full specification 100",
		});
		expect(result.stories[0]?.edges).toHaveLength(2);
		expect(JSON.stringify(result)).not.toMatch(
			/unselected-provider-value|expanded-field-value/,
		);
	});

	it.each([1, 100, 200])(
		"rejects a mismatched expanded revision for item %i",
		async (id) => {
			override = (url, init) => {
				if (!url.searchParams.has("$expand")) {
					return undefined;
				}
				const body = fixture(url, init);
				if (
					typeof body !== "object" ||
					body === null ||
					!("value" in body) ||
					!Array.isArray(body.value)
				) {
					throw new Error("Invalid fixture");
				}
				return {
					value: body.value.map((entry) =>
						entry.id === id
							? { ...entry, rev: entry.rev + 1 }
							: entry,
					),
				};
			};
			expect(await capture()).toMatchObject({
				complete: false,
				incompleteReason: "invalid_response",
				stories: [],
			});
		},
	);

	it("preserves provider validation of unknown selected fields before expansion", async () => {
		const input = options();
		input.requirementFields = ["Custom.UnknownField"];
		override = (url) =>
			url.searchParams.get("fields")?.includes("Custom.UnknownField")
				? new Response(null, { status: 400 })
				: undefined;
		expect(await capture(input)).toMatchObject({
			complete: false,
			incompleteReason: "unavailable",
			stories: [],
		});
		expect(
			fetchMock.mock.calls.some(([url]) =>
				new URL(String(url)).searchParams.has("$expand"),
			),
		).toBe(false);
	});

	it("counts expanded response bytes against the unchanged shared transport budget", async () => {
		override = (url) =>
			url.searchParams.has("$expand")
				? new Response("x".repeat(2 * 1024 * 1024 + 1))
				: undefined;
		expect(await capture()).toMatchObject({
			complete: false,
			incompleteReason: "response_limit",
			stories: [],
		});
	});

	it.each(taskTypes.filter((type) => type !== "ToDo Task"))(
		"can follow the configured %s parent source",
		async (type) => {
			items.set(1, item(1, type, {}, [link(100)]));
			discoveryIds = [1];
			const result = await capture();
			expect(result.complete).toBe(true);
			expect(result.stories[0]?.story.id).toBe(100);
		},
	);

	it("records non-story parent exclusions", async () => {
		items.set(100, item(100, "Feature"));
		const result = await capture();
		expect(result).toMatchObject({ complete: true, stories: [] });
		expect(result.assignedItems[0]).toMatchObject({
			parentResolution: "parent_type_excluded",
			parentCandidates: [
				{ id: 100, workItemType: "Feature", included: false },
			],
		});
	});

	it("keeps per-story edges for shared context", async () => {
		items.set(
			1,
			item(1, "User Story", {}, [link(200, "System.LinkTypes.Related")]),
		);
		const input = options();
		input.selection.assignedItemTypes = [...taskTypes, "User Story"];
		const result = await capture(input);
		expect(result.complete).toBe(true);
		expect(result.stories.map((value) => value.story.id)).toEqual([1, 100]);
		expect(result.stories[0]?.discoverySources).toEqual([
			{ assignedItemId: 1, kind: "direct" },
		]);
		expect(result.stories[0]?.edges).toContainEqual({
			sourceId: 1,
			targetId: 200,
			kind: "related",
		});
		expect(result.stories[1]?.edges).toContainEqual({
			sourceId: 100,
			targetId: 200,
			kind: "child",
		});
		expect(
			fetchMock.mock.calls.filter(([url]) =>
				String(url).includes("workItems/200/comments"),
			),
		).toHaveLength(2);
	});

	it.each([1, 100, 200])(
		"rejects a foreign historical project on assigned/parent/context item %i",
		async (id) => {
			override = (url) => {
				if (
					!url.searchParams.has("asOf") ||
					!url.searchParams
						.get("ids")
						?.split(",")
						.includes(String(id))
				) {
					return undefined;
				}
				return {
					value: (url.searchParams.get("ids") ?? "")
						.split(",")
						.map((raw) => {
							const value = items.get(Number(raw));
							return value?.id === id
								? {
										...value,
										fields: {
											...value.fields,
											"System.TeamProject":
												"Other Project",
										},
									}
								: value;
						}),
				};
			};
			await expect(capture()).rejects.toMatchObject({
				code: "project_mismatch",
			});
		},
	);

	it.each([1, 100, 200])(
		"rejects a foreign current project before reading item %i historically",
		async (id) => {
			const value = items.get(id);
			if (value) {
				value.fields["System.TeamProject"] = "Other Project";
			}
			await expect(capture()).rejects.toMatchObject({
				code: "project_mismatch",
			});
			expect(
				fetchMock.mock.calls.some(([url]) => {
					const requested = new URL(String(url));
					return (
						requested.searchParams.has("asOf") &&
						requested.searchParams
							.get("ids")
							?.split(",")
							.includes(String(id))
					);
				}),
			).toBe(false);
		},
	);

	it.each([1, 100, 200])(
		"rejects a moved assigned/parent/context item %i in the final membership read",
		async (id) => {
			let reads = 0;
			override = (url, init) => {
				if (
					url.searchParams.get("fields") !== "System.TeamProject" ||
					!url.searchParams
						.get("ids")
						?.split(",")
						.includes(String(id))
				) {
					return undefined;
				}
				if (++reads === 1) {
					return undefined;
				}
				const body = fixture(url, init);
				if (
					typeof body !== "object" ||
					body === null ||
					!("value" in body) ||
					!Array.isArray(body.value)
				) {
					throw new Error("Invalid fixture");
				}
				return {
					value: body.value.map((entry) =>
						entry.id === id
							? {
									...entry,
									fields: {
										...entry.fields,
										"System.TeamProject": "Other Project",
									},
								}
							: entry,
					),
				};
			};
			await expect(capture()).rejects.toMatchObject({
				code: "project_mismatch",
			});
		},
	);

	it.each(["missing", "duplicate"])(
		"returns no analysis subset for a %s batch ID",
		async (fault) => {
			override = (url) =>
				url.searchParams.get("asOf") &&
				url.searchParams.get("ids") === "100"
					? {
							value:
								fault === "missing"
									? []
									: [items.get(100), items.get(100)],
						}
					: undefined;
			expect(await capture()).toMatchObject({
				complete: false,
				incompleteReason: "invalid_response",
				stories: [],
			});
		},
	);

	it("rejects duplicated batch IDs even when the batch length matches", async () => {
		override = (url) =>
			url.searchParams.has("asOf") &&
			url.searchParams.get("ids") === "1,2,3"
				? { value: [items.get(1), items.get(1), items.get(3)] }
				: undefined;
		expect(await capture()).toMatchObject({
			complete: false,
			incompleteReason: "invalid_response",
			stories: [],
		});
	});

	it.each([403, 404])(
		"fails closed when context item access returns %i",
		async (status) => {
			override = (url) =>
				url.searchParams.get("ids") === "200,201"
					? new Response(null, { status })
					: undefined;
			if (status === 403) {
				await expect(capture()).rejects.toMatchObject({
					code: "permission",
				});
			} else {
				expect(await capture()).toMatchObject({
					complete: false,
					incompleteReason: "unavailable",
					stories: [],
				});
			}
		},
	);

	it("does not expose a credential or provider error in capture failures", async () => {
		override = (url) => {
			if (url.pathname.endsWith("/wiql")) {
				throw new Error("example-pat SELECT secret provider detail");
			}
			return undefined;
		};
		const result = await capture();
		expect(result).toMatchObject({
			complete: false,
			incompleteReason: "unavailable",
			stories: [],
		});
		expect(JSON.stringify(result)).not.toMatch(
			/example-pat|SELECT|provider detail/,
		);
	});

	it("rejects an unrelated historical iteration even if the server returns it", async () => {
		override = (url) =>
			url.pathname.endsWith("/wiql")
				? { asOf, workItems: [{ id: 4 }] }
				: undefined;
		expect(await capture()).toMatchObject({
			complete: false,
			incompleteReason: "invalid_response",
			stories: [],
		});
	});

	it("rejects changed item-scoped comments", async () => {
		let passes = 0;
		override = (url, init) => {
			if (!url.pathname.endsWith("/workItems/200/comments")) {
				return undefined;
			}
			const body = fixture(url, init);
			if (++passes === 1) {
				return body;
			}
			return {
				totalCount: 1,
				count: 1,
				comments: [
					{
						id: 1,
						workItemId: 200,
						version: 4,
						modifiedDate: asOf,
						text: "Changed answer",
						isDeleted: false,
					},
				],
			};
		};
		expect(await capture()).toMatchObject({
			complete: false,
			incompleteReason: "concurrent_changes",
			stories: [],
		});
	});

	it("refuses an entire oversized model input without truncating requirements", async () => {
		const value = items.get(100);
		if (value) {
			value.fields["Custom.BusinessRules"] = "x".repeat(120_001);
		}
		expect(await capture()).toMatchObject({
			complete: false,
			incompleteReason: "input_limit",
			stories: [],
		});
	});

	it("shares the request budget with all comment captures", async () => {
		discoveryIds = Array.from({ length: 20 }, (_, index) => index + 1);
		for (const id of discoveryIds) {
			items.set(id, item(id, "User Story"));
		}
		const input = options();
		input.selection.assignedItemTypes = ["User Story"];
		input.selection.parentSourceTypes = [];
		expect(await capture(input)).toMatchObject({
			complete: false,
			incompleteReason: "request_limit",
			stories: [],
		});
		expect(fetchMock).toHaveBeenCalledTimes(40);
	});

	it("preserves response byte limits in the shared transport", async () => {
		override = (url) =>
			url.pathname.endsWith("/workItems/200/comments")
				? new Response("x".repeat(2 * 1024 * 1024 + 1))
				: undefined;
		expect(await capture()).toMatchObject({
			complete: false,
			incompleteReason: "response_limit",
			stories: [],
		});
	});

	it.each([
		{ padding: "x".repeat(1_600_000), reason: "character_limit" },
		{ padding: "é".repeat(900_000), reason: "total_response_limit" },
	])(
		"shares the $reason budget across graph comment reads",
		async ({ padding, reason }) => {
			override = (url) => {
				if (!url.pathname.endsWith("/comments")) {
					return undefined;
				}
				return { totalCount: 0, count: 0, comments: [], padding };
			};
			expect(await capture()).toMatchObject({
				complete: false,
				incompleteReason: reason,
				stories: [],
			});
		},
	);

	it("bounds qualifying edges even when a relation is duplicated", async () => {
		const value = items.get(100);
		if (value) {
			value.relations = Array.from({ length: 501 }, () =>
				link(200, "System.LinkTypes.Related"),
			);
		}
		expect(await capture()).toMatchObject({
			complete: false,
			incompleteReason: "edge_limit",
			stories: [],
		});
	});

	it("bounds the configured story count", async () => {
		items.set(2, item(2, "QA Task", {}, [link(300)]));
		const input = options();
		input.maxStories = 1;
		expect(await capture(input)).toMatchObject({
			complete: false,
			incompleteReason: "story_limit",
			stories: [],
		});
	});

	it("bounds distinct graph items across assigned, parent and context sets", async () => {
		const value = items.get(100);
		if (value) {
			value.relations = Array.from({ length: 100 }, (_, index) =>
				link(index + 1_000, "System.LinkTypes.Related"),
			);
		}
		expect(await capture()).toMatchObject({
			complete: false,
			incompleteReason: "item_limit",
			stories: [],
		});
		expect(
			fetchMock.mock.calls.some(([url]) =>
				new URL(String(url)).searchParams.get("ids")?.includes("1000"),
			),
		).toBe(false);
	});

	it.each([100, 101])(
		"pins every discovery page and probes 100 assigned items for %i matches",
		async (count) => {
			discoveryIds = Array.from(
				{ length: count },
				(_, index) => index + 1,
			);
			for (const id of discoveryIds) {
				items.set(id, item(id, "ToDo Task"));
			}
			const result = await capture();
			expect(result).toMatchObject({
				complete: count === 100,
				incompleteReason: count === 100 ? null : "item_limit",
				stories: [],
			});
			const queries = fetchMock.mock.calls.filter(([url]) =>
				String(url).includes("/wiql?"),
			);
			expect(queries).toHaveLength(3);
			expect(
				new URL(String(queries[2]?.[0])).searchParams.get("$top"),
			).toBe("1");
			for (const [, init] of queries.slice(1)) {
				expect(JSON.parse(String(init?.body)).query).toContain(
					`ASOF '${asOf}'`,
				);
			}
		},
	);

	it("rejects a changed discovery watermark", async () => {
		discoveryIds = Array.from({ length: 51 }, (_, index) => index + 1);
		for (const id of discoveryIds) {
			items.set(id, item(id, "ToDo Task"));
		}
		let pages = 0;
		override = (url) => {
			if (!url.pathname.endsWith("/wiql") || ++pages === 1) {
				return undefined;
			}
			return { workItems: [{ id: 51 }], asOf: "2026-01-02T12:00:00Z" };
		};
		expect(await capture()).toMatchObject({
			complete: false,
			discoveryComplete: false,
			incompleteReason: "invalid_response",
			stories: [],
		});
	});
});

describe("sprint selection and source URL boundaries", () => {
	it("checks actual field metadata before using @Me with the engineer field", async () => {
		const input = options();
		input.assignee = { mode: "current" };
		const customAssigned = items.get(2);
		if (customAssigned) {
			customAssigned.fields["Custom.Engineer"] = member;
		}
		expect((await capture(input)).complete).toBe(true);
		const calls = fetchMock.mock.calls;
		expect(String(calls[1]?.[0])).toContain("/fields/Custom.Engineer");
		expect(JSON.parse(String(calls[2]?.[1]?.body)).query).toContain(
			"([System.AssignedTo] = @Me OR [Custom.Engineer] = @Me)",
		);
		expect(JSON.parse(String(calls[2]?.[1]?.body)).query).not.toContain(
			member.uniqueName,
		);
	});

	it("validates malformed context links with the same boundary as parent links", async () => {
		items.set(
			100,
			item(100, "User Story", {}, [
				{
					rel: "System.LinkTypes.Related",
					url: "https://example.invalid/workItems/201",
				},
			]),
		);
		expect(await capture()).toMatchObject({
			complete: false,
			incompleteReason: "invalid_response",
			stories: [],
		});
	});

	it("rejects a nonidentity current predicate without guessing an email", async () => {
		override = (url) =>
			url.pathname.endsWith("/fields/Custom.Engineer")
				? { referenceName: "Custom.Engineer", isIdentity: false }
				: undefined;
		const input = options();
		input.assignee = { mode: "current" };
		await expect(capture(input)).rejects.toMatchObject({
			code: "unsupported_current_predicate",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not require engineer metadata for a selected exact identity", async () => {
		override = (url) =>
			url.pathname.endsWith("/fields/Custom.Engineer")
				? new Response(null, { status: 403 })
				: undefined;
		expect((await capture()).complete).toBe(true);
		expect(
			fetchMock.mock.calls.some(([url]) =>
				String(url).includes("/fields/"),
			),
		).toBe(false);
	});

	it("rejects controls before whitespace normalization", async () => {
		const input = options();
		input.assignee = {
			mode: "selected",
			uniqueName: "\nengineer@example.com",
		};
		await expect(capture(input)).rejects.toMatchObject({
			code: "invalid_filter",
		});
		input.assignee = { mode: "selected", uniqueName: member.uniqueName };
		input.selection.iterationPaths = ["\nExample Project\\Sprint 2"];
		await expect(capture(input)).rejects.toMatchObject({
			code: "invalid_filter",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		"https://example.invalid/example-org/_apis/wit/workItems/100",
		"http://dev.azure.com/example-org/_apis/wit/workItems/100",
		"https://user:secret@dev.azure.com/example-org/_apis/wit/workItems/100",
		"https://dev.azure.com:443/example-org/_apis/wit/workItems/100",
		"https://dev.azure.com/example-org/_apis/wit/workItems/100?api-version=7.1",
		"https://dev.azure.com/example-org/_apis/wit/workItems/100#fragment",
		"https://dev.azure.com/example-org/project-1%2fother/_apis/wit/workItems/100",
		"https://dev.azure.com/example-org/project-1%255cother/_apis/wit/workItems/100",
		"https://dev.azure.com/example-org/../_apis/wit/workItems/100",
		"https://dev.azure.com/example-org/_apis/wit/workItems/2147483648",
		"https://dev.azure.com/example-org/_apis/wit/workItems/0",
		"https://example-org.visualstudio.com/_apis/wit/workItems/100",
	])(
		"rejects malformed/unsupported relation %s before fetching it",
		async (url) => {
			items.set(
				1,
				item(1, "DevBE Task", {}, [
					{ rel: "System.LinkTypes.Hierarchy-Reverse", url },
				]),
			);
			const promise = capture();
			if (url.includes("/../")) {
				await expect(promise).rejects.toMatchObject({
					code: "project_mismatch",
				});
			} else {
				expect(await promise).toMatchObject({
					complete: false,
					incompleteReason: "invalid_response",
					stories: [],
				});
			}
			expect(
				fetchMock.mock.calls.every(
					([requested]) =>
						new URL(String(requested)).hostname === "dev.azure.com",
				),
			).toBe(true);
		},
	);

	it.each([
		"https://dev.azure.com/other-org/_apis/wit/workItems/100",
		"https://dev.azure.com/example-org/other-project/_apis/wit/workItems/100",
	])("rejects a foreign relation %s", async (url) => {
		items.set(
			1,
			item(1, "DevBE Task", {}, [
				{ rel: "System.LinkTypes.Hierarchy-Reverse", url },
			]),
		);
		await expect(capture()).rejects.toMatchObject({
			code: "project_mismatch",
		});
	});

	it.each(["project-1", "Example%20Project"])(
		"accepts only a known optional project segment %s",
		(segment) => {
			expect(
				sprintRelationItemId(
					`https://dev.azure.com/example-org/${segment}/_apis/wit/workItems/100`,
					target,
					project,
				),
			).toBe(100);
		},
	);

	it("validates bounded configuration and literal controls before any request", async () => {
		const inputs = [
			options(),
			options(),
			options(),
			options(),
			options(),
			options(),
		];
		if (inputs[0]) {
			inputs[0].selection.iterationPaths = ["one", "two", "three"];
		}
		if (inputs[1]) {
			inputs[1].selection.parentSourceTypes = ["Unselected Type"];
		}
		if (inputs[2]) {
			inputs[2].requirementFields = ["System.Title] = 'bad'"];
		}
		if (inputs[3]) {
			inputs[3].selection.excludedAssignedStates = ["Removed\nOR 1=1"];
		}
		if (inputs[4]) {
			inputs[4].maxStories = 51;
		}
		if (inputs[5]) {
			inputs[5].selection.assignedItemTypes = Array.from(
				{ length: 21 },
				(_, index) => `Type ${index}`,
			);
		}
		for (const input of inputs) {
			await expect(capture(input)).rejects.toMatchObject({
				code: "invalid_filter",
			});
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("preserves legacy enumeration and snapshot defaults", async () => {
		discoveryIds = [];
		await listAzureDevOpsAssignedStories(target, "example-pat", {
			assignee: { mode: "current" },
		});
		const query = JSON.parse(
			String(fetchMock.mock.calls[1]?.[1]?.body),
		).query;
		expect(query).toContain("[System.AssignedTo] = @Me");
		expect(query).toContain("IN ('User Story')");
		expect(query).not.toContain("Custom.Engineer");
		expect(query).not.toContain("IterationPath");
		const result = await getAzureDevOpsStorySnapshots(
			target,
			"example-pat",
			{
				ids: [100],
				requirementsAsOf: asOf,
			},
		);
		expect(result).toMatchObject({
			complete: true,
			snapshots: [
				{
					id: 100,
					requirements: {
						"System.Title": "Item 100",
						"System.Description": "TBD",
						"Microsoft.VSTS.Common.AcceptanceCriteria": null,
					},
				},
			],
		});
		expect(result.snapshots[0]).not.toHaveProperty("contextItems");
	});
});
