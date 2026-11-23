import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	seriesFindFirst: vi.fn(),
	seriesUpdateMany: vi.fn(),
	sessionFindFirst: vi.fn(),
	liveSession: vi.fn(),
	isFeatureEnabled: vi.fn(),
	isProjectReadOnly: vi.fn(),
	assertProjectPermission: vi.fn(),
	readiness: vi.fn(),
	start: vi.fn(),
	guestPolicy: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectLinkedMeeting: {
			findFirst: mocks.seriesFindFirst,
			updateMany: mocks.seriesUpdateMany,
		},
		parlumeMeetingSession: { findFirst: mocks.sessionFindFirst },
	},
	isFeatureEnabled: mocks.isFeatureEnabled,
	isProjectReadOnly: mocks.isProjectReadOnly,
}));

vi.mock("../../../../orpc/procedures", () => ({
	assertProjectPermission: mocks.assertProjectPermission,
	Permissions: { PROJECT_MEMBERS_MANAGE: "project:members:manage" },
}));

vi.mock("../parlume-readiness", () => ({
	getParlumeReadiness: mocks.readiness,
	isParlumeReady: (readiness: {
		meetingBot: { ready: boolean };
		voice: { ready: boolean };
		platform: { ready: boolean };
	}) =>
		readiness.meetingBot.ready &&
		readiness.voice.ready &&
		readiness.platform.ready,
	PARLUME_VOICE_REQUIRED: "Add a voice provider in Settings → AI Providers.",
}));

vi.mock("../parlume-start", () => ({
	FABRIC_AGENT_KIND: "FABRIC_AGENT",
	findLiveParlumeSession: mocks.liveSession,
	PARLUME_ALREADY_IN_MEETING: "Parlume is already in this meeting.",
	PARLUME_MEETING_BOT_REQUIRED:
		"Add an Attendee API key in Settings → Meeting assistant.",
	PARLUME_PLATFORM_REQUIRED: "Ask the Fabric operator.",
	startParlumeMeetingSession: mocks.start,
}));

vi.mock("../parlume-provider-settings", () => ({
	resolveParlumeGuestPolicy: mocks.guestPolicy,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
	PARLUME_AUTO_JOIN_EXTERNAL_GUESTS,
	PARLUME_AUTO_JOIN_LATE,
	PARLUME_AUTO_JOIN_PERMISSION_LOST,
	PARLUME_AUTO_JOIN_READ_ONLY,
	runParlumeAutoJoin,
} = await import("../parlume-auto-join");

const occurrenceStart = new Date("2026-10-27T09:00:00.000Z");
const input = {
	linkedMeetingId: "lm-1",
	occurrenceStart,
	inviteeDomains: ["example.com"],
	inviteeEmails: ["dev.two@example.com"],
};
const JOIN_URL = "https://teams.microsoft.com/l/meetup-join/example-series";
const MINUTE = 60_000;

const ready = {
	meetingBot: { ready: true, source: "organization", webhookSigned: true },
	voice: { ready: true, engine: "realtime" },
	platform: { ready: true },
	canConfigure: true,
};

function series(overrides: Record<string, unknown> = {}) {
	return {
		id: "lm-1",
		projectId: "project-1",
		joinUrl: JOIN_URL,
		deactivatedAt: null,
		parlumeAutoJoin: true,
		parlumeAutoJoinUserId: "user-1",
		parlumeAutoJoinToolsReadOnly: false,
		parlumeAutoJoinSuggestions: false,
		parlumeAutoJoinSuggestionAudience: "MEETING",
		parlumeAutoJoinUser: { email: "dev.one@example.com" },
		project: { organizationId: "org-1" },
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	// The scheduler asks a minute before the occurrence starts.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(occurrenceStart.getTime() - MINUTE));
	mocks.seriesFindFirst.mockResolvedValue(series());
	mocks.seriesUpdateMany.mockResolvedValue({ count: 1 });
	mocks.sessionFindFirst.mockResolvedValue(null);
	mocks.liveSession.mockResolvedValue(null);
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.isProjectReadOnly.mockResolvedValue(false);
	mocks.assertProjectPermission.mockResolvedValue({
		projectId: "project-1",
		organizationId: "org-1",
	});
	mocks.readiness.mockResolvedValue(ready);
	mocks.start.mockResolvedValue({ session: { id: "session-1" } });
	mocks.guestPolicy.mockResolvedValue("NOTES_ONLY");
});

afterEach(() => {
	vi.useRealTimers();
});

function errorWrite() {
	return mocks.seriesUpdateMany.mock.calls.find(
		([args]) => typeof args.data.parlumeAutoJoinError === "string",
	)?.[0];
}

describe("runParlumeAutoJoin", () => {
	it("starts the built-in agent as the enabler, with the series' mode and suggestions, marked AUTO", async () => {
		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "started",
			sessionId: "session-1",
		});
		expect(mocks.assertProjectPermission).toHaveBeenCalledWith(
			"project-1",
			"user-1",
			"project:members:manage",
		);
		expect(mocks.start).toHaveBeenCalledWith(
			{
				projectId: "project-1",
				organizationId: "org-1",
				userId: "user-1",
				meetingUrl: JOIN_URL,
				agentKind: "FABRIC_AGENT",
				toolsReadOnly: false,
				suggestionsEnabled: false,
				suggestionAudience: "MEETING",
				trigger: "AUTO",
				linkedMeetingId: "lm-1",
				occurrenceStart,
				externalInvitees: false,
				inviteeEmails: ["dev.two@example.com"],
			},
			{},
		);
		expect(mocks.seriesUpdateMany).toHaveBeenCalledWith({
			where: { id: "lm-1", parlumeAutoJoinError: { not: null } },
			data: { parlumeAutoJoinError: null, parlumeAutoJoinErrorAt: null },
		});
	});

	it("joins a meeting whose invitation names an outside guest as a meeting with a guest, by default", async () => {
		await expect(
			runParlumeAutoJoin({
				...input,
				inviteeDomains: ["example.com", "partner.example"],
			}),
		).resolves.toEqual({ outcome: "started", sessionId: "session-1" });

		expect(mocks.guestPolicy).toHaveBeenCalledWith("org-1");
		expect(mocks.start).toHaveBeenCalledWith(
			expect.objectContaining({ externalInvitees: true }),
			{},
		);
	});

	it("keeps only the internal invitees' addresses on the session, lower-cased and once each", async () => {
		await runParlumeAutoJoin({
			...input,
			inviteeDomains: ["example.com", "partner.example"],
			inviteeEmails: [
				"Dev.Two@Example.com",
				"dev.two@example.com",
				"guest@partner.example",
				"dev.three@example.com.partner.example",
			],
		});

		expect(mocks.start).toHaveBeenCalledWith(
			expect.objectContaining({
				externalInvitees: true,
				inviteeEmails: ["dev.two@example.com"],
			}),
			{},
		);
	});

	it("keeps no invitee address when the enabler's own domain is unknown", async () => {
		mocks.seriesFindFirst.mockResolvedValue(
			series({ parlumeAutoJoinUser: null }),
		);

		await runParlumeAutoJoin(input);

		expect(mocks.start).toHaveBeenCalledWith(
			expect.objectContaining({ inviteeEmails: [] }),
			{},
		);
	});

	it("skips, and says why on the series, when the organization keeps Parlume to internal meetings", async () => {
		mocks.guestPolicy.mockResolvedValue("INTERNAL_ONLY");

		await expect(
			runParlumeAutoJoin({
				...input,
				inviteeDomains: ["partner.example"],
			}),
		).resolves.toEqual({
			outcome: "skipped",
			reason: "external_guests",
			message: PARLUME_AUTO_JOIN_EXTERNAL_GUESTS,
		});
		expect(errorWrite()?.data.parlumeAutoJoinError).toBe(
			PARLUME_AUTO_JOIN_EXTERNAL_GUESTS,
		);
		expect(mocks.start).not.toHaveBeenCalled();

		mocks.start.mockClear();
		await expect(runParlumeAutoJoin(input)).resolves.toMatchObject({
			outcome: "started",
		});
	});

	it("copies the series' suggestion audience into the session it starts", async () => {
		mocks.seriesFindFirst.mockResolvedValue(
			series({
				parlumeAutoJoinSuggestions: true,
				parlumeAutoJoinSuggestionAudience: "TEAM",
			}),
		);

		await runParlumeAutoJoin(input);

		expect(mocks.start).toHaveBeenCalledWith(
			expect.objectContaining({
				suggestionsEnabled: true,
				suggestionAudience: "TEAM",
			}),
			{},
		);
	});

	it.each([
		["switched off", { parlumeAutoJoin: false }],
		["no longer syncing", { deactivatedAt: new Date() }],
		["left without an enabler", { parlumeAutoJoinUserId: null }],
	])(
		"skips a series that was %s since it was planned",
		async (_label, overrides) => {
			mocks.seriesFindFirst.mockResolvedValue(series(overrides));

			await expect(runParlumeAutoJoin(input)).resolves.toEqual({
				outcome: "skipped",
				reason: "disabled",
			});
			expect(mocks.start).not.toHaveBeenCalled();
			expect(errorWrite()).toBeUndefined();
		},
	);

	it("skips a series that was unlinked", async () => {
		mocks.seriesFindFirst.mockResolvedValue(null);

		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "skipped",
			reason: "series_not_found",
		});
	});

	it.each(["PARLUME_MEETINGS", "MEETING_AGENDA"])(
		"skips while %s is off for the organization",
		async (flag) => {
			mocks.isFeatureEnabled.mockImplementation(
				async (key: string, organizationId: string) =>
					key !== flag && organizationId === "org-1",
			);

			await expect(runParlumeAutoJoin(input)).resolves.toEqual({
				outcome: "skipped",
				reason: "flag_off",
			});
			expect(mocks.start).not.toHaveBeenCalled();
		},
	);

	it("refuses, and says so on the series, when the enabler lost permission", async () => {
		mocks.assertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "Missing permission" }),
		);

		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "refused",
			reason: "permission_lost",
			message: PARLUME_AUTO_JOIN_PERMISSION_LOST,
		});
		expect(errorWrite()).toEqual({
			where: { id: "lm-1" },
			data: {
				parlumeAutoJoinError: PARLUME_AUTO_JOIN_PERMISSION_LOST,
				parlumeAutoJoinErrorAt: expect.any(Date),
			},
		});
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("skips an occurrence that already has a session", async () => {
		mocks.sessionFindFirst.mockResolvedValue({ id: "session-0" });

		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "skipped",
			reason: "duplicate",
		});
		expect(mocks.sessionFindFirst).toHaveBeenCalledWith({
			where: { linkedMeetingId: "lm-1", occurrenceStart },
			select: { id: true },
		});
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("skips while any session of the series is in the meeting, a manual one included", async () => {
		mocks.liveSession.mockResolvedValue({
			id: "session-0",
			status: "ACTIVE",
		});

		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "skipped",
			reason: "already_in_meeting",
		});
		expect(mocks.liveSession).toHaveBeenCalledWith("lm-1");
		expect(mocks.start).not.toHaveBeenCalled();
		expect(errorWrite()).toBeUndefined();
	});

	it("skips, without recording an error, when another project's Parlume joined since the check", async () => {
		mocks.start.mockRejectedValue(
			new ORPCError("CONFLICT", {
				message:
					"Parlume is already in this meeting. It was invited from another project.",
			}),
		);

		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "skipped",
			reason: "already_in_meeting",
		});
		expect(errorWrite()).toBeUndefined();
	});

	it("skips, without clearing the series' notice, when the start found Parlume already in the meeting", async () => {
		mocks.start.mockResolvedValue({
			session: { id: "session-0" },
			alreadyInMeeting: true,
		});

		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "skipped",
			reason: "already_in_meeting",
		});
		expect(mocks.seriesUpdateMany).not.toHaveBeenCalled();
	});

	// A join can reach the web app late: a worker outage, a slow calendar read
	// or the request's retries. Parlume then joins a meeting nearly over.
	it("sends no bot, and says why on the series, when the join comes more than ten minutes after the start", async () => {
		vi.setSystemTime(new Date(occurrenceStart.getTime() + 10 * MINUTE + 1));

		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "skipped",
			reason: "late",
			message: PARLUME_AUTO_JOIN_LATE,
		});
		expect(mocks.start).not.toHaveBeenCalled();
		expect(errorWrite()).toEqual({
			where: { id: "lm-1" },
			data: {
				parlumeAutoJoinError: PARLUME_AUTO_JOIN_LATE,
				parlumeAutoJoinErrorAt: expect.any(Date),
			},
		});
	});

	it("still joins ten minutes after the start", async () => {
		vi.setSystemTime(new Date(occurrenceStart.getTime() + 10 * MINUTE));

		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "started",
			sessionId: "session-1",
		});
		expect(errorWrite()).toBeUndefined();
	});

	it("skips, and says why on the series, while the project is in Read-only mode", async () => {
		mocks.isProjectReadOnly.mockResolvedValue(true);

		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "skipped",
			reason: "read_only",
			message: PARLUME_AUTO_JOIN_READ_ONLY,
		});
		expect(mocks.isProjectReadOnly).toHaveBeenCalledWith("project-1");
		expect(errorWrite()?.data.parlumeAutoJoinError).toBe(
			PARLUME_AUTO_JOIN_READ_ONLY,
		);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("treats losing the unique-index race as the duplicate it is", async () => {
		mocks.start.mockRejectedValue(
			Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
			}),
		);

		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "skipped",
			reason: "duplicate",
		});
		expect(errorWrite()).toBeUndefined();
	});

	it("refuses with the missing setting when Parlume is not ready", async () => {
		mocks.readiness.mockResolvedValue({
			...ready,
			meetingBot: { ready: false, source: null },
		});

		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "refused",
			reason: "not_ready",
			message: "Add an Attendee API key in Settings → Meeting assistant.",
		});
		expect(mocks.readiness).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(errorWrite()?.data.parlumeAutoJoinError).toContain(
			"Settings → Meeting assistant",
		);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("still joins when the meeting bot's project has no webhook secret", async () => {
		mocks.readiness.mockResolvedValue({
			...ready,
			meetingBot: {
				ready: true,
				source: "organization",
				webhookSigned: false,
			},
		});

		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "started",
			sessionId: "session-1",
		});
		expect(mocks.start).toHaveBeenCalledOnce();
		expect(errorWrite()).toBeUndefined();
	});

	it("records a start the provider refused as final, without retrying", async () => {
		mocks.start.mockRejectedValue(
			new ORPCError("BAD_GATEWAY", {
				message: "Attendee refused the invitation (HTTP 400).",
			}),
		);

		await expect(runParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "failed",
			message: "Attendee refused the invitation (HTTP 400).",
		});
		expect(errorWrite()?.data.parlumeAutoJoinError).toBe(
			"Attendee refused the invitation (HTTP 400).",
		);
	});

	it("records a start-path refusal before any session existed", async () => {
		mocks.start.mockRejectedValue(
			new ORPCError("BAD_REQUEST", {
				message: "Enter a Microsoft Teams meeting link.",
			}),
		);

		await expect(runParlumeAutoJoin(input)).resolves.toMatchObject({
			outcome: "refused",
			reason: "start_refused",
		});
	});

	it("lets an error that is not a decision escape, for the route to answer 503", async () => {
		mocks.sessionFindFirst.mockRejectedValue(
			new Error("database unavailable"),
		);

		await expect(runParlumeAutoJoin(input)).rejects.toThrow(
			"database unavailable",
		);
	});
});
