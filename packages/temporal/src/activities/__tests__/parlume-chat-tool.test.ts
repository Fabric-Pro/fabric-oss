import { logger } from "@repo/logs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParlumeActionContext } from "../parlume-actions";
import { PARLUME_CHAT_POST_CHARS } from "../parlume-chat-reply";
import {
	createParlumeMeetingChatPoster,
	createParlumeMeetingChatTool,
} from "../parlume-chat-tool";

type Story = {
	id: string;
	projectId: string;
	identifier: string;
	kind: "FEATURE" | "BUG";
	title: string;
};

const state = vi.hoisted(() => ({
	stories: [] as Array<Record<string, unknown>>,
	documents: [] as Array<Record<string, unknown>>,
	contexts: [] as Array<Record<string, unknown>>,
	instructionSync: null as {
		projectId: string;
		repositoryIntegration: {
			repositoryUrl: string;
			repositoryOwner: string;
			repositoryName: string;
		};
	} | null,
	access: { organizationId: "org-1" } as {
		organizationId: string | null;
	} | null,
	post: vi.fn(),
	builderFailure: false,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../parlume-voice", () => ({ postParlumeMeetingChat: state.post }));

function insensitive(actual: unknown, expected: string): boolean {
	return String(actual).toLowerCase() === expected.toLowerCase();
}

vi.mock("@repo/database", () => {
	const urlFor = (path: string, organizationId?: string | null) => {
		if (state.builderFailure) {
			throw new Error("The project's organization has no address.");
		}
		const base = organizationId
			? "https://fabric.example/app/example-org/projects"
			: "https://fabric.example/app/projects";
		return `${base}/${path}`;
	};
	return {
		getProjectAccessContext: vi.fn(async () => state.access),
		buildFabricStoryUrl: vi.fn(
			async (a: {
				projectId: string;
				storyId: string;
				organizationId?: string | null;
			}) =>
				urlFor(`${a.projectId}/stories/${a.storyId}`, a.organizationId),
		),
		buildFabricDocumentUrl: vi.fn(
			async (a: {
				projectId: string;
				documentId: string;
				organizationId?: string | null;
			}) =>
				urlFor(
					`${a.projectId}/documents/${a.documentId}`,
					a.organizationId,
				),
		),
		buildFabricContextUrl: vi.fn(
			async (a: {
				projectId: string;
				contextId: string;
				organizationId?: string | null;
			}) =>
				urlFor(
					`${a.projectId}/contexts/${a.contextId}`,
					a.organizationId,
				),
		),
		buildFabricProjectTabUrl: vi.fn(
			async (a: {
				projectId: string;
				tab: string;
				organizationId?: string | null;
			}) => urlFor(`${a.projectId}?tab=${a.tab}`, a.organizationId),
		),
		withVisibleStories: (where: unknown) => where,
		db: {
			userStory: {
				findMany: vi.fn(
					async ({
						where,
					}: {
						where: {
							projectId: string;
							OR: Array<{ identifier: { equals: string } }>;
						};
					}) =>
						state.stories.filter(
							(story) =>
								story.projectId === where.projectId &&
								where.OR.some(({ identifier }) =>
									insensitive(
										story.identifier,
										identifier.equals,
									),
								),
						),
				),
				findFirst: vi.fn(
					async ({
						where,
					}: {
						where: { id: string; projectId: string };
					}) =>
						state.stories.find(
							(story) =>
								story.id === where.id &&
								story.projectId === where.projectId,
						) ?? null,
				),
			},
			projectDocument: {
				findFirst: vi.fn(
					async ({
						where,
					}: {
						where: { id: string; projectId: string };
					}) =>
						state.documents.find(
							(doc) =>
								doc.id === where.id &&
								doc.projectId === where.projectId,
						) ?? null,
				),
				findMany: vi.fn(
					async ({
						where,
					}: {
						where: {
							projectId: string;
							title: { equals: string };
						};
					}) =>
						state.documents.filter(
							(doc) =>
								doc.projectId === where.projectId &&
								insensitive(doc.title, where.title.equals),
						),
				),
			},
			projectContext: {
				findFirst: vi.fn(
					async ({
						where,
					}: {
						where: { id: string; projectId: string };
					}) =>
						state.contexts.find(
							(row) =>
								row.id === where.id &&
								row.projectId === where.projectId,
						) ?? null,
				),
			},
			projectInstructionRepositorySync: {
				findUnique: vi.fn(
					async ({ where }: { where: { projectId: string } }) =>
						state.instructionSync?.projectId === where.projectId
							? state.instructionSync
							: null,
				),
			},
		},
	};
});

const context: ParlumeActionContext = {
	turnId: "turn-1",
	sessionId: "session-1",
	projectId: "project-1",
	organizationId: "org-1",
	userId: "user-1",
	speakerId: "speaker-1",
	speakerName: "Alex",
	requestText: "put the link in the chat",
	agentRevision: "revision",
	voiceGeneration: 1,
	toolsReadOnly: true,
};

const story = (overrides: Partial<Story> = {}): Story => ({
	id: "story-123",
	projectId: "project-1",
	identifier: "F-123",
	kind: "FEATURE",
	title: "Export the roadmap",
	...overrides,
});

type Input = {
	text?: string;
	links?: Array<{
		kind:
			| "work_item"
			| "document"
			| "source"
			| "project_tab"
			| "instructions_repository";
		ref?: string;
		label?: string;
	}>;
};

async function post(
	input: Input,
	poster = createParlumeMeetingChatPoster(context),
) {
	return poster(input);
}

const lastMessage = () => state.post.mock.calls.at(-1)?.[0].message as string;

beforeEach(() => {
	vi.clearAllMocks();
	state.stories = [story()];
	state.documents = [
		{ id: "doc-1", projectId: "project-1", title: "Launch Plan" },
	];
	state.contexts = [
		{
			id: "ctx-1",
			projectId: "project-1",
			sourceTitle: "Kickoff notes",
			originalFilename: "kickoff.md",
		},
	];
	state.instructionSync = null;
	state.access = { organizationId: "org-1" };
	state.builderFailure = false;
	state.post.mockResolvedValue({ sent: true, tag: "P1" });
});

describe("post_to_meeting_chat links", () => {
	it("posts a work item as its identifier, title and full address, one per line", async () => {
		state.stories = [
			story(),
			story({
				id: "story-9",
				identifier: "B-009",
				kind: "BUG",
				title: "Crash",
			}),
		];

		const result = await post({
			links: [
				{ kind: "work_item", ref: "F-123" },
				{ kind: "work_item", ref: "b-9" },
			],
		});

		expect(lastMessage()).toBe(
			[
				"F-123 · Export the roadmap — https://fabric.example/app/example-org/projects/project-1/stories/story-123",
				"B-009 · Crash — https://fabric.example/app/example-org/projects/project-1/stories/story-9",
			].join("\n"),
		);
		expect(state.post).toHaveBeenCalledWith({
			sessionId: "session-1",
			turnId: "turn-1",
			voiceGeneration: 1,
			message: lastMessage(),
		});
		expect(result).toEqual({
			sent: true,
			delivery: "queued",
			tag: "P1",
			links: [
				{
					ref: "F-123",
					title: "F-123 · Export the roadmap",
					url: "https://fabric.example/app/example-org/projects/project-1/stories/story-123",
				},
				{
					ref: "b-9",
					title: "B-009 · Crash",
					url: "https://fabric.example/app/example-org/projects/project-1/stories/story-9",
				},
			],
			unresolved: [],
		});
	});

	it("resolves a bare number and a work item's id", async () => {
		await post({
			links: [
				{ kind: "work_item", ref: "123" },
				{ kind: "work_item", ref: "story-123" },
			],
		});

		expect(lastMessage().split("\n")).toHaveLength(2);
		expect(lastMessage()).toContain("/stories/story-123");
	});

	it("uses the project's organization, not the meeting inviter's", async () => {
		state.access = { organizationId: null };

		await post({ links: [{ kind: "work_item", ref: "F-123" }] });

		expect(lastMessage()).toContain("https://fabric.example/app/projects/");
		expect(lastMessage()).not.toContain("example-org");
	});

	it("refuses a work item that belongs to another project", async () => {
		state.stories = [story({ projectId: "project-2" })];

		const result = await post({
			links: [
				{ kind: "work_item", ref: "F-123" },
				{ kind: "work_item", ref: "story-123" },
			],
		});

		expect(state.post).not.toHaveBeenCalled();
		expect(result).toEqual({
			sent: false,
			error: expect.stringContaining("Nothing was sent"),
			links: [],
			unresolved: [
				{ ref: "F-123", reason: "No such work item in this project." },
				{
					ref: "story-123",
					reason: "No such work item in this project.",
				},
			],
		});
	});

	it("posts what it could resolve and reports the rest", async () => {
		const result = await post({
			links: [
				{ kind: "work_item", ref: "F-999" },
				{ kind: "work_item", ref: "F-123" },
			],
		});

		expect(lastMessage().split("\n")).toHaveLength(1);
		expect(result).toMatchObject({
			sent: true,
			unresolved: [{ ref: "F-999" }],
		});
	});

	it("links a document by id or by exact title, and refuses an ambiguous title", async () => {
		state.documents.push(
			{ id: "doc-2", projectId: "project-1", title: "Notes" },
			{ id: "doc-3", projectId: "project-1", title: "notes" },
			{ id: "doc-9", projectId: "project-2", title: "Other plan" },
		);

		const result = await post({
			links: [
				{ kind: "document", ref: "doc-1" },
				{ kind: "document", ref: "launch plan" },
				{ kind: "document", ref: "Notes" },
				{ kind: "document", ref: "doc-9" },
			],
		});

		expect(lastMessage().split("\n")).toEqual([
			"Launch Plan — https://fabric.example/app/example-org/projects/project-1/documents/doc-1",
			"Launch Plan — https://fabric.example/app/example-org/projects/project-1/documents/doc-1",
		]);
		expect(result).toMatchObject({
			unresolved: [
				{
					ref: "Notes",
					reason: expect.stringContaining("More than one"),
				},
				{ ref: "doc-9", reason: "No such document in this project." },
			],
		});
	});

	it("links a source by its title, then its file name", async () => {
		state.contexts.push({
			id: "ctx-2",
			projectId: "project-1",
			sourceTitle: null,
			originalFilename: "spec.pdf",
		});

		await post({
			links: [
				{ kind: "source", ref: "ctx-1" },
				{ kind: "source", ref: "ctx-2" },
			],
		});

		expect(lastMessage().split("\n")).toEqual([
			"Kickoff notes — https://fabric.example/app/example-org/projects/project-1/contexts/ctx-1",
			"spec.pdf — https://fabric.example/app/example-org/projects/project-1/contexts/ctx-2",
		]);
	});

	it.each([
		// The project's main tabs, as a staging meeting asked for them in one list.
		["Overview", "overview"],
		["Meeting Digest", "meeting-digest"],
		["the Daily Brief page", "daily-brief"],
		["Release notes", "release-notes"],
		["Testing", "test-cases"],
		["roadmap", "stories"],
		["Decisions", "decisions"],
		["documents", "documents"],
		["context", "context"],
		["instructions", "coding-instructions"],
		["Coding instructions", "coding-instructions"],
		// How a participant names it: "the coding instructions page".
		["the Coding Instructions page", "coding-instructions"],
		["roadmap tab", "stories"],
	])("opens the %s tab", async (ref, tab) => {
		await post({ links: [{ kind: "project_tab", ref }] });

		expect(lastMessage()).toContain(`project-1?tab=${tab}`);
	});

	it("names the Coding Instructions tab as such", async () => {
		await post({ links: [{ kind: "project_tab", ref: "instructions" }] });

		expect(lastMessage()).toBe(
			"Coding instructions — https://fabric.example/app/example-org/projects/project-1?tab=coding-instructions",
		);
	});

	it("links the repository the project's Coding Instructions sync from, as a browser opens it", async () => {
		state.instructionSync = {
			projectId: "project-1",
			repositoryIntegration: {
				repositoryUrl:
					"https://dev.azure.com/example-org/Example/_git/coding-instructions.git",
				repositoryOwner: "example-org",
				repositoryName: "coding-instructions",
			},
		};

		const result = await post({
			links: [{ kind: "instructions_repository" }],
		});

		expect(lastMessage()).toBe(
			"Coding instructions repository · example-org/coding-instructions — https://dev.azure.com/example-org/Example/_git/coding-instructions",
		);
		expect(result).toMatchObject({ sent: true, unresolved: [] });
	});

	it("asks for the item when a link other than the repository has no ref", async () => {
		const result = await post({ links: [{ kind: "work_item" }] });

		expect(state.post).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			sent: false,
			unresolved: [
				{ ref: "work_item", reason: expect.stringContaining("ref") },
			],
		});
	});

	it.each([
		["no repository sync", null],
		[
			"an address with credentials",
			"https://token@github.com/example-org/coding-instructions",
		],
		[
			"an address that is not https",
			"git@github.com:example-org/rules.git",
		],
	])(
		"refuses the instructions repository with %s and says why",
		async (_name, url) => {
			state.instructionSync = url
				? {
						projectId: "project-1",
						repositoryIntegration: {
							repositoryUrl: url,
							repositoryOwner: "example-org",
							repositoryName: "rules",
						},
					}
				: null;

			const result = await post({
				links: [
					{
						kind: "instructions_repository",
						ref: "coding instructions",
					},
				],
			});

			expect(state.post).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				sent: false,
				error: expect.stringContaining("Nothing was sent"),
				unresolved: [
					{
						ref: "coding instructions",
						reason: expect.stringContaining(
							"project_tab instructions",
						),
					},
				],
			});
		},
	);

	it("refuses a tab that does not exist", async () => {
		const result = await post({
			links: [{ kind: "project_tab", ref: "billing" }],
		});

		expect(state.post).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			sent: false,
			unresolved: [{ ref: "billing" }],
		});
	});

	it("shows a label in place of the item's own title", async () => {
		await post({
			links: [
				{
					kind: "work_item",
					ref: "F-123",
					label: "The export feature",
				},
			],
		});

		expect(lastMessage().startsWith("The export feature — https://")).toBe(
			true,
		);
	});

	it("reports a link whose address cannot be built instead of failing the post", async () => {
		state.builderFailure = true;

		const result = await post({
			text: "Here you go",
			links: [{ kind: "work_item", ref: "F-123" }],
		});

		expect(lastMessage()).toBe("Here you go");
		expect(result).toMatchObject({
			sent: true,
			links: [],
			unresolved: [
				{ ref: "F-123", reason: "The address could not be built." },
			],
		});
	});
});

describe("get_meeting_links", () => {
	const getLinks = (links: NonNullable<Input["links"]>) =>
		createParlumeMeetingChatTool(context).get_meeting_links.execute?.(
			{ links },
			{ toolCallId: "call-1", messages: [], context: {} },
		);

	// A question asked on the Parlume page is answered there alone.
	it("gives a page question the link lookup and no way to post in the meeting", () => {
		const tools = createParlumeMeetingChatTool({
			...context,
			pageOnly: true,
		});

		expect(Object.keys(tools)).toEqual(["get_meeting_links"]);
		expect(
			Object.keys(createParlumeMeetingChatTool(context)).sort(),
		).toEqual(["get_meeting_links", "post_to_meeting_chat"]);
	});

	// A typed or realtime answer is posted by Parlume itself: the agent only
	// needs the exact addresses to write them into it.
	it("returns exact addresses without posting anything", async () => {
		const result = await getLinks([
			{ kind: "project_tab", ref: "coding instructions page" },
			{ kind: "work_item", ref: "F-999" },
		]);

		expect(state.post).not.toHaveBeenCalled();
		expect(result).toEqual({
			resolved: [
				{
					ref: "coding instructions page",
					title: "Coding instructions",
					url: "https://fabric.example/app/example-org/projects/project-1?tab=coding-instructions",
				},
			],
			unresolved: [
				{ ref: "F-999", reason: "No such work item in this project." },
			],
		});
	});

	// A staging meeting asked for "Overview, Meeting Digest, Context, Roadmap"
	// and got "Link unavailable" for the first two.
	it("resolves the project's main pages asked for in one list", async () => {
		const result = await getLinks(
			["Overview", "Meeting Digest", "Context", "Roadmap"].map((ref) => ({
				kind: "project_tab" as const,
				ref,
			})),
		);

		expect(result).toEqual({
			resolved: [
				["Overview", "Overview", "overview"],
				["Meeting Digest", "Meeting Digest", "meeting-digest"],
				["Context", "Context", "context"],
				["Roadmap", "Roadmap", "stories"],
			].map(([ref, title, tab]) => ({
				ref,
				title,
				url: `https://fabric.example/app/example-org/projects/project-1?tab=${tab}`,
			})),
			unresolved: [],
		});
	});

	it("refuses when the inviter can no longer read the project", async () => {
		state.access = null;

		expect(await getLinks([{ kind: "work_item", ref: "F-123" }])).toEqual({
			error: "Project not found or access denied.",
		});
	});
});

describe("post_to_meeting_chat text", () => {
	it("posts whatever the participant asked for, URLs included", async () => {
		await post({
			text: "Standup notes: see https://example.com/board?x=1 and www.example.com/a.",
		});

		expect(lastMessage()).toBe(
			"Standup notes: see https://example.com/board?x=1 and www.example.com/a.",
		);
	});

	it("puts the text first, then the links after a blank line", async () => {
		await post({
			text: "As requested:",
			links: [{ kind: "work_item", ref: "F-123" }],
		});

		expect(lastMessage()).toMatch(/^As requested:\n\nF-123 · /);
	});

	it("needs some text or a link", async () => {
		expect(await post({})).toMatchObject({ sent: false });
		expect(await post({ text: "   " })).toMatchObject({ sent: false });
		expect(state.post).not.toHaveBeenCalled();
	});

	it("keeps the whole message, with room for the bridge's tag, inside one chat post, shortening the text before any link", async () => {
		state.stories = Array.from({ length: 5 }, (_, index) =>
			story({
				id: `story-${index}`,
				identifier: `F-${index + 1}`,
				title: "Export the roadmap",
			}),
		);

		await post({
			text: "x".repeat(3_500),
			links: state.stories.map((row) => ({
				kind: "work_item" as const,
				ref: String(row.identifier),
			})),
		});

		const message = lastMessage();
		const [text, links] = message.split("\n\n");
		expect(message.length).toBeLessThanOrEqual(PARLUME_CHAT_POST_CHARS);
		expect(text.endsWith("…")).toBe(true);
		expect(text.length).toBeLessThan(3_500);
		expect(links.split("\n")).toHaveLength(5);
	});

	it("drops links from the end, never cutting one, when links alone are too long", async () => {
		state.stories = Array.from({ length: 10 }, (_, index) =>
			story({
				id: `story-${index}`,
				identifier: `F-${index + 1}`,
				title: "t".repeat(450),
			}),
		);

		const result = await post({
			links: state.stories.map((row) => ({
				kind: "work_item" as const,
				ref: String(row.identifier),
			})),
		});

		const lines = lastMessage().split("\n");
		expect(lastMessage().length).toBeLessThanOrEqual(
			PARLUME_CHAT_POST_CHARS,
		);
		expect(lines.every((line) => /— https:\/\/\S+$/.test(line))).toBe(true);
		expect(lines.length).toBeLessThan(10);
		const unresolved = (result.unresolved as Array<{ reason: string }>).map(
			(entry) => entry.reason,
		);
		expect(unresolved.length).toBe(10 - lines.length);
		expect(new Set(unresolved)).toEqual(
			new Set(["Too long for one chat message."]),
		);
	});
});

describe("post_to_meeting_chat limits and failures", () => {
	it("allows three posts per answer and refuses the fourth", async () => {
		const poster = createParlumeMeetingChatPoster(context);

		for (let index = 0; index < 3; index++) {
			expect(await post({ text: `Post ${index}` }, poster)).toMatchObject(
				{
					sent: true,
				},
			);
		}
		const fourth = await post({ text: "One more" }, poster);

		expect(fourth).toMatchObject({ sent: false });
		expect(state.post).toHaveBeenCalledTimes(3);
	});

	it("counts the limit per turn, not across turns", async () => {
		const first = createParlumeMeetingChatPoster(context);
		for (let index = 0; index < 3; index++) {
			await post({ text: "a" }, first);
		}

		const next = createParlumeMeetingChatPoster({
			...context,
			turnId: "turn-2",
		});

		expect(await post({ text: "b" }, next)).toMatchObject({ sent: true });
	});

	it("posts nothing and says so when the project cannot be read", async () => {
		state.access = null;

		const result = await post({ text: "Hello" });

		expect(result).toEqual({
			sent: false,
			error: "Project not found or access denied.",
		});
		expect(state.post).not.toHaveBeenCalled();
	});

	it("tells the agent to say the content when the meeting's chat is out of reach", async () => {
		state.post.mockResolvedValue({
			sent: false,
			reason: "chat_unavailable",
		});

		const result = await post({ text: "Hello" });

		expect(result).toEqual({
			sent: false,
			delivered: false,
			reason: "chat_unavailable",
			error: "This meeting's chat is not available to Parlume. Say the content aloud instead.",
		});
	});

	it("tells the agent the answer stays on the Parlume page while a guest is in the meeting", async () => {
		state.post.mockResolvedValue({ sent: false, reason: "guests_present" });

		const result = await post({ text: "Hello" });

		expect(result).toEqual({
			sent: false,
			delivered: false,
			reason: "guests_present",
			error: "A guest is in this meeting, so Parlume does not post in its chat. Give the content in your answer: it stays on the Parlume page.",
		});
	});

	it("never reports a message as delivered, only queued", async () => {
		const result = await post({ text: "Hello" });

		expect(result).toMatchObject({ sent: true, delivery: "queued" });
		expect(JSON.stringify(result)).not.toMatch(/posted|delivered/);
	});

	it("reports a chat message the bridge could not send", async () => {
		state.post.mockResolvedValue({ sent: false, reason: "failed" });

		const result = await post({ text: "Hello" });

		expect(result).toMatchObject({
			sent: false,
			error: "The chat message could not be sent.",
		});
	});

	it("logs each post with counts and no content", async () => {
		await post({
			text: "A private plan",
			links: [
				{ kind: "work_item", ref: "F-123" },
				{ kind: "work_item", ref: "F-404" },
			],
		});

		const call = vi
			.mocked(logger.info)
			.mock.calls.find(
				([message]) => message === "[Parlume] chat.posted",
			);
		expect(call?.[1]).toMatchObject({
			component: "parlume",
			event: "parlume.chat.posted",
			sessionId: "session-1",
			turnId: "turn-1",
			sent: true,
			post: 1,
			links: 1,
			unresolved: 1,
		});
		expect(JSON.stringify(call)).not.toContain("private plan");
		expect(JSON.stringify(call)).not.toContain("https://");
	});
});
