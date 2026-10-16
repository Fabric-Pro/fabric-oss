import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindUnique: vi.fn(),
	sessionUpdateMany: vi.fn(),
	sessionUpdate: vi.fn(),
	segmentFindMany: vi.fn(),
	contextCreate: vi.fn(),
	workflowStart: vi.fn(),
	recordUsage: vi.fn(),
	deleteProviderData: vi.fn(),
	getSettings: vi.fn(),
}));

vi.mock("@repo/database", () => {
	const parlumeMeetingSession = {
		findUnique: mocks.sessionFindUnique,
		updateMany: mocks.sessionUpdateMany,
		update: mocks.sessionUpdate,
	};
	return {
		db: {
			parlumeMeetingSession,
			parlumeMeetingSegment: { findMany: mocks.segmentFindMany },
			$transaction: (
				run: (tx: {
					projectContext: { create: typeof mocks.contextCreate };
					parlumeMeetingSession: typeof parlumeMeetingSession;
				}) => Promise<string>,
			) =>
				run({
					projectContext: { create: mocks.contextCreate },
					parlumeMeetingSession,
				}),
		},
		logAiUsageAsync: () => undefined,
	};
});

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

vi.mock("../parlume-attendee", () => ({
	deleteParlumeMeetingBotData: mocks.deleteProviderData,
	getParlumeBridgeSettings: mocks.getSettings,
}));

vi.mock("../parlume-log", () => ({ parlumeLog: () => undefined }));

vi.mock("../parlume-usage", async (importOriginal) => ({
	...(await importOriginal<typeof import("../parlume-usage")>()),
	recordParlumeMeetingProviderUsage: mocks.recordUsage,
}));

import { finalizeParlumeSession } from "../parlume-finalization";

function storedSession(overrides: Record<string, unknown> = {}) {
	return {
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		providerBotId: "bot-1",
		status: "JOINING",
		endReason: "START_FAILED",
		joinedAt: null,
		terminalCallbackAt: null,
		leaveRequestedAt: null,
		captureStoppedAt: null,
		finalizedAt: null,
		transcriptContextId: null,
		providerDataDeletedAt: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.sessionFindUnique.mockResolvedValue(storedSession());
	mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
	mocks.sessionUpdate.mockResolvedValue(undefined);
	mocks.segmentFindMany.mockResolvedValue([]);
	mocks.getSettings.mockReturnValue({ apiKey: "test-key" });
	mocks.deleteProviderData.mockResolvedValue(undefined);
});

describe("finalizeParlumeSession provider usage", () => {
	it("records the bot's time once, even when a failed session is finalized again", async () => {
		await finalizeParlumeSession("session-1", { preserveFailure: true });

		expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
		expect(mocks.recordUsage).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session-1", success: false }),
		);
		expect(mocks.sessionUpdateMany).toHaveBeenCalledTimes(1);

		// The watchdog reads the session after the first finalization finished.
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({
				status: "FAILED",
				finalizedAt: new Date("2026-10-01T18:00:05Z"),
				providerDataDeletedAt: new Date("2026-10-01T18:00:06Z"),
			}),
		);
		await expect(
			finalizeParlumeSession("session-1", { preserveFailure: true }),
		).resolves.toBeUndefined();

		expect(mocks.recordUsage).toHaveBeenCalledTimes(1);
		expect(mocks.sessionUpdateMany).toHaveBeenCalledTimes(1);
		expect(mocks.deleteProviderData).toHaveBeenCalledTimes(1);
	});

	it("still retries a provider data deletion that a finished finalization left owing", async () => {
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({
				status: "FAILED",
				finalizedAt: new Date("2026-10-01T18:00:05Z"),
			}),
		);

		await finalizeParlumeSession("session-1", { preserveFailure: true });

		expect(mocks.recordUsage).not.toHaveBeenCalled();
		expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
		expect(mocks.deleteProviderData).toHaveBeenCalledWith({
			settings: { apiKey: "test-key" },
			providerBotId: "bot-1",
		});
	});

	it("records nothing for a session that already ended", async () => {
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({
				status: "ENDED",
				finalizedAt: new Date("2026-10-01T18:00:05Z"),
				providerDataDeletedAt: new Date("2026-10-01T18:00:06Z"),
			}),
		);

		await finalizeParlumeSession("session-1");

		expect(mocks.recordUsage).not.toHaveBeenCalled();
		expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
	});

	it("refuses to claim a failed session that finalized after it was read", async () => {
		mocks.sessionFindUnique.mockResolvedValue(
			storedSession({ status: "FAILED" }),
		);
		// By the time the claim runs, a concurrent finalization has finished.
		mocks.sessionUpdateMany.mockResolvedValue({ count: 0 });

		await expect(
			finalizeParlumeSession("session-1", { preserveFailure: true }),
		).rejects.toThrow("already in progress");

		expect(mocks.sessionUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						{ status: "FAILED", finalizedAt: null },
					]),
				}),
			}),
		);
		expect(mocks.recordUsage).not.toHaveBeenCalled();
	});

	it("claims a failed session only when asked to preserve the failure", async () => {
		await finalizeParlumeSession("session-1");

		const [{ where }] = mocks.sessionUpdateMany.mock.calls[0];
		expect(JSON.stringify(where.OR)).not.toContain('"FAILED"');
	});
});
