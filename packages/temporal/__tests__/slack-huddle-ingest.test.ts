/**
 * Unit/integration tests for the Slack huddle-notes ingest activity.
 *
 * Postgres / Slack / Qdrant are mocked. Validates:
 *   - create path: a SLACK_HUDDLE_NOTES context is created with correct tenant
 *     fields + metadata, a tracking row is upserted, and the embedding workflow
 *     is started — `removeContextEmbedding` is NOT called.
 *   - update-in-place path: a changed body updates the SAME context id, refreshes
 *     the tracking row, and CLEARS prior vectors (`removeContextEmbedding`) before
 *     re-embedding.
 *   - empty body → skipped, no context created.
 *   - tenant fields (org vs personal) propagate into the created rows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const m = vi.hoisted(() => ({
	// @repo/database
	contextCreate: vi.fn(),
	contextUpdate: vi.fn(),
	huddleFindUnique: vi.fn(),
	upsertRecord: vi.fn(),
	updateLastRun: vi.fn(),
	getLinkedChannels: vi.fn(),
	// @repo/integrations/slack
	executeSlackTool: vi.fn(),
	getSlackCredentials: vi.fn(),
	downloadSlackFile: vi.fn(),
	resolveUserNames: vi.fn(),
	// @repo/rag
	removeContextEmbedding: vi.fn(),
	// temporal client
	workflowStart: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		db: {
			projectContext: {
				create: m.contextCreate,
				update: m.contextUpdate,
			},
			projectSlackHuddleNote: {
				findUnique: m.huddleFindUnique,
			},
		},
		getLinkedSlackHuddleChannels: m.getLinkedChannels,
		upsertSlackHuddleNoteRecord: m.upsertRecord,
		updateSlackHuddleIngestLastRun: m.updateLastRun,
	};
});

// Real error classes + pure helpers, but mocked network/credential surfaces.
vi.mock("@repo/integrations/slack", async () => {
	const actual = await vi.importActual<
		typeof import("@repo/integrations/slack")
	>("@repo/integrations/slack");
	return {
		...actual,
		executeSlackTool: m.executeSlackTool,
		getSlackCredentials: m.getSlackCredentials,
		downloadSlackFile: m.downloadSlackFile,
		resolveUserNames: m.resolveUserNames,
	};
});

vi.mock("@repo/rag", () => ({
	removeContextEmbedding: m.removeContextEmbedding,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

vi.mock("../src/client", () => ({
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: { start: m.workflowStart },
	}),
}));

import { ingestHuddleNotesForChannelActivity } from "../src/activities/slack-channel-monitor/ingest-huddle-notes";

const HUDDLE_HTML =
	"<h1>Huddle Summary</h1><p><strong>10:00</strong> Talked to <@U123></p><ul><li>Ship migration</li></ul>";

function huddleCanvas(overrides: Record<string, unknown> = {}) {
	return {
		id: "F_CANVAS",
		urlPrivate: "https://files.slack.com/F_CANVAS",
		mimetype: "application/vnd.slack-docs",
		filetype: "quip",
		created: 1_700_000_000,
		channelId: "C1",
		title: "Sprint sync",
		isHuddleCanvas: true,
		huddleTranscriptFileId: "F_T",
		huddleSummaryId: "S_1",
		huddleDateStart: 1_700_000_100,
		huddleDateEnd: 1_700_000_900,
		...overrides,
	};
}

const BASE_INPUT = {
	projectId: "p1",
	linkedChannelId: "lc1",
	channelId: "C1",
	slackTeamId: "T1",
	channelName: "eng-sync",
	userId: "u1",
	organizationId: undefined as string | undefined,
	enabledAtMs: 1_699_000_000_000,
};

describe("ingestHuddleNotesForChannelActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		m.getSlackCredentials.mockResolvedValue({ accessToken: "xoxb-test" });
		m.executeSlackTool.mockResolvedValue({ files: [huddleCanvas()] });
		m.downloadSlackFile.mockResolvedValue({
			buffer: Buffer.from(HUDDLE_HTML, "utf8"),
			mime: "text/html",
			size: HUDDLE_HTML.length,
		});
		m.resolveUserNames.mockResolvedValue(new Map([["U123", "ada"]]));
		m.contextCreate.mockResolvedValue({ id: "ctx-new" });
		m.contextUpdate.mockResolvedValue({ id: "ctx-existing" });
		m.upsertRecord.mockResolvedValue({ didChange: true, prior: null });
		m.removeContextEmbedding.mockResolvedValue(undefined);
		m.workflowStart.mockResolvedValue({ workflowId: "wf-1" });
	});

	it("create path: stores a SLACK_HUDDLE_NOTES context + tracking row + embedding; no vector clear", async () => {
		m.huddleFindUnique.mockResolvedValue(null);

		const out = await ingestHuddleNotesForChannelActivity(BASE_INPUT);

		expect(out.ingested).toBe(1);
		expect(out.canvasesDetected).toBe(1);

		// Context created with correct type + tenant + metadata.
		const createArg = m.contextCreate.mock.calls[0][0].data;
		expect(createArg.type).toBe("SLACK_HUDDLE_NOTES");
		expect(createArg.userId).toBe("u1");
		expect(createArg.metadata.provider).toBe("slack");
		expect(createArg.metadata.canvasId).toBe("F_CANVAS");
		// mention resolved into the stored body
		expect(createArg.content).toContain("@ada");
		expect(createArg.content).toContain(
			"## Slack Huddle Notes: Sprint sync",
		);

		// Tracking row upserted, embedding started, NO vector clear on create.
		expect(m.upsertRecord).toHaveBeenCalledTimes(1);
		expect(m.workflowStart).toHaveBeenCalledTimes(1);
		expect(m.workflowStart.mock.calls[0][0]).toBe(
			"contextEmbeddingWorkflow",
		);
		expect(m.removeContextEmbedding).not.toHaveBeenCalled();
	});

	it("update-in-place: changed body updates same context id, clears vectors, re-embeds", async () => {
		m.huddleFindUnique.mockResolvedValue({
			id: "row1",
			contentHash: "OLD_HASH",
			contextId: "ctx-existing",
		});

		const out = await ingestHuddleNotesForChannelActivity(BASE_INPUT);

		expect(out.updated).toBe(1);
		// Same context id updated in place.
		expect(m.contextUpdate).toHaveBeenCalledTimes(1);
		expect(m.contextUpdate.mock.calls[0][0].where).toEqual({
			id: "ctx-existing",
		});
		expect(m.contextCreate).not.toHaveBeenCalled();
		// Clear-before-write invariant: remove stale vectors, THEN re-embed.
		expect(m.removeContextEmbedding).toHaveBeenCalledWith(
			"ctx-existing",
			undefined,
		);
		expect(m.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("no-op: same content hash → skipped, no context write, no embedding", async () => {
		// Pre-compute the hash the activity will derive from the parsed body so
		// the no-op branch trips deterministically.
		const {
			quipHtmlToMarkdown,
			computeHuddleContentHash,
			replaceMentions,
		} = await import("@repo/integrations/slack");
		let body = quipHtmlToMarkdown(HUDDLE_HTML);
		body = replaceMentions(body, new Map([["U123", "ada"]]));
		const sameHash = computeHuddleContentHash(body);

		m.huddleFindUnique.mockResolvedValue({
			id: "row1",
			contentHash: sameHash,
			contextId: "ctx-existing",
		});

		const out = await ingestHuddleNotesForChannelActivity(BASE_INPUT);

		expect(out.skipped).toBe(1);
		expect(m.contextCreate).not.toHaveBeenCalled();
		expect(m.contextUpdate).not.toHaveBeenCalled();
		expect(m.removeContextEmbedding).not.toHaveBeenCalled();
		expect(m.workflowStart).not.toHaveBeenCalled();
	});

	it("empty body → skipped, no context created", async () => {
		m.downloadSlackFile.mockResolvedValue({
			buffer: Buffer.from("<p>   </p>", "utf8"),
			mime: "text/html",
			size: 10,
		});
		m.huddleFindUnique.mockResolvedValue(null);

		const out = await ingestHuddleNotesForChannelActivity(BASE_INPUT);

		expect(out.skipped).toBe(1);
		expect(out.ingested).toBe(0);
		expect(m.contextCreate).not.toHaveBeenCalled();
		expect(m.workflowStart).not.toHaveBeenCalled();
	});

	it("propagates organization tenant fields into the created rows", async () => {
		m.huddleFindUnique.mockResolvedValue(null);

		await ingestHuddleNotesForChannelActivity({
			...BASE_INPUT,
			organizationId: "org-7",
		});

		expect(m.contextCreate.mock.calls[0][0].data.organizationId).toBe(
			"org-7",
		);
		expect(m.upsertRecord.mock.calls[0][0].organizationId).toBe("org-7");
	});
});
