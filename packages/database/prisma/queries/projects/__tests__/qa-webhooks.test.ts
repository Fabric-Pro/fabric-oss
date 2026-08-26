import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => ({
	dbMock: {
		projectQaWebhook: {
			findUnique: vi.fn(),
			findUniqueOrThrow: vi.fn(),
			updateMany: vi.fn(),
		},
		$transaction: vi.fn(),
	},
}));

vi.mock("../../../client", () => ({ db: dbMock, Prisma: {} }));

import { rotateProjectQaWebhookSecret } from "../qa-webhooks";

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.$transaction.mockImplementation(
		async (callback: (tx: typeof dbMock) => Promise<unknown>) =>
			callback(dbMock),
	);
});

describe("QA webhook secret rotation", () => {
	it("preserves the current secret while an overlap is active", async () => {
		dbMock.projectQaWebhook.findUnique.mockResolvedValue({
			encryptedSecret: "encrypted:current",
			previousSecretRetiresAt: new Date(Date.now() + 60_000),
		});

		const result = await rotateProjectQaWebhookSecret({
			projectId: "project-1",
			encryptedSecret: "encrypted:new",
			secretHint: "new1",
			previousSecretRetiresAt: new Date(Date.now() + 120_000),
		});

		expect(result).toEqual({ status: "overlap_active_or_conflict" });
		expect(dbMock.projectQaWebhook.updateMany).not.toHaveBeenCalled();
	});

	it("treats a lost compare-and-swap race as a conflict", async () => {
		dbMock.projectQaWebhook.findUnique.mockResolvedValue({
			encryptedSecret: "encrypted:current",
			previousSecretRetiresAt: null,
		});
		dbMock.projectQaWebhook.updateMany.mockResolvedValue({ count: 0 });

		const result = await rotateProjectQaWebhookSecret({
			projectId: "project-1",
			encryptedSecret: "encrypted:new",
			secretHint: "new1",
			previousSecretRetiresAt: new Date(Date.now() + 120_000),
		});

		expect(result).toEqual({ status: "overlap_active_or_conflict" });
		expect(
			dbMock.projectQaWebhook.findUniqueOrThrow,
		).not.toHaveBeenCalled();
	});

	it("moves the exact current secret into the overlap slot atomically", async () => {
		const retiresAt = new Date(Date.now() + 120_000);
		dbMock.projectQaWebhook.findUnique.mockResolvedValue({
			encryptedSecret: "encrypted:current",
			previousSecretRetiresAt: null,
		});
		dbMock.projectQaWebhook.updateMany.mockResolvedValue({ count: 1 });
		dbMock.projectQaWebhook.findUniqueOrThrow.mockResolvedValue({
			id: "webhook-1",
		});

		const result = await rotateProjectQaWebhookSecret({
			projectId: "project-1",
			encryptedSecret: "encrypted:new",
			secretHint: "new1",
			previousSecretRetiresAt: retiresAt,
		});

		expect(result).toEqual({
			status: "rotated",
			row: { id: "webhook-1" },
		});
		expect(dbMock.projectQaWebhook.updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				projectId: "project-1",
				encryptedSecret: "encrypted:current",
			}),
			data: expect.objectContaining({
				previousEncryptedSecret: "encrypted:current",
				encryptedSecret: "encrypted:new",
				previousSecretRetiresAt: retiresAt,
			}),
		});
	});
});
