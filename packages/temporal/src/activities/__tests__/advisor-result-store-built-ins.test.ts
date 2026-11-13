import { MockActivityEnvironment } from "@temporalio/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const activities = new Map<string, ReturnType<typeof vi.fn>>();
	return {
		write: vi.fn(),
		filter: vi.fn(),
		contexts: vi.fn(),
		chunks: vi.fn(),
		project: vi.fn(),
		workspace: vi.fn(),
		settings: vi.fn(),
		slack: vi.fn(),
		teams: vi.fn(),
		extract: vi.fn(),
		meetings: vi.fn(),
		access: vi.fn(),
		off: new Set<string>(),
		stub: (name: string) => {
			let fn = activities.get(name);
			if (!fn) {
				fn = vi.fn();
				activities.set(name, fn);
			}
			return fn;
		},
		resetAll: () => {
			for (const fn of activities.values()) {
				fn.mockReset();
			}
		},
	};
});
vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: (id: string) => !mocks.off.has(id),
	proxyActivities: () =>
		new Proxy({}, { get: (_target, name) => mocks.stub(String(name)) }),
	workflowInfo: () => ({
		startTime: new Date(),
		runId: "example-run",
		unsafe: { isReplaying: false },
	}),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));
vi.mock("@repo/database/prisma/queries/advisor-tool-results", () => ({
	ADVISOR_RESULT_MAX_BYTES: 1024 * 1024,
	advisorToolResultStorage: { write: mocks.write },
}));
vi.mock("@repo/logs", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("@repo/database", () => ({
	db: {
		projectContext: { findMany: mocks.contexts },
		workspaceDocumentChunk: { findMany: mocks.chunks },
	},
	filterWorkspaceIdsForTenant: mocks.filter,
	getDefaultRagSettings: () => ({ topK: 5, similarityThreshold: 0.3 }),
	getEffectiveRagSettings: mocks.settings,
	hasProjectAccess: mocks.access,
	listMeetingTranscriptsByDate: mocks.meetings,
}));
vi.mock("@repo/ai", () => ({
	getRAGProviderConfig: async () => ({}),
	extractRelevantExcerpts: mocks.extract,
}));
vi.mock("@repo/rag", async () => ({
	...(await import(
		"@repo/rag/lib/project-contexts/project-context-passages"
	)),
	retrieveProjectContexts: mocks.project,
	contextMetaHeader: () => "",
	boundQueryForEmbedding: (text: string) => text,
	generateQueryEmbedding: async () => ({ embedding: [0.1] }),
	generateSparseVector: () => ({ indices: [], values: [] }),
}));
vi.mock("@repo/rag/lib/workspace-documents/store", () => ({
	searchMultipleWorkspaces: mocks.workspace,
}));
vi.mock("@repo/integrations/slack", () => ({ executeSlackTool: mocks.slack }));
vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: mocks.teams,
	isMicrosoftAccessDeniedError: () => false,
	isMicrosoftNotConnectedError: () => false,
	TEAMS_TOOL_LIMITS: {
		EXCERPTS_PER_PASS: 8,
		MAX_EXCERPTS_MERGED: 16,
		MAX_CHARS_PER_EXCERPT: 400,
		EXTRACTOR_TIMEOUT_MS: 15000,
	},
}));

import { extractMcpResultText } from "../../workflows/orchestrator/advisor-result-read";
import {
	installDefaultStubs,
	preloaded,
	runTurn,
} from "../../workflows/orchestrator/phases/__tests__/advisor-scenario-harness";
import type { AdvisorResultStoreContext } from "../advisor-result-store";
import { retrieveWorkspaceDocumentsActivity } from "../direct-chat/rag-retrieval";
import {
	listMeetingTranscriptsActivity,
	retrieveProjectContextsActivity,
} from "../project-metadata";
import { searchProjectSlackMessages } from "../search-project-slack-messages";
import { searchProjectTeamsMessages } from "../search-project-teams-messages";
import { listProjectMeetingTranscripts } from "../shared/meeting-transcript-listing";

const owner = { userId: "example-user", organizationId: "example-org" };
const scope = (toolName: string): AdvisorResultStoreContext => ({
	toolName,
	conversationId: "example-conversation",
	turnId: "example-turn",
	sourceKey: "example-execution:0",
});
// Shapes from project-contexts/retrieval.ts, workspace-documents/types.ts,
// search-project-{slack,teams}-messages.ts, message-extractor.ts and
// shared/meeting-transcript-listing.ts. These populate the real producer formatters.
const projectPassages = [
	{
		id: "example-source",
		type: "TEXT",
		sourceType: "text",
		sourceTitle: "Example project source",
		content: "Example source body",
		score: 0.9,
		metadata: {},
		matchedPassages: [{ content: "Example project passage", score: 0.9 }],
	},
];
const workspaceHits = [
	{
		chunkId: "example-document-0",
		documentId: "example-document",
		workspaceId: "example-workspace",
		chunkIndex: 0,
		score: 0.9,
		filename: "example-notes.md",
	},
];
const workspaceChunks = [
	{
		id: "example-chunk",
		documentId: "example-document",
		chunkIndex: 0,
		content: "Example workspace passage",
		pageNumber: null,
		document: { id: "example-document", filename: "example-notes.md" },
	},
];
const slackMessages = [
	{
		id: "example-slack-message",
		content: "Example Slack message",
		from: "Example speaker",
		createdAt: "2026-01-01T00:00:00Z",
		channelId: "example-channel",
		channelName: "Example channel",
		threadTs: "example-thread",
		permalink: "https://example.com/message",
	},
];
const teamsMessages = [
	{
		id: "example-teams-message",
		content: "Example Teams message",
		from: "Example speaker",
		fromEmail: "speaker@example.com",
		createdAt: "2026-01-01T00:00:00Z",
		chatId: "example-chat",
		webLink: "https://example.com/message",
	},
];
const excerpts = {
	excerpts: [
		{
			messageId: "example-teams-message",
			from: "Example speaker",
			createdAt: "2026-01-01T00:00:00Z",
			webLink: "https://example.com/message",
			excerpt: "Example Teams message",
			relevance: 0.9,
		},
	],
	totalScanned: 1,
	returned: 1,
	compressionRatio: 1,
	fallback: false,
	extractorLatencyMs: 1,
};
const transcripts = {
	items: [
		{
			meetingSubject: "Example meeting",
			meetingDate: new Date("2026-01-01T12:00:00Z"),
			speakerNames: ["Example speaker"],
			summary: "Example meeting summary",
			wasSummarized: false,
		},
	],
	total: 1,
};
const inActivity = <P extends unknown[], R>(
	fn: (...args: P) => Promise<R>,
	...args: P
) => new MockActivityEnvironment({ attempt: 3 }).run(fn, ...args);
const cases: [
	string,
	string,
	(scope?: AdvisorResultStoreContext) => Promise<unknown>,
][] = [
	[
		"project_rag_query",
		"retrieveProjectContextsActivity",
		(advisorResultStore) =>
			inActivity(
				retrieveProjectContextsActivity,
				"example query",
				"example-project",
				owner.userId,
				owner.organizationId,
				5,
				{ advisorResultStore },
			),
	],
	[
		"workspace_rag_query",
		"retrieveWorkspaceDocumentsActivity",
		(advisorResultStore) =>
			inActivity(
				retrieveWorkspaceDocumentsActivity,
				"example query",
				owner.userId,
				owner.organizationId,
				["example-workspace"],
				undefined,
				5,
				undefined,
				{ advisorResultStore },
			),
	],
	[
		"workspace_rag_summarize",
		"retrieveWorkspaceDocumentsActivity",
		(advisorResultStore) =>
			inActivity(
				retrieveWorkspaceDocumentsActivity,
				"example query",
				owner.userId,
				owner.organizationId,
				["example-workspace"],
				undefined,
				5,
				undefined,
				{ advisorResultStore },
			),
	],
	[
		"fabric_list_meeting_transcripts",
		"listMeetingTranscriptsActivity",
		(advisorResultStore) =>
			inActivity(listMeetingTranscriptsActivity, {
				...owner,
				projectId: "example-project",
				advisorResultStore,
			}),
	],
	[
		"search_slack_messages",
		"searchProjectSlackMessages",
		(advisorResultStore) =>
			inActivity(searchProjectSlackMessages, {
				...owner,
				projectId: "example-project",
				query: "example query",
				advisorResultStore,
			}),
	],
	[
		"search_teams_messages",
		"searchProjectTeamsMessages",
		(advisorResultStore) =>
			inActivity(searchProjectTeamsMessages, {
				...owner,
				projectId: "example-project",
				query: "example query",
				advisorResultStore,
			}),
	],
];
function recordedText(toolName: string, result: unknown): string {
	if (
		toolName === "project_rag_query" ||
		toolName.startsWith("workspace_rag_")
	) {
		return (result as { context: string }).context;
	}
	if (toolName === "fabric_list_meeting_transcripts") {
		return (result as { response: string }).response;
	}
	return JSON.stringify(result);
}
const configureEmpty = (name: string) => {
	if (name === "project_rag_query") {
		mocks.project.mockResolvedValue([]);
	} else if (name.startsWith("workspace_rag_")) {
		mocks.workspace.mockResolvedValue([]);
	} else if (name === "fabric_list_meeting_transcripts") {
		mocks.meetings.mockResolvedValue({ items: [], total: 0 });
	} else if (name === "search_slack_messages") {
		mocks.slack.mockResolvedValue({ messages: [], count: 0 });
	} else {
		mocks.teams.mockResolvedValue({ messages: [], count: 0 });
		mocks.extract.mockResolvedValue({
			...excerpts,
			excerpts: [],
			totalScanned: 0,
			returned: 0,
		});
	}
};
const configureFailure = (name: string) => {
	const target =
		name === "project_rag_query"
			? mocks.project
			: name.startsWith("workspace_rag_")
				? mocks.workspace
				: name === "fabric_list_meeting_transcripts"
					? mocks.meetings
					: name === "search_slack_messages"
						? mocks.slack
						: mocks.teams;
	target.mockRejectedValue(new Error("example retrieval unavailable"));
};
beforeEach(() => {
	vi.clearAllMocks();
	installDefaultStubs(mocks);
	mocks.write.mockResolvedValue("stored");
	mocks.filter.mockResolvedValue({
		allowed: ["example-workspace"],
		dropped: [],
	});
	mocks.project.mockResolvedValue(projectPassages);
	mocks.workspace.mockResolvedValue(workspaceHits);
	mocks.chunks.mockResolvedValue(workspaceChunks);
	mocks.settings.mockResolvedValue({ topK: 5, similarityThreshold: 0.3 });
	mocks.access.mockResolvedValue(true);
	mocks.meetings.mockResolvedValue(transcripts);
	mocks.slack.mockResolvedValue({ messages: slackMessages, count: 1 });
	mocks.teams.mockResolvedValue({ messages: teamsMessages, count: 1 });
	mocks.extract.mockResolvedValue(excerpts);
	mocks.contexts.mockResolvedValue([
		{
			id: "example-slack-context",
			metadata: {
				provider: "SLACK",
				channelId: "example-channel",
				channelName: "Example channel",
			},
		},
		{
			id: "example-teams-context",
			metadata: {
				provider: "MICROSOFT_TEAMS",
				chatType: "chat",
				chatId: "example-chat",
				chatTopic: "Example chat",
			},
		},
	]);
});
describe("Advisor storage at each built-in activity", () => {
	it.each(cases)(
		"stores populated producer output for %s without changing the return value",
		async (toolName, _activity, run) => {
			const original = await run();
			expect(mocks.write).not.toHaveBeenCalled();
			expect(await run(scope(toolName))).toEqual(original);
			const text = recordedText(toolName, original);
			expect(text).toContain("Example");
			expect(mocks.write).toHaveBeenCalledExactlyOnceWith({
				...owner,
				conversationId: "example-conversation",
				turnId: "example-turn",
				sourceKey: "example-execution:0",
				toolName,
				attempt: 3,
				text,
			});
		},
	);
	it.each(cases)(
		"does not store failed retrieval output for %s and preserves its result",
		async (toolName, _activity, run) => {
			configureFailure(toolName);
			if (toolName === "fabric_list_meeting_transcripts") {
				await expect(run(scope(toolName))).rejects.toThrow(
					"example retrieval unavailable",
				);
			} else {
				const original = await run();
				expect(await run(scope(toolName))).toEqual(original);
			}
			expect(mocks.write).not.toHaveBeenCalled();
		},
	);
	it.each(cases)(
		"stores a genuine empty match for %s",
		async (toolName, _activity, run) => {
			configureEmpty(toolName);
			await run(scope(toolName));
			expect(mocks.write).toHaveBeenCalledOnce();
		},
	);
	it.each(cases)(
		"returns %s unchanged if the store fails",
		async (toolName, _activity, run) => {
			const original = await run();
			mocks.write.mockRejectedValue(new Error("example unavailable"));
			expect(await run(scope(toolName))).toEqual(original);
			expect(mocks.write).toHaveBeenCalledOnce();
		},
	);
	it.each(cases)(
		"optional store metadata preserves the new %s activity's output",
		async (toolName, _activity, run) => {
			const original = await run();
			expect(await run(scope(toolName))).toEqual(original);
		},
	);
	it("skips workspace retrieval when no workspaces were requested", async () => {
		await inActivity(
			retrieveWorkspaceDocumentsActivity,
			"example query",
			owner.userId,
			owner.organizationId,
			[],
			undefined,
			5,
			undefined,
			{ advisorResultStore: scope("workspace_rag_query") },
		);
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("skips workspace retrieval when no requested workspace was authorized", async () => {
		mocks.filter.mockResolvedValue({
			allowed: [],
			dropped: ["example-workspace"],
		});
		await cases[1][2](scope("workspace_rag_query"));
		expect(mocks.write).not.toHaveBeenCalled();
	});

	it("preserves shared meeting callers that supply no success observer", async () => {
		const direct = await listProjectMeetingTranscripts({
			...owner,
			projectId: "example-project",
			filters: {},
		});
		expect(direct).toEqual(await cases[3][2]());
		expect(mocks.write).not.toHaveBeenCalled();
	});

	it("skips a workspace settings fallback even with populated passages", async () => {
		mocks.settings.mockRejectedValue(
			new Error("example settings unavailable"),
		);
		await cases[1][2](scope("workspace_rag_query"));
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("skips Teams extractor fallbacks without changing the returned messages", async () => {
		mocks.extract.mockResolvedValue({ ...excerpts, fallback: true });
		const result = await cases[5][2](scope("search_teams_messages"));
		expect(result).toMatchObject({
			messages: expect.arrayContaining([
				expect.objectContaining({ content: "Example Teams message" }),
			]),
		});
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("skips a Teams vendor error response without throwing", async () => {
		mocks.teams.mockResolvedValue({
			messages: [],
			count: 0,
			error: "example vendor error",
		});
		await cases[5][2](scope("search_teams_messages"));
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it("does not snapshot denied meeting access", async () => {
		mocks.access.mockResolvedValue(false);
		await cases[3][2](scope("fabric_list_meeting_transcripts"));
		expect(mocks.write).not.toHaveBeenCalled();
	});
	it.each([cases[4], cases[5]])(
		"does not store an unconfigured %s search",
		async (toolName, _activity, run) => {
			mocks.contexts.mockResolvedValue([]);
			await run(scope(toolName));
			expect(mocks.write).not.toHaveBeenCalled();
		},
	);
});
describe("built-in producers through the real workflow loop", () => {
	it.each(cases)(
		"threads store fields to %s and stores precisely the populated result the workflow records",
		async (toolName, activity) => {
			const producers: Record<string, unknown> = {
				retrieveProjectContextsActivity,
				retrieveWorkspaceDocumentsActivity,
				listMeetingTranscriptsActivity,
				searchProjectSlackMessages,
				searchProjectTeamsMessages,
			};
			mocks
				.stub(activity)
				.mockImplementation((...args: unknown[]) =>
					inActivity(
						producers[activity] as (
							...args: unknown[]
						) => Promise<unknown>,
						...args,
					),
				);
			const { state } = await runTurn(mocks, {
				message: "Read the example evidence",
				workspaceIds: ["example-workspace"],
				preload: preloaded([toolName], "fabric-ai-server", "Fabric"),
				input: {
					...owner,
					turnId: "example-turn",
					conversationId: "example-conversation",
				},
				steps: [
					{
						calls: [
							{
								name: toolName,
								args: { query: "example query" },
							},
						],
					},
					{ answer: "The evidence is complete." },
				],
			});
			expect(mocks.stub(activity)).toHaveBeenCalledOnce();
			const activityArgs = mocks.stub(activity).mock.calls[0];
			const options =
				activityArgs.length === 1
					? activityArgs[0]
					: activityArgs.at(-1);
			expect(options.advisorResultStore).toEqual({
				toolName,
				conversationId: "example-conversation",
				turnId: "example-turn",
				sourceKey: "exec-advisor-1:0",
			});
			expect(state.toolCalls).toHaveLength(1);
			expect(state.toolCalls[0].status).toBe("success");
			expect(mocks.write).toHaveBeenCalledExactlyOnceWith({
				...owner,
				conversationId: "example-conversation",
				turnId: "example-turn",
				sourceKey: "exec-advisor-1:0",
				toolName,
				attempt: 3,
				text: extractMcpResultText(state.toolCalls[0].result),
			});
			expect(mocks.write.mock.calls[0][0].text).toContain("Example");
		},
	);
});
