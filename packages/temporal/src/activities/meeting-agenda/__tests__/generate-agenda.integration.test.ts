import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * End-to-end verification of the agenda ACTIVITY against real Postgres (#2105).
 *
 * This is the deepest slice reachable without a browser: the real collector
 * reads real rows, the real prompt builder runs, the real renderer produces the
 * markdown, and the real row is written back and read out of the database. Only
 * the LLM is stubbed — it is the one dependency that needs Azure credentials,
 * and its OUTPUT is what the renderer consumes, so stubbing it lets the split
 * be asserted deterministically instead of hoping a model classifies correctly.
 *
 * What this does NOT cover, deliberately and stated rather than implied: the
 * browser flow, the oRPC procedure's Temporal dispatch, and the Microsoft Graph
 * upcoming-meetings list that is the feature's entry point. Those need a running
 * worker, Azure credentials and a live Graph connection.
 *
 * Gated on RUN_DB_INTEGRATION=1.
 */

const aiMock = vi.hoisted(() => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/ai", () => aiMock);

import { db } from "@repo/database";
import { generateAgendaActivity } from "../generate-agenda";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const suite = RUN_DB ? describe : describe.skip;

const NS = "it2105gen";
const USER_ID = `${NS}_user`;
const ORG_ID = `${NS}_org`;
const PROJECT_ID = `${NS}_project`;
const SERIES_ID = `${NS}_series`;
const AGENDA_ID = `${NS}_agenda`;

const OCCURRENCE_START = new Date("2026-08-05T09:00:00Z");
const daysBefore = (n: number) =>
	new Date(OCCURRENCE_START.getTime() - n * 24 * 60 * 60 * 1000);

async function cleanup() {
	await db.project.deleteMany({ where: { id: PROJECT_ID } });
	await db.organization.deleteMany({ where: { id: ORG_ID } });
	await db.user.deleteMany({ where: { id: USER_ID } });
}

suite("generateAgendaActivity against real Postgres (#2105)", () => {
	beforeAll(async () => {
		await cleanup();

		await db.user.create({
			data: {
				id: USER_ID,
				name: "Integration Fixture",
				email: `${NS}@example.test`,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		await db.organization.create({
			data: {
				id: ORG_ID,
				name: "Integration Org",
				createdAt: new Date(),
			},
		});
		await db.project.create({
			data: {
				id: PROJECT_ID,
				name: "Integration Project",
				userId: USER_ID,
				organizationId: ORG_ID,
			},
		});
		await db.projectLinkedMeeting.create({
			data: {
				id: SERIES_ID,
				projectId: PROJECT_ID,
				joinUrl: `https://teams.example.test/${NS}`,
				subject: "Weekly Sync",
				userId: USER_ID,
				organizationId: ORG_ID,
			},
		});
		await db.projectMeetingTranscript.create({
			data: {
				id: `${NS}_t1`,
				projectId: PROJECT_ID,
				linkedMeetingId: SERIES_ID,
				meetingId: `graph_${NS}_t1`,
				transcriptId: `tr_${NS}_t1`,
				meetingSubject: "Weekly Sync",
				meetingDate: daysBefore(7),
				summary: "Rollout sequencing discussed.",
				userId: USER_ID,
				organizationId: ORG_ID,
			},
		});
		await db.projectMeetingActionItem.create({
			data: {
				id: `${NS}_ai1`,
				transcriptId: `${NS}_t1`,
				orderIndex: 0,
				text: "Chase the vendor contract",
				tentativeOwnerName: "Dana",
				userId: USER_ID,
				organizationId: ORG_ID,
			},
		});
		await db.projectMeetingAgenda.create({
			data: {
				id: AGENDA_ID,
				projectId: PROJECT_ID,
				linkedMeetingId: SERIES_ID,
				occurrenceStart: OCCURRENCE_START,
				status: "GENERATING",
				createdById: USER_ID,
				userId: USER_ID,
				organizationId: ORG_ID,
			},
		});

		aiMock.getAIModelWithMetadata.mockResolvedValue({
			model: {},
			metadata: {},
			trackUsage: vi.fn(),
		});
		// Shaped as the model is instructed to answer: the carried item flagged,
		// the other not.
		aiMock.generateObject.mockResolvedValue({
			object: {
				items: [
					{
						title: "Vendor contract",
						intent: "carry_over",
						carriedForward: true,
					},
					{
						title: "Auth provider decision",
						intent: "decision",
						carriedForward: false,
					},
				],
			},
			usage: { inputTokens: 1, outputTokens: 1 },
		});
	}, 60_000);

	afterAll(async () => {
		await cleanup();
		await db.$disconnect();
	});

	it("writes a split agenda and the new provenance stats to the row", async () => {
		const result = await generateAgendaActivity({
			agendaId: AGENDA_ID,
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			userId: USER_ID,
			linkedMeetingId: SERIES_ID,
		});
		expect(result.status).toBe("READY");

		const row = await db.projectMeetingAgenda.findUniqueOrThrow({
			where: { id: AGENDA_ID },
		});

		expect(row.status).toBe("READY");
		// FR2, as it lands in the database and therefore in the sheet.
		expect(row.content).toContain("### Old business");
		expect(row.content).toContain("### New items");
		expect(row.content?.indexOf("### Old business")).toBeLessThan(
			row.content?.indexOf("### New items") ?? -1,
		);

		const stats = row.contextStats as Record<string, unknown>;
		expect(stats.hadPriorTranscripts).toBe(true);
		expect(stats.priorTranscriptCount).toBe(1);
		expect(stats.carriedActionItemCount).toBe(1);
		expect(stats.priorMeetingWindowDays).toBe(90);
	});

	it("feeds the real carried item into the prompt it sends the model", async () => {
		const prompt = aiMock.generateObject.mock.calls.at(-1)?.[0]
			?.prompt as string;

		expect(prompt).toContain("Carried forward");
		expect(prompt).toContain("Chase the vendor contract");
		expect(prompt).toContain("Dana");
	});
});
