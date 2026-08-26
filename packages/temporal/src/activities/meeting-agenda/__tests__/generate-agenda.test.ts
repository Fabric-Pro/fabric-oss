import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	projectMeetingAgenda: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
	projectLinkedMeeting: { findUniqueOrThrow: vi.fn() },
}));
const aiMock = vi.hoisted(() => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));
const collectMock = vi.hoisted(() => ({
	collectAgendaContextActivity: vi.fn(),
}));
const promptMock = vi.hoisted(() => ({
	getBoundPromptForAgent: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: dbMock,
	setAiUsageRecorder: vi.fn(),
	...promptMock,
}));
vi.mock("@repo/ai", () => aiMock);
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../collect-agenda-context", async (importOriginal) => ({
	...(await importOriginal<object>()),
	...collectMock,
}));

import {
	generateAgendaActivity,
	markAgendaFailedActivity,
} from "../generate-agenda";

const INPUT = {
	agendaId: "ag_1",
	projectId: "p1",
	organizationId: "org1",
	userId: "u1",
	linkedMeetingId: "lm_1",
};

const CONTEXT = {
	priorMeetings: [],
	hadPriorTranscripts: false,
	carriedActionItems: [],
	openActionItems: [
		{
			text: "Draft the migration",
			tentativeOwnerName: null,
			dueHint: null,
		},
	],
	openDecisions: [],
	blockedStories: [],
	truncated: {
		actionItems: false,
		decisions: false,
		blockedStories: false,
		carriedActionItems: false,
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	// Nothing bound by default (#2178), so these exercise the in-code fallback
	// body — the same prompt this activity built before the prompt was editable.
	promptMock.getBoundPromptForAgent.mockResolvedValue(null);
	collectMock.collectAgendaContextActivity.mockResolvedValue(CONTEXT);
	dbMock.projectMeetingAgenda.findUniqueOrThrow.mockResolvedValue({
		id: "ag_1",
		occurrenceStart: new Date("2026-07-25T09:00:00Z"),
	});
	dbMock.projectLinkedMeeting.findUniqueOrThrow.mockResolvedValue({
		subject: "Fabric DSU",
	});
	dbMock.projectMeetingAgenda.update.mockResolvedValue({});
	aiMock.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { provider: "azure" },
		trackUsage: vi.fn(),
	});
	aiMock.generateObject.mockResolvedValue({
		object: {
			items: [{ title: "Carry-over actions", intent: "carry_over" }],
		},
		usage: { inputTokens: 100, outputTokens: 50 },
	});
});

describe("generateAgendaActivity", () => {
	it("disables strict JSON schema so Azure accepts optional fields (bug #1681)", async () => {
		await generateAgendaActivity(INPUT);

		expect(aiMock.generateObject).toHaveBeenCalledWith(
			expect.objectContaining({
				providerOptions: { openai: { strictJsonSchema: false } },
			}),
		);
	});

	it("persists rendered markdown, READY status, and the context stats", async () => {
		await generateAgendaActivity(INPUT);

		const update = dbMock.projectMeetingAgenda.update.mock.calls[0][0];
		expect(update.where).toEqual({ id: "ag_1" });
		expect(update.data).toMatchObject({
			status: "READY",
			content: expect.stringContaining("Carry-over actions"),
			contextStats: {
				hadPriorTranscripts: false,
				priorTranscriptCount: 0,
				openActionItemCount: 1,
				openDecisionCount: 0,
				blockedStoryCount: 0,
				truncated: {
					actionItems: false,
					decisions: false,
					blockedStories: false,
				},
			},
			generatedStructure: {
				items: [{ title: "Carry-over actions", intent: "carry_over" }],
			},
			generationError: null,
		});
		expect(update.data.generatedAt).toBeInstanceOf(Date);
	});

	it("uses the COMPLEX model tier and logs usage", async () => {
		await generateAgendaActivity(INPUT);

		expect(aiMock.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			{ userId: "u1", organizationId: "org1" },
		);
		expect(aiMock.logModelUsageAsync).toHaveBeenCalled();
	});

	it("rethrows LLM failures so the workflow retry policy engages", async () => {
		aiMock.generateObject.mockRejectedValue(new Error("model timeout"));

		await expect(generateAgendaActivity(INPUT)).rejects.toThrow(
			"model timeout",
		);
		// Must NOT write a READY row on failure.
		expect(dbMock.projectMeetingAgenda.update).not.toHaveBeenCalled();
	});

	it("bumps version and clears editedAt/editedById on the READY write (#1901 final review, FIX 3)", async () => {
		// version was previously written in exactly one place (saveAgenda's
		// updateMany) — a regenerate left it unchanged, so an admin who had the
		// pre-regenerate row open at v1 could save with expectedVersion: 1 and
		// silently overwrite the regenerated content; the version-conflict UI
		// built to prevent exactly this never fired. Clearing editedAt/editedById
		// here also stops D7's "this agenda has been edited" guard from firing
		// forever after a single edit once a fresh generation supersedes it.
		await generateAgendaActivity(INPUT);

		const update = dbMock.projectMeetingAgenda.update.mock.calls[0][0];
		expect(update.data).toMatchObject({
			version: { increment: 1 },
			editedAt: null,
			editedById: null,
		});
	});
});

describe("prompt binding tenancy (#2178)", () => {
	it("asks for the org binding in org context and the personal one otherwise", async () => {
		// The XOR itself is implemented in getBoundPromptVersion; this pins that
		// the activity hands it the right context. Passing a non-null
		// organizationId on a personal run would leak a user's personal prompt
		// into a team agenda — the most expensive thing here to get wrong.
		await generateAgendaActivity(INPUT);

		expect(promptMock.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "meeting_agenda_generator",
				documentType: "GENERAL",
				storyKind: null,
				organizationId: "org1",
				userId: "u1",
			}),
		);

		promptMock.getBoundPromptForAgent.mockClear();

		await generateAgendaActivity({ ...INPUT, organizationId: null });

		expect(promptMock.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: undefined,
				userId: "u1",
			}),
		);
	});

	it("uses a bound prompt body over the in-code default", async () => {
		promptMock.getBoundPromptForAgent.mockResolvedValue({
			format: "HANDLEBARS",
			version: { content: "ORG CUSTOM BODY {{{open_action_items}}}" },
		});

		await generateAgendaActivity(INPUT);

		const { prompt } = aiMock.generateObject.mock.calls[0][0];
		expect(prompt).toContain("ORG CUSTOM BODY");
		expect(prompt).toContain("Draft the migration");
		// The locked clause survives an override that never mentions it.
		expect(prompt).toContain("Invent nothing");
	});
});

/**
 * A degraded run produces an agenda indistinguishable from a healthy one, so
 * which prompt produced it is recorded on the row rather than left to a log
 * line nobody is watching. Display-only — nothing re-reads this.
 */
describe("prompt provenance", () => {
	const provenanceOf = () =>
		dbMock.projectMeetingAgenda.update.mock.calls[0][0].data
			.promptProvenance;

	it("records the bound prompt's identity and version", async () => {
		promptMock.getBoundPromptForAgent.mockResolvedValue({
			id: "prm_1",
			key: "meeting_agenda_generator",
			name: "Meeting Agenda Generator",
			scope: "ORG",
			format: "HANDLEBARS",
			version: {
				version: 4,
				content: "ORG CUSTOM BODY {{{open_action_items}}}",
			},
		});

		await generateAgendaActivity(INPUT);

		expect(provenanceOf()).toMatchObject({
			source: "BOUND",
			promptId: "prm_1",
			promptKey: "meeting_agenda_generator",
			promptName: "Meeting Agenda Generator",
			promptScope: "ORG",
			promptVersion: 4,
			formatOverridden: false,
		});
	});

	it("records DEFAULT_UNBOUND when nothing is bound", async () => {
		promptMock.getBoundPromptForAgent.mockResolvedValue(null);

		await generateAgendaActivity(INPUT);

		expect(provenanceOf()).toMatchObject({
			source: "DEFAULT_UNBOUND",
			promptId: null,
			promptVersion: null,
		});
	});

	it("records DEFAULT_RENDER_FAILED when a bound body could not render", async () => {
		// The agenda still comes out looking fine — it was built from the
		// default body — so without this the degradation is invisible to
		// whoever wrote the broken prompt.
		promptMock.getBoundPromptForAgent.mockResolvedValue({
			id: "prm_2",
			key: "meeting_agenda_generator",
			name: "Meeting Agenda Generator",
			scope: "ORG",
			format: "HANDLEBARS",
			version: {
				version: 5,
				content: "{{#if has_open_action_items}}oops",
			},
		});

		await generateAgendaActivity(INPUT);

		expect(provenanceOf()).toMatchObject({
			source: "DEFAULT_RENDER_FAILED",
			promptId: "prm_2",
			promptVersion: 5,
		});
	});

	it("flags a format the prompt library accepts but that does no templating", async () => {
		promptMock.getBoundPromptForAgent.mockResolvedValue({
			id: "prm_3",
			key: "meeting_agenda_generator",
			name: "Meeting Agenda Generator",
			scope: "SYSTEM",
			format: "MARKDOWN",
			version: { version: 1, content: "BODY {{{open_action_items}}}" },
		});

		await generateAgendaActivity(INPUT);

		expect(provenanceOf()).toMatchObject({
			source: "BOUND",
			formatOverridden: true,
		});
	});
});

describe("markAgendaFailedActivity", () => {
	it("flips the row to FAILED with the message", async () => {
		await markAgendaFailedActivity({ agendaId: "ag_1", message: "boom" });

		expect(dbMock.projectMeetingAgenda.update).toHaveBeenCalledWith({
			where: { id: "ag_1" },
			data: { status: "FAILED", generationError: "boom" },
		});
	});
});
