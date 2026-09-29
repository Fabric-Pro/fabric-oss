import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindUnique: vi.fn(),
	sessionUpdateMany: vi.fn(),
	sessionUpdate: vi.fn(),
	segmentFindMany: vi.fn(),
	deleteProviderData: vi.fn(),
	getSettings: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findUnique: mocks.sessionFindUnique,
			updateMany: mocks.sessionUpdateMany,
			update: mocks.sessionUpdate,
		},
		parlumeMeetingSegment: {
			findMany: mocks.segmentFindMany,
		},
	},
}));

vi.mock("@repo/api/modules/projects/lib/parlume-meeting-baas", () => ({
	deleteParlumeMeetingBotData: mocks.deleteProviderData,
	getParlumeBridgeSettings: mocks.getSettings,
}));

import { finalizeParlumeSession } from "../lib";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.sessionFindUnique.mockResolvedValue({
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		providerBotId: "bot-1",
		status: "ACTIVE",
		transcriptContextId: null,
		providerDataDeletedAt: null,
	});
	mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
	mocks.segmentFindMany.mockResolvedValue([]);
	mocks.getSettings.mockReturnValue({ apiKey: "test-key" });
	mocks.deleteProviderData.mockResolvedValue(undefined);
});

describe("Parlume empty transcript finalization", () => {
	it("ends an empty meeting and deletes provider artifacts", async () => {
		await finalizeParlumeSession("session-1");

		expect(mocks.sessionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "ENDED",
					lastError: "No final speech segments were received.",
				}),
			}),
		);
		expect(mocks.deleteProviderData).toHaveBeenCalledWith({
			settings: { apiKey: "test-key" },
			providerBotId: "bot-1",
		});
		expect(mocks.sessionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { providerDataDeletedAt: expect.any(Date) },
			}),
		);
	});
});
