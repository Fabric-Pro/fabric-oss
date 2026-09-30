import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeParlumeMeetingTurn } from "../parlume";

const mocks = vi.hoisted(() => ({
	turn: vi.fn(),
	update: vi.fn(),
	updateMany: vi.fn(),
	session: vi.fn(),
	hasAccess: vi.fn(),
	load: vi.fn(),
	execute: vi.fn(),
	retrieve: vi.fn(),
	speak: vi.fn(),
	stop: vi.fn(),
	decision: vi.fn(),
	proposal: vi.fn(),
	actions: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingTurn: {
			findUnique: mocks.turn,
			findMany: vi.fn(async () => []),
			update: mocks.update,
			updateMany: mocks.updateMany,
		},
		parlumeMeetingSession: { updateMany: mocks.session },
		parlumeMeetingSegment: {
			findMany: vi.fn(async () => [
				{ text: "Meeting context", speakerName: "Alex" },
			]),
		},
		parlumeAction: { findFirst: mocks.proposal, updateMany: mocks.actions },
		$transaction: (operations: Promise<unknown>[]) =>
			Promise.all(operations),
	},
	hasProjectAccess: mocks.hasAccess,
}));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({ cancellationSignal: new AbortController().signal }),
	},
}));
vi.mock("../parlume-agent", () => ({
	loadParlumeAgent: mocks.load,
	executeParlumeAgent: mocks.execute,
}));
vi.mock("../parlume-actions", () => ({
	prepareParlumeDecision: mocks.decision,
	createParlumeToolRuntime: () => ({ invoke: vi.fn() }),
}));
vi.mock("../parlume-voice", () => ({
	speakParlumeResponse: mocks.speak,
	requestParlumeMeetingStop: mocks.stop,
}));
vi.mock("../project-metadata", () => ({
	retrieveProjectContextsActivity: mocks.retrieve,
}));

function turn(agentKind = "FABRIC_AGENT") {
	return {
		id: "turn",
		status: "PENDING",
		voiceGeneration: 3,
		speakerId: "speaker",
		speakerName: "Alex",
		requestText: "What is the plan?",
		session: {
			id: "session",
			projectId: "project",
			organizationId: "org",
			userId: "user",
			agentKind,
			status: "ACTIVE",
			toolsReadOnly: true,
			voiceGeneration: 3,
		},
	};
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.turn.mockResolvedValue(turn());
	mocks.hasAccess.mockResolvedValue(true);
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.load.mockResolvedValue({
		kind: "FABRIC_AGENT",
		revision: "current-revision",
	});
	mocks.execute.mockResolvedValue({ success: true, response: "The plan." });
	mocks.retrieve.mockResolvedValue({ context: "Project knowledge" });
	mocks.decision.mockResolvedValue({});
	mocks.speak.mockResolvedValue({
		played: true,
		interrupted: false,
		firstAudioAt: new Date().toISOString(),
	});
});

describe("Parlume meeting turns", () => {
	it("uses the selected current agent, project knowledge and transcript", async () => {
		await executeParlumeMeetingTurn({ turnId: "turn" });
		expect(mocks.load).toHaveBeenCalledWith(turn().session);
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				agent: { kind: "FABRIC_AGENT", revision: "current-revision" },
				knowledgeContext:
					"Project knowledge\n\nRecent meeting transcript:\nAlex: Meeting context",
				confirmation: false,
			}),
		);
		expect(mocks.speak).toHaveBeenCalledWith(
			expect.objectContaining({
				response: "The plan.",
				voiceGeneration: 3,
			}),
		);
		expect(mocks.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "COMPLETED",
					spokenAt: expect.any(Date),
				}),
			}),
		);
	});
	it.each(["FABRIC_AGENT", "TEMPLATE_INSTANCE"])(
		"stops %s before any context or execution when access is revoked",
		async (kind) => {
			mocks.turn.mockResolvedValue(turn(kind));
			mocks.hasAccess.mockResolvedValue(false);
			await executeParlumeMeetingTurn({ turnId: "turn" });
			expect(mocks.stop).toHaveBeenCalledWith({ sessionId: "session" });
			expect(mocks.session).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ status: "LEAVING" }),
				}),
			);
			expect(mocks.load).not.toHaveBeenCalled();
			expect(mocks.retrieve).not.toHaveBeenCalled();
			expect(mocks.execute).not.toHaveBeenCalled();
			expect(mocks.speak).not.toHaveBeenCalled();
		},
	);
	it("does not execute a duplicate or interrupted turn", async () => {
		mocks.updateMany.mockResolvedValue({ count: 0 });
		await executeParlumeMeetingTurn({ turnId: "turn" });
		expect(mocks.load).not.toHaveBeenCalled();
	});
	it("bypasses retrieval for confirmations", async () => {
		mocks.decision.mockResolvedValue({ runtime: { invoke: vi.fn() } });
		await executeParlumeMeetingTurn({ turnId: "turn" });
		expect(mocks.retrieve).not.toHaveBeenCalled();
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				confirmation: true,
				history: [],
				knowledgeContext: "",
			}),
		);
	});
	it("only enables confirmation after the complete proposal is played", async () => {
		mocks.proposal.mockResolvedValue({
			summary: "Please confirm the exact action.",
			speakerId: "speaker",
		});
		mocks.speak.mockResolvedValue({ played: false, interrupted: true });
		await executeParlumeMeetingTurn({ turnId: "turn" });
		expect(mocks.speak).toHaveBeenCalledWith(
			expect.objectContaining({
				response: "Please confirm the exact action.",
				confirmationSpeakerId: "speaker",
			}),
		);
		expect(mocks.actions).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "CANCELLED" }),
			}),
		);
	});
});
