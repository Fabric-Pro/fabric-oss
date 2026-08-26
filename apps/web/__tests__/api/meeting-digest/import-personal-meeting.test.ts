import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2170 — importing a personal meeting into a project as context.
 *
 * This is the one procedure in the personal-meeting lane that writes. Every
 * test below is really asking the same question from a different angle: does it
 * write ONLY when a person deliberately asked, and does it write the row every
 * other project surface already knows how to read?
 *
 * The paths that must write nothing (no transcript, no access, duplicate, over
 * the ceiling, flag off, no project access) are asserted on
 * `createContext.not.toHaveBeenCalled()` rather than on the returned status
 * alone — a status is a claim, an uncalled writer is the fact.
 */

const {
	isFeatureEnabled,
	hasProjectAccess,
	createContext,
	findFirstContext,
	executeMicrosoftTeamsTool,
	workflowStart,
	emitContextChange,
	emitActivity,
	loggerError,
} = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	hasProjectAccess: vi.fn(),
	createContext: vi.fn(),
	findFirstContext: vi.fn(),
	executeMicrosoftTeamsTool: vi.fn(),
	workflowStart: vi.fn(),
	emitContextChange: vi.fn(),
	emitActivity: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: vi.fn(),
		info: vi.fn(),
		error: loggerError,
		debug: vi.fn(),
	},
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		isFeatureEnabled,
		hasProjectAccess,
		createContext,
		db: { ...actual.db, projectContext: { findFirst: findFirstContext } },
	};
});

vi.mock("@repo/integrations/microsoft", async () => {
	const { isMicrosoftNotConnectedError } = await vi.importActual<
		typeof import("@repo/integrations/microsoft/connection-errors")
	>("@repo/integrations/microsoft/connection-errors");

	return { executeMicrosoftTeamsTool, isMicrosoftNotConnectedError };
});

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: workflowStart } }),
}));

vi.mock("../../../../../packages/api/lib/realtime", () => ({
	emitContextChange,
	emitActivity,
}));

import { importPersonalMeetingProcedure } from "@repo/api/modules/projects/procedures/meeting-digest/import-personal-meeting";
import { MAX_IMPORT_CHARS } from "@repo/api/modules/projects/procedures/meeting-digest/import-personal-meeting-content";

const INPUT = {
	projectId: "p1",
	organizationId: null,
	joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
	startTime: "2026-08-14T09:00:00Z",
	meetingSubject: "Weekly sync",
};

const CTX = {
	context: { user: { id: "u1", name: "Ada" }, session: {} },
	errors: {},
};

function invoke(input: Record<string, unknown> = INPUT) {
	return importPersonalMeetingProcedure["~orpc"].handler({
		input,
		...CTX,
	} as never);
}

const TRANSCRIPT = [
	"Ada: the importer should reuse the context pipeline.",
	"Grace: agreed, and we need a confirmation step before it writes.",
].join("\n");

function mockGraph(overrides: Record<string, unknown> = {}) {
	const responses: Record<string, unknown> = {
		get_meeting_by_join_url: { meeting: { id: "m1" } },
		list_meeting_transcripts: {
			transcripts: [
				{ id: "t1", createdDateTime: "2026-08-14T09:05:00Z" },
			],
		},
		get_meeting_transcript_content: { content: TRANSCRIPT },
		...overrides,
	};
	executeMicrosoftTeamsTool.mockImplementation(
		async (method: string) => responses[method],
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	isFeatureEnabled.mockResolvedValue(true);
	hasProjectAccess.mockResolvedValue(true);
	findFirstContext.mockResolvedValue(null);
	createContext.mockResolvedValue({ id: "ctx-1" });
	workflowStart.mockResolvedValue(undefined);
	emitContextChange.mockResolvedValue(undefined);
	emitActivity.mockResolvedValue(undefined);
	mockGraph();
});

describe("importPersonalMeeting — the happy path (AC1)", () => {
	it("stores the transcript as a MEETING_TRANSCRIPT context on the project", async () => {
		const result = await invoke();

		expect(result).toEqual({ status: "imported", contextId: "ctx-1" });
		expect(createContext).toHaveBeenCalledTimes(1);

		const written = createContext.mock.calls[0][0];
		expect(written.projectId).toBe("p1");
		expect(written.type).toBe("MEETING_TRANSCRIPT");
		expect(written.content).toContain("## Meeting Transcript: Weekly sync");
		expect(written.content).toContain(TRANSCRIPT);
		expect(written.extractionStatus).toBe("COMPLETED");
	});

	it("stamps the tenant fields so the row lands on the right side of the XOR", async () => {
		await invoke({ ...INPUT, organizationId: "org-1" });

		const written = createContext.mock.calls[0][0];
		expect(written.userId).toBe("u1");
		expect(written.organizationId).toBe("org-1");
	});

	it("records the dedup key and marks the row as a deliberate import", async () => {
		await invoke();

		const { metadata } = createContext.mock.calls[0][0];
		expect(metadata).toMatchObject({
			provider: "microsoft-teams",
			origin: "personal-import",
			meetingId: "m1",
			transcriptId: "t1",
			joinUrl: INPUT.joinUrl,
			meetingSubject: "Weekly sync",
			importedByUserId: "u1",
			wasSummarized: false,
		});
	});

	it("embeds the context so it is reachable by RAG, not just by the contexts list (FR4)", async () => {
		await invoke();

		expect(workflowStart).toHaveBeenCalledTimes(1);
		const [workflowName, options] = workflowStart.mock.calls[0];
		expect(workflowName).toBe("contextEmbeddingWorkflow");
		expect(options.args[0]).toMatchObject({
			contextId: "ctx-1",
			projectId: "p1",
			type: "MEETING_TRANSCRIPT",
		});
	});

	it("announces the new context to the project like any other source", async () => {
		await invoke();

		expect(emitContextChange).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p1",
				contextId: "ctx-1",
				action: "added",
				contextType: "MEETING_TRANSCRIPT",
			}),
		);
		expect(emitActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p1",
				activityType: "context_added",
				resourceId: "ctx-1",
			}),
		);
	});

	// The context is already committed by this point. Failing the request would
	// tell the user their import did not happen when it did, and would invite a
	// retry that trips the duplicate check instead of fixing anything.
	it("still reports success when the embedding workflow cannot be started", async () => {
		workflowStart.mockRejectedValue(new Error("temporal unavailable"));

		await expect(invoke()).resolves.toEqual({
			status: "imported",
			contextId: "ctx-1",
		});
		expect(loggerError).toHaveBeenCalled();
	});
});

describe("importPersonalMeeting — nothing to import", () => {
	it.each([
		[
			"the meeting has no transcript yet",
			{ list_meeting_transcripts: { transcripts: [] } },
			"no-transcript",
		],
		[
			"a colleague organised the meeting",
			{ get_meeting_by_join_url: { meeting: null } },
			"no-transcript",
		],
		[
			"the tenant blocks Graph transcript access",
			{
				list_meeting_transcripts: {
					helpUrl: "https://aka.ms/help",
					error: "Microsoft Graph access to meeting transcripts is disabled for this tenant",
				},
			},
			"transcript-access-disabled",
		],
		[
			"the app registration lacks the transcript permission",
			{
				list_meeting_transcripts: {
					helpUrl: "https://aka.ms/help",
					error: "Forbidden",
				},
			},
			"admin-consent-required",
		],
	])("reports %s and writes nothing", async (_case, overrides, reason) => {
		mockGraph(overrides as Record<string, unknown>);

		await expect(invoke()).resolves.toEqual({
			status: "unavailable",
			reason,
		});
		expect(createContext).not.toHaveBeenCalled();
		expect(workflowStart).not.toHaveBeenCalled();
	});

	// The message is one the integration actually throws — the real
	// `isMicrosoftNotConnectedError` is imported rather than stubbed, so an
	// invented string would pass through as a generic 500 and this test would be
	// asserting nothing.
	it("reports not-connected rather than failing when Microsoft is not linked", async () => {
		executeMicrosoftTeamsTool.mockRejectedValue(
			new Error("Microsoft not connected"),
		);

		await expect(invoke()).resolves.toEqual({
			status: "unavailable",
			reason: "not-connected",
		});
		expect(createContext).not.toHaveBeenCalled();
	});
});

describe("importPersonalMeeting — duplicates (spec D2)", () => {
	it("returns the existing context instead of writing a second copy", async () => {
		findFirstContext.mockResolvedValue({ id: "ctx-existing" });

		await expect(invoke()).resolves.toEqual({
			status: "duplicate",
			contextId: "ctx-existing",
		});
		expect(createContext).not.toHaveBeenCalled();
	});

	it("matches on the Graph occurrence, not on the join URL", async () => {
		await invoke();

		const where = findFirstContext.mock.calls[0][0].where;
		expect(where.projectId).toBe("p1");
		expect(where.type).toBe("MEETING_TRANSCRIPT");
		expect(where.AND).toEqual([
			{ metadata: { path: ["meetingId"], equals: "m1" } },
			{ metadata: { path: ["transcriptId"], equals: "t1" } },
		]);
	});

	// Deliberately unscoped by `origin`: a transcript the team sync path already
	// pulled in is the same content, and an import must not shadow it with a
	// second row.
	it("treats a team-synced transcript for the same occurrence as a duplicate", async () => {
		findFirstContext.mockResolvedValue({ id: "ctx-from-sync" });

		await expect(invoke()).resolves.toMatchObject({
			status: "duplicate",
		});
		const where = findFirstContext.mock.calls[0][0].where;
		expect(JSON.stringify(where)).not.toContain("personal-import");
	});
});

describe("importPersonalMeeting — refusals", () => {
	it("refuses an absurd transcript outright rather than storing a slice of it", async () => {
		mockGraph({
			get_meeting_transcript_content: {
				content: `Ada: ${"x".repeat(MAX_IMPORT_CHARS + 1)}`,
			},
		});

		await expect(invoke()).resolves.toEqual({
			status: "too-large",
			limit: MAX_IMPORT_CHARS,
		});
		expect(createContext).not.toHaveBeenCalled();
	});

	it.each([
		["PERSONAL_MEETINGS", "MEETING_CONTEXT_IMPORT"],
		["MEETING_CONTEXT_IMPORT", "PERSONAL_MEETINGS"],
	])("refuses when %s is off even though %s is on", async (off) => {
		isFeatureEnabled.mockImplementation(
			async (flag: string) => flag !== off,
		);

		await expect(invoke()).rejects.toThrow();
		expect(createContext).not.toHaveBeenCalled();
		expect(executeMicrosoftTeamsTool).not.toHaveBeenCalled();
	});

	it("refuses a caller without access to the project", async () => {
		hasProjectAccess.mockResolvedValue(false);

		await expect(invoke()).rejects.toThrow();
		expect(createContext).not.toHaveBeenCalled();
		// The Graph read must not happen either: a rejected caller should not be
		// able to make Fabric fetch anything on their behalf.
		expect(executeMicrosoftTeamsTool).not.toHaveBeenCalled();
	});
});
