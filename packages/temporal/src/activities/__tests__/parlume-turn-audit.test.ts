import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordParlumeTurnAnswered } from "../parlume-turn-audit";

const mocks = vi.hoisted(() => ({
	turn: vi.fn(),
	user: vi.fn(),
	audit: vi.fn(),
	warn: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingTurn: { findUnique: mocks.turn },
		user: { findUnique: mocks.user },
	},
	recordAudit: mocks.audit,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

beforeEach(() => {
	vi.resetAllMocks();
	mocks.turn.mockResolvedValue({
		sessionId: "session",
		projectId: "project",
		organizationId: "org",
		replyChannel: "CHAT",
		userId: "inviter",
		requesterUserId: "asker",
	});
	mocks.user.mockResolvedValue({ email: "sam@example.com" });
});

describe("recordParlumeTurnAnswered", () => {
	it("audits a stopped turn as a failure, as Fabric Parlume for the participant who asked", async () => {
		await recordParlumeTurnAnswered({ turnId: "turn", status: "STOPPED" });

		expect(mocks.turn).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "turn" } }),
		);
		expect(mocks.user).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "asker" } }),
		);
		expect(mocks.audit).toHaveBeenCalledTimes(1);
		expect(mocks.audit).toHaveBeenCalledWith({
			action: "project.parlume.request_answered",
			category: "project",
			outcome: "failure",
			actor: {
				type: "agent",
				userId: "asker",
				nameSnapshot: "Fabric Parlume",
				emailSnapshot: "sam@example.com",
			},
			organizationId: "org",
			projectId: "project",
			resource: { type: "parlume_meeting_turn", id: "turn" },
			metadata: {
				status: "STOPPED",
				sessionId: "session",
				source: "typed",
				invitedBy: "inviter",
			},
		});
	});

	it("records a question asked on the Parlume page as asked there", async () => {
		mocks.turn.mockResolvedValue({
			sessionId: "session",
			projectId: "project",
			organizationId: "org",
			replyChannel: "PAGE",
			userId: "inviter",
			requesterUserId: "asker",
		});

		await recordParlumeTurnAnswered({
			turnId: "turn",
			status: "COMPLETED",
		});

		expect(mocks.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "success",
				metadata: expect.objectContaining({ source: "page" }),
			}),
		);
	});

	it("names no member when Parlume could not tell who asked, and keeps the inviter", async () => {
		mocks.turn.mockResolvedValue({
			sessionId: "session",
			projectId: "project",
			organizationId: "org",
			replyChannel: "VOICE",
			userId: "inviter",
			requesterUserId: null,
		});

		await recordParlumeTurnAnswered({
			turnId: "turn",
			status: "COMPLETED",
		});

		expect(mocks.user).not.toHaveBeenCalled();
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				actor: {
					type: "agent",
					userId: null,
					nameSnapshot: "Fabric Parlume",
					emailSnapshot: null,
				},
				metadata: {
					status: "COMPLETED",
					sessionId: "session",
					source: "spoken",
					invitedBy: "inviter",
				},
			}),
		);
	});

	it("audits a completed spoken turn as a success, with the tools it called", async () => {
		mocks.turn.mockResolvedValue({
			sessionId: "session",
			projectId: "project",
			organizationId: "org",
			replyChannel: "VOICE",
			userId: "inviter",
			requesterUserId: "inviter",
		});
		mocks.user.mockResolvedValue({ email: "dana@example.com" });

		await recordParlumeTurnAnswered({
			turnId: "turn",
			status: "COMPLETED",
			toolNames: ["fabric_list_stories"],
		});

		expect(mocks.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				outcome: "success",
				actor: expect.objectContaining({
					userId: "inviter",
					emailSnapshot: "dana@example.com",
				}),
				metadata: {
					status: "COMPLETED",
					sessionId: "session",
					source: "spoken",
					invitedBy: "inviter",
					toolNames: ["fabric_list_stories"],
				},
			}),
		);
	});

	it("writes nothing for a turn that no longer exists", async () => {
		mocks.turn.mockResolvedValue(null);

		await recordParlumeTurnAnswered({ turnId: "turn", status: "FAILED" });

		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("never throws when the turn cannot be read", async () => {
		mocks.turn.mockRejectedValue(new Error("connection lost"));

		await expect(
			recordParlumeTurnAnswered({ turnId: "turn", status: "COMPLETED" }),
		).resolves.toBeUndefined();

		expect(mocks.audit).not.toHaveBeenCalled();
		expect(mocks.warn).toHaveBeenCalledWith(
			"[Parlume] turn.audit_failed",
			expect.objectContaining({ turnId: "turn", status: "COMPLETED" }),
		);
	});
});
