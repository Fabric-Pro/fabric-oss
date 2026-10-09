/**
 * A member's first own ChatGPT plan starts clean (Fizzy #2770 I1): breaker,
 * served-model and calibration rows left under their key by a plan they
 * shared or disconnected must not mark the new one spent. A reconnect of the
 * plan they have keeps its state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	stateDeleteMany: vi.fn(),
	servedDeleteMany: vi.fn(),
	observationDeleteMany: vi.fn(),
}));

vi.mock("../prisma/client", () => {
	const db = {
		chatGptPlanCredential: {
			findUnique: mocks.findUnique,
			create: mocks.create,
			update: mocks.update,
		},
		chatGptPlanSourceState: { deleteMany: mocks.stateDeleteMany },
		chatGptPlanServedModel: { deleteMany: mocks.servedDeleteMany },
		chatGptPlanBudgetObservation: {
			deleteMany: mocks.observationDeleteMany,
		},
		$transaction: (fn: (tx: unknown) => unknown) => fn(db),
	};
	return { db };
});

import { upsertChatGptPlanCredential } from "../prisma/queries/chatgpt-plan-credentials";

const WRITE = {
	userId: "user-1",
	email: "plan@example.com",
	subject: "sub-1",
	clientId: "oaiapp_1",
	hostId: "urn:uuid:host",
	encryptedAccessToken: "enc-access",
	encryptedRefreshToken: "enc-refresh",
	encryptedIdToken: "enc-id",
	accessTokenExpiresAt: new Date("2026-10-09T12:00:00Z"),
	earliestRefreshAt: null,
	scopes: ["openid"],
};

const SOURCE = { where: { sourceKind: "USER", sourceId: "user-1" } };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("upsertChatGptPlanCredential", () => {
	it("clears the member's leftover per-source rows before a first own plan", async () => {
		mocks.findUnique.mockResolvedValue(null);
		await upsertChatGptPlanCredential(WRITE);
		expect(mocks.stateDeleteMany).toHaveBeenCalledWith(SOURCE);
		expect(mocks.servedDeleteMany).toHaveBeenCalledWith(SOURCE);
		expect(mocks.observationDeleteMany).toHaveBeenCalledWith(SOURCE);
		expect(mocks.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				userId: "user-1",
				status: "ACTIVE",
			}),
		});
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("keeps the state of the plan a reconnect replaces the tokens of", async () => {
		mocks.findUnique.mockResolvedValue({ id: "cred-1" });
		await upsertChatGptPlanCredential(WRITE);
		expect(mocks.update).toHaveBeenCalledWith({
			where: { userId: "user-1" },
			data: expect.objectContaining({
				status: "ACTIVE",
				encryptedAccessToken: "enc-access",
			}),
		});
		expect(mocks.stateDeleteMany).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
	});
});
