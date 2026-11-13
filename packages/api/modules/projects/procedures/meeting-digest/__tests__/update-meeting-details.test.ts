/**
 * Correcting a meeting's title or date (Fizzy #3507, FR13 and FR16).
 *
 * Pinned: a date can be set or cleared, a file's own series takes a new title
 * while a Teams series shared by every occurrence keeps its name, the meeting
 * must belong to the project, and the input never names its organization.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	transcriptFindFirst: vi.fn(),
	transcriptUpdate: vi.fn(),
	linkedUpdate: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		projectMeetingTranscript: { findFirst: mocks.transcriptFindFirst },
		$transaction: async (
			fn: (tx: Record<string, unknown>) => Promise<unknown>,
		) =>
			fn({
				projectMeetingTranscript: { update: mocks.transcriptUpdate },
				projectLinkedMeeting: { update: mocks.linkedUpdate },
			}),
	},
	LINKED_MEETING_SOURCE: { TEAMS: "TEAMS", UPLOAD: "UPLOAD" },
}));

vi.mock("../../../../../orpc/procedures", () => {
	const build = () => {
		const chain: Record<string, unknown> = {};
		for (const k of ["use", "route", "input"]) {
			chain[k] = () => chain;
		}
		chain.handler = (fn: unknown) => fn;
		return chain;
	};
	return {
		tenantProtectedProcedure: build(),
		requireProjectPermission: () => undefined,
		Permissions: { PROJECT_SETTINGS_EDIT: "project:settings:edit" },
	};
});

import { updateMeetingDetailsProcedure } from "../update-meeting-details";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

const update = updateMeetingDetailsProcedure as unknown as Handler;
const CONTEXT = { user: { id: "user-1" }, session: {} };

function transcript(source = "UPLOAD") {
	return {
		id: "transcript-1",
		linkedMeetingId: "series-1",
		linkedMeeting: { source },
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.transcriptFindFirst.mockResolvedValue(transcript());
	mocks.transcriptUpdate.mockImplementation(async ({ data }) => ({
		id: "transcript-1",
		...data,
	}));
	mocks.linkedUpdate.mockResolvedValue({});
});

describe("updateMeetingDetails", () => {
	it("dates an undated meeting, moving it onto the calendar", async () => {
		const day = new Date("2026-10-21T12:00:00.000Z");

		await update({
			input: {
				projectId: "project-1",
				transcriptId: "transcript-1",
				meetingDate: day,
			},
			context: CONTEXT,
		});

		expect(mocks.transcriptUpdate).toHaveBeenCalledWith({
			where: { id: "transcript-1" },
			data: { meetingDate: day },
			select: { id: true, meetingSubject: true, meetingDate: true },
		});
		expect(mocks.linkedUpdate).not.toHaveBeenCalled();
	});

	it("can say a date is not known after all", async () => {
		await update({
			input: {
				projectId: "project-1",
				transcriptId: "transcript-1",
				meetingDate: null,
			},
			context: CONTEXT,
		});

		expect(mocks.transcriptUpdate.mock.calls[0]?.[0].data).toEqual({
			meetingDate: null,
		});
	});

	it("renames a file's own series with its meeting", async () => {
		await update({
			input: {
				projectId: "project-1",
				transcriptId: "transcript-1",
				meetingSubject: "Sprint 12 retro",
			},
			context: CONTEXT,
		});

		expect(mocks.linkedUpdate).toHaveBeenCalledWith({
			where: { id: "series-1" },
			data: { subject: "Sprint 12 retro" },
		});
	});

	it("leaves a Teams series' name alone: every occurrence shares it", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(transcript("TEAMS"));

		await update({
			input: {
				projectId: "project-1",
				transcriptId: "transcript-1",
				meetingSubject: "Only this one",
			},
			context: CONTEXT,
		});

		expect(mocks.transcriptUpdate.mock.calls[0]?.[0].data).toEqual({
			meetingSubject: "Only this one",
		});
		expect(mocks.linkedUpdate).not.toHaveBeenCalled();
	});

	it("finds only meetings of this project", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(null);

		await expect(
			update({
				input: {
					projectId: "project-1",
					transcriptId: "elsewhere",
					meetingSubject: "x",
				},
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.transcriptFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "project-1", transcriptId: "elsewhere" },
			}),
		);
	});

	it("refuses an organization that is not the project's", async () => {
		await expect(
			update({
				input: {
					projectId: "project-1",
					organizationId: "org-2",
					transcriptId: "transcript-1",
					meetingSubject: "x",
				},
				context: CONTEXT,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.transcriptUpdate).not.toHaveBeenCalled();
	});
});
