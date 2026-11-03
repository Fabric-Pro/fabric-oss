import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils/dispatch-guard", () => ({
	throwIfDispatchStopped: () => {},
}));

import {
	createGitHubProjectItemFromStory,
	GitHubProjectsError,
	getGitHubProjectItemForPM,
	githubStatusLabel,
	githubTokenReadsPersonalBoards,
	listGitHubProjectBoards,
	listGitHubProjectItemsForPM,
	normalizeGitHubItemReference,
	parseGitHubExternalId,
	readGitHubProjectsRepository,
	updateGitHubProjectItemFromStory,
} from "../../src/github/projects-pm-adapter";

const SOURCE = {
	token: "tok",
	projectId: "PVT_board",
	repository: "example-org/app",
};

const BOARD = {
	node: {
		id: "PVT_board",
		number: 3,
		title: "Roadmap",
		url: "https://github.com/orgs/example-org/projects/3",
		closed: false,
		owner: { __typename: "Organization", login: "example-org" },
		field: {
			id: "PVTSSF_status",
			options: [
				{ id: "opt_todo", name: "Todo" },
				{ id: "opt_progress", name: "In Progress" },
				{ id: "opt_done", name: "Done" },
			],
		},
		repositories: { nodes: [{ nameWithOwner: "example-org/app" }] },
	},
};

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let responses: Array<(call: Call) => Response>;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Answers GraphQL by the operation name in the query, REST by order. */
function graphqlRouter(
	byOperation: Record<string, unknown | ((vars: unknown) => unknown)>,
) {
	return (call: Call): Response => {
		const body = call.body as { query: string; variables: unknown };
		const op = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "";
		const answer = byOperation[op];
		if (answer === undefined) {
			throw new Error(`unexpected GraphQL operation ${op}`);
		}
		return json({
			data:
				typeof answer === "function"
					? (answer as (v: unknown) => unknown)(body.variables)
					: answer,
		});
	};
}

beforeEach(() => {
	calls = [];
	responses = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const call: Call = {
				url,
				method: init.method ?? "GET",
				body: init.body ? JSON.parse(String(init.body)) : undefined,
			};
			calls.push(call);
			const next = responses.shift();
			if (!next) {
				throw new Error(`unexpected fetch ${call.method} ${url}`);
			}
			return next(call);
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("external ids", () => {
	it("parses issue and draft ids", () => {
		expect(parseGitHubExternalId("example-org/app#42")).toEqual({
			kind: "issue",
			owner: "example-org",
			name: "app",
			number: 42,
		});
		expect(parseGitHubExternalId("draft:DI_1")).toEqual({
			kind: "draft",
			draftId: "DI_1",
		});
		expect(() => parseGitHubExternalId("42")).toThrow();
	});

	it("normalizes what a person types", () => {
		expect(
			normalizeGitHubItemReference(
				"https://github.com/example-org/app/issues/7",
				null,
			),
		).toBe("example-org/app#7");
		expect(normalizeGitHubItemReference("#7", "example-org/app")).toBe(
			"example-org/app#7",
		);
		expect(normalizeGitHubItemReference("7", null)).toBeNull();
	});

	it("reads the target repository from the PM context", () => {
		expect(
			readGitHubProjectsRepository({
				githubRepository: "example-org/app",
			}),
		).toBe("example-org/app");
		expect(readGitHubProjectsRepository({ githubRepository: "bad" })).toBe(
			null,
		);
		expect(readGitHubProjectsRepository(null)).toBeNull();
	});
});

describe("listGitHubProjectItemsForPM", () => {
	it("maps issues and drafts, carries Status as a pseudo-label, skips pull requests", async () => {
		responses.push(
			graphqlRouter({
				FabricBoardItems: {
					node: {
						items: {
							nodes: [
								{
									id: "PVTI_1",
									type: "ISSUE",
									fieldValueByName: { name: "In Progress" },
									content: {
										__typename: "Issue",
										id: "I_1",
										number: 5,
										title: "Checkout",
										state: "OPEN",
										url: "https://github.com/example-org/app/issues/5",
										updatedAt: "2026-10-01T00:00:00Z",
										repository: {
											nameWithOwner: "example-org/app",
										},
										issueType: null,
										labels: {
											nodes: [
												{ name: "ui" },
												{ name: "type:feature" },
											],
										},
									},
								},
								{
									id: "PVTI_2",
									type: "DRAFT_ISSUE",
									fieldValueByName: null,
									content: {
										__typename: "DraftIssue",
										id: "DI_2",
										title: "Idea",
										updatedAt: "2026-10-02T00:00:00Z",
									},
								},
								{
									id: "PVTI_3",
									type: "PULL_REQUEST",
									fieldValueByName: null,
									content: { __typename: "PullRequest" },
								},
							],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			}),
		);

		const { items } = await listGitHubProjectItemsForPM({ source: SOURCE });

		expect(items).toEqual([
			expect.objectContaining({
				id: "example-org/app#5",
				workItemType: "Feature",
				state: "opened",
				status: "In Progress",
				labels: [
					"ui",
					"type:feature",
					githubStatusLabel("In Progress"),
				],
			}),
			expect.objectContaining({
				id: "draft:DI_2",
				workItemType: "Draft",
				labels: [],
			}),
		]);
	});
});

describe("getGitHubProjectItemForPM", () => {
	it("reads this board's Status and the parent issue", async () => {
		responses.push(
			graphqlRouter({
				FabricIssue: {
					repository: {
						issue: {
							id: "I_5",
							number: 5,
							title: "Checkout",
							body: "Body",
							state: "CLOSED",
							url: "https://github.com/example-org/app/issues/5",
							updatedAt: "2026-10-03T00:00:00Z",
							repository: { nameWithOwner: "example-org/app" },
							issueType: { name: "Bug" },
							labels: { nodes: [] },
							parent: {
								number: 1,
								repository: {
									nameWithOwner: "example-org/app",
								},
							},
							projectItems: {
								nodes: [
									{
										id: "PVTI_other",
										project: { id: "PVT_other" },
										fieldValueByName: { name: "Todo" },
									},
									{
										id: "PVTI_1",
										project: { id: "PVT_board" },
										fieldValueByName: { name: "Done" },
									},
								],
							},
						},
					},
				},
			}),
		);

		const item = await getGitHubProjectItemForPM({
			source: SOURCE,
			externalId: "example-org/app#5",
		});

		expect(item).toMatchObject({
			title: "Checkout",
			description: "Body",
			state: "closed",
			status: "Done",
			labels: [githubStatusLabel("Done")],
			workItemType: "Bug",
			parentExternalId: "example-org/app#1",
		});
	});

	it("reports a missing issue as not-found", async () => {
		responses.push(
			graphqlRouter({ FabricIssue: { repository: { issue: null } } }),
		);
		await expect(
			getGitHubProjectItemForPM({
				source: SOURCE,
				externalId: "example-org/app#404",
			}),
		).rejects.toMatchObject({ kind: "not-found" });
	});

	it("turns a missing `project` scope into a reconnect error", async () => {
		responses.push(() =>
			json({
				data: null,
				errors: [{ type: "INSUFFICIENT_SCOPES", message: "scopes" }],
			}),
		);
		const error = await getGitHubProjectItemForPM({
			source: SOURCE,
			externalId: "example-org/app#5",
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GitHubProjectsError);
		expect((error as GitHubProjectsError).kind).toBe("insufficient-scope");
	});
});

describe("githubTokenReadsPersonalBoards", () => {
	it("is false for fine-grained and GitHub App user tokens, true for classic and OAuth tokens", () => {
		expect(githubTokenReadsPersonalBoards("github_pat_example")).toBe(
			false,
		);
		expect(githubTokenReadsPersonalBoards("ghu_example")).toBe(false);
		expect(githubTokenReadsPersonalBoards("ghp_example")).toBe(true);
		expect(githubTokenReadsPersonalBoards("gho_example")).toBe(true);
	});
});

describe("listGitHubProjectBoards", () => {
	const OWN_BOARD = {
		id: "PVT_own",
		number: 5,
		title: "Booking app",
		url: "https://github.com/users/example-user/projects/5",
		closed: false,
		owner: { __typename: "User", login: "example-user" },
	};

	const ORG_BOARD = {
		...OWN_BOARD,
		id: "PVT_org",
		owner: { __typename: "Organization", login: "example-org" },
	};

	it("lists the caller's own boards and their organizations' boards", async () => {
		responses.push(() =>
			json({ data: { viewer: { projectsV2: { nodes: [OWN_BOARD] } } } }),
		);
		responses.push(() =>
			json({
				data: {
					viewer: {
						organizations: {
							nodes: [
								{
									login: "example-org",
									projectsV2: { nodes: [ORG_BOARD] },
								},
							],
						},
					},
				},
			}),
		);
		const boards = await listGitHubProjectBoards("tok");
		expect(boards.map((b) => b.id)).toEqual(["PVT_own", "PVT_org"]);
	});

	it("lists the caller's own boards when organizations need `read:org`", async () => {
		responses.push(() =>
			json({ data: { viewer: { projectsV2: { nodes: [OWN_BOARD] } } } }),
		);
		// GitHub answers the organizations query with no data and an error
		// that names no path.
		responses.push(() =>
			json({
				data: null,
				errors: [
					{
						type: "INSUFFICIENT_SCOPES",
						message:
							"Your token has not been granted the required scopes to execute this query. The 'login' field requires one of the following scopes: ['read:org'].",
					},
				],
			}),
		);
		const boards = await listGitHubProjectBoards("tok");
		expect(boards.map((b) => b.id)).toEqual(["PVT_own"]);
	});

	it("still reports a missing `project` scope on the caller's own boards", async () => {
		responses.push(() =>
			json({
				data: { viewer: { projectsV2: null } },
				errors: [
					{
						type: "INSUFFICIENT_SCOPES",
						message:
							"The 'projectsV2' field requires one of the following scopes: ['read:project'].",
						path: ["viewer", "projectsV2"],
					},
				],
			}),
		);
		await expect(listGitHubProjectBoards("tok")).rejects.toMatchObject({
			kind: "insufficient-scope",
		});
	});
});

describe("createGitHubProjectItemFromStory", () => {
	it("creates a typed issue, adds it to the board and sets its Status", async () => {
		responses.push(
			graphqlRouter({
				FabricIssueTypes: {
					repository: {
						issueTypes: {
							nodes: [
								{ id: "IT_f", name: "Feature" },
								{ id: "IT_b", name: "Bug" },
							],
						},
					},
				},
			}),
			() =>
				json(
					{
						id: 900,
						node_id: "I_new",
						number: 12,
						title: "Checkout",
						html_url:
							"https://github.com/example-org/app/issues/12",
						updated_at: "2026-10-04T00:00:00Z",
					},
					201,
				),
			graphqlRouter({
				FabricAddItem: {
					addProjectV2ItemById: { item: { id: "PVTI_new" } },
				},
			}),
			graphqlRouter({ FabricBoard: BOARD }),
			graphqlRouter({
				FabricSetStatus: {
					updateProjectV2ItemFieldValue: {
						projectV2Item: { id: "PVTI_new" },
					},
				},
			}),
		);

		const result = await createGitHubProjectItemFromStory({
			source: SOURCE,
			payload: {
				title: "Checkout",
				description: "Body",
				labels: ["ui", githubStatusLabel("In Progress")],
				issueType: "Feature",
			},
		});

		expect(result).toEqual({
			externalId: "example-org/app#12",
			externalUrl: "https://github.com/example-org/app/issues/12",
			title: "Checkout",
			updatedAt: "2026-10-04T00:00:00Z",
		});
		expect(calls[1]).toMatchObject({
			method: "POST",
			url: "https://api.github.com/repos/example-org/app/issues",
			body: {
				title: "Checkout",
				body: "Body",
				labels: ["ui"],
				type: "Feature",
			},
		});
		const setStatus = calls[4]?.body as {
			variables: Record<string, string>;
		};
		expect(setStatus.variables).toMatchObject({
			item: "PVTI_new",
			field: "PVTSSF_status",
			option: "opt_progress",
		});
	});

	it("sends the type as a `type:` label when the repository has no Issue Types", async () => {
		responses.push(
			graphqlRouter({
				FabricIssueTypes: { repository: { issueTypes: null } },
			}),
			() =>
				json(
					{
						id: 901,
						node_id: "I_new2",
						number: 13,
						title: "Fix",
						html_url:
							"https://github.com/example-org/app/issues/13",
					},
					201,
				),
			graphqlRouter({
				FabricAddItem: {
					addProjectV2ItemById: { item: { id: "PVTI_x" } },
				},
			}),
		);

		const result = await createGitHubProjectItemFromStory({
			source: SOURCE,
			payload: { title: "Fix", issueType: "Bug" },
		});

		expect(result.externalId).toBe("example-org/app#13");
		expect(calls[1]?.body).toEqual({ title: "Fix", labels: ["type:bug"] });
	});

	it("keeps a `type:` label the story already carries", async () => {
		responses.push(
			graphqlRouter({
				FabricIssueTypes: { repository: { issueTypes: null } },
			}),
			() =>
				json(
					{
						id: 902,
						node_id: "I_new3",
						number: 14,
						title: "Story",
						html_url:
							"https://github.com/example-org/app/issues/14",
					},
					201,
				),
			graphqlRouter({
				FabricAddItem: {
					addProjectV2ItemById: { item: { id: "PVTI_y" } },
				},
			}),
		);

		await createGitHubProjectItemFromStory({
			source: SOURCE,
			payload: {
				title: "Story",
				labels: ["type:story", "area:checkout"],
				issueType: "Feature",
			},
		});

		expect(calls[1]?.body).toEqual({
			title: "Story",
			labels: ["type:story", "area:checkout"],
		});
	});

	it("creates a draft item when no repository is chosen", async () => {
		responses.push(
			graphqlRouter({
				FabricAddDraft: {
					addProjectV2DraftIssue: {
						projectItem: {
							id: "PVTI_d",
							content: {
								id: "DI_9",
								title: "Idea",
								updatedAt: "2026-10-05T00:00:00Z",
							},
						},
					},
				},
			}),
		);

		const result = await createGitHubProjectItemFromStory({
			source: { ...SOURCE, repository: null },
			payload: { title: "Idea" },
		});

		expect(result).toMatchObject({
			externalId: "draft:DI_9",
			externalUrl: null,
		});
	});
});

describe("updateGitHubProjectItemFromStory", () => {
	it("patches the issue, applies the label delta and moves the Status", async () => {
		responses.push(
			() =>
				json({
					id: 900,
					node_id: "I_5",
					number: 5,
					title: "Checkout",
					html_url: "https://github.com/example-org/app/issues/5",
					updated_at: "2026-10-06T00:00:00Z",
				}),
			() => json([]),
			() => json({ message: "Label does not exist" }, 404),
			graphqlRouter({
				FabricAddItem: {
					addProjectV2ItemById: { item: { id: "PVTI_1" } },
				},
			}),
			graphqlRouter({ FabricBoard: BOARD }),
			graphqlRouter({
				FabricSetStatus: {
					updateProjectV2ItemFieldValue: {
						projectV2Item: { id: "PVTI_1" },
					},
				},
			}),
		);

		const result = await updateGitHubProjectItemFromStory({
			source: SOURCE,
			externalId: "example-org/app#5",
			payload: {
				title: "Checkout",
				description: "New body",
				addLabels: ["ui", githubStatusLabel("Done")],
				removeLabels: ["stale", githubStatusLabel("In Progress")],
				stateEvent: "close",
			},
		});

		expect(result.updatedAt).toBe("2026-10-06T00:00:00Z");
		expect(calls[0]).toMatchObject({
			method: "PATCH",
			url: "https://api.github.com/repos/example-org/app/issues/5",
			body: { title: "Checkout", body: "New body", state: "closed" },
		});
		expect(calls[1]).toMatchObject({
			method: "POST",
			body: { labels: ["ui"] },
		});
		expect(calls[2]).toMatchObject({ method: "DELETE" });
		expect(calls[2]?.url).toContain("/labels/stale");
		const setStatus = calls[5]?.body as {
			variables: Record<string, string>;
		};
		expect(setStatus.variables.option).toBe("opt_done");
	});

	it("leaves an existing type alone and labels an untyped issue", async () => {
		const issue = (labels: string[]) =>
			graphqlRouter({
				FabricIssue: {
					repository: {
						issue: {
							id: "I_5",
							number: 5,
							title: "Checkout",
							body: "",
							state: "OPEN",
							url: "https://github.com/example-org/app/issues/5",
							updatedAt: "2026-10-06T00:00:00Z",
							repository: { nameWithOwner: "example-org/app" },
							issueType: null,
							labels: { nodes: labels.map((name) => ({ name })) },
							parent: null,
							projectItems: { nodes: [] },
						},
					},
				},
			});
		const patched = () =>
			json({
				id: 900,
				node_id: "I_5",
				number: 5,
				title: "Checkout",
				html_url: "https://github.com/example-org/app/issues/5",
			});
		const addItem = graphqlRouter({
			FabricAddItem: { addProjectV2ItemById: { item: { id: "PVTI_1" } } },
		});

		// Already `type:story`: no type change at all.
		responses.push(issue(["type:story"]), patched, addItem);
		await updateGitHubProjectItemFromStory({
			source: SOURCE,
			externalId: "example-org/app#5",
			payload: { title: "Checkout", issueType: "Feature" },
		});
		expect(calls.map((c) => c.method)).toEqual(["POST", "PATCH", "POST"]);
		expect(calls[1]?.body).toEqual({ title: "Checkout" });

		// Untyped, in a repository without Issue Types: `type:feature` added.
		calls = [];
		responses.push(
			issue([]),
			graphqlRouter({
				FabricIssueTypes: { repository: { issueTypes: null } },
			}),
			patched,
			() => json([]),
			addItem,
		);
		await updateGitHubProjectItemFromStory({
			source: SOURCE,
			externalId: "example-org/app#5",
			payload: { title: "Checkout", issueType: "Feature" },
		});
		expect(calls[3]).toMatchObject({
			method: "POST",
			body: { labels: ["type:feature"] },
		});
	});
});
