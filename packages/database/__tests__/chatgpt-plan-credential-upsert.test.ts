/**
 * A member's first own ChatGPT plan starts clean (Fizzy #2770 I1): breaker,
 * served-model and calibration rows left under their key by a plan they
 * shared or disconnected must not mark the new one spent. Switching accounts
 * also clears that state and omitted subscription metadata. A reconnect of
 * the same account keeps its state, even with a new client subject.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	stateDeleteMany: vi.fn(),
	servedDeleteMany: vi.fn(),
	observationDeleteMany: vi.fn(),
	accuracyDeleteMany: vi.fn(),
	executeRaw: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock("../prisma/client", () => {
	const tx = {
		$executeRaw: mocks.executeRaw,
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
		chatGptPlanWindowAccuracy: { deleteMany: mocks.accuracyDeleteMany },
	};
	const db = { $transaction: mocks.transaction };
	mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
		fn(tx),
	);
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
	mocks.create.mockResolvedValue({ id: "cred-new" });
	mocks.update.mockResolvedValue({ id: "cred-1" });
	mocks.stateDeleteMany.mockResolvedValue({ count: 1 });
	mocks.servedDeleteMany.mockResolvedValue({ count: 1 });
	mocks.observationDeleteMany.mockResolvedValue({ count: 1 });
});

describe("upsertChatGptPlanCredential", () => {
	it("clears the member's leftover per-source rows before a first own plan", async () => {
		mocks.findUnique.mockResolvedValue(null);
		// The id names the sign-in its later writes are bound to (Fizzy #3037).
		await expect(upsertChatGptPlanCredential(WRITE)).resolves.toEqual({
			id: "cred-new",
		});
		expect(mocks.stateDeleteMany).toHaveBeenCalledWith(SOURCE);
		expect(mocks.servedDeleteMany).toHaveBeenCalledWith(SOURCE);
		expect(mocks.observationDeleteMany).toHaveBeenCalledWith(SOURCE);
		expect(mocks.accuracyDeleteMany).toHaveBeenCalledWith(SOURCE);
		expect(mocks.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				userId: "user-1",
				status: "ACTIVE",
			}),
			select: { id: true },
		});
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("keeps the state of the plan a reconnect replaces the tokens of", async () => {
		mocks.findUnique.mockResolvedValue({
			id: "cred-1",
			subject: WRITE.subject,
			email: WRITE.email,
		});
		await upsertChatGptPlanCredential(WRITE);
		expect(mocks.update).toHaveBeenCalledWith({
			where: { userId: "user-1" },
			data: expect.objectContaining({
				status: "ACTIVE",
				encryptedAccessToken: "enc-access",
			}),
			select: { id: true },
		});
		expect(mocks.stateDeleteMany).not.toHaveBeenCalled();
		expect(mocks.servedDeleteMany).not.toHaveBeenCalled();
		expect(mocks.observationDeleteMany).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("clears all account state when a different account replaces the credential", async () => {
		mocks.findUnique.mockResolvedValue({
			id: "cred-1",
			subject: "old-subject",
			email: "old-plan@example.com",
		});
		await upsertChatGptPlanCredential(WRITE);
		expect(mocks.stateDeleteMany).toHaveBeenCalledWith(SOURCE);
		expect(mocks.servedDeleteMany).toHaveBeenCalledWith(SOURCE);
		expect(mocks.observationDeleteMany).toHaveBeenCalledWith(SOURCE);
		expect(mocks.transaction).toHaveBeenCalledTimes(1);
		expect(mocks.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.findUnique.mock.invocationCallOrder[0],
		);
		expect(
			mocks.observationDeleteMany.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.update.mock.invocationCallOrder[0]);
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("resets omitted subscription fields and last use on account replacement", async () => {
		mocks.findUnique.mockResolvedValue({
			id: "cred-1",
			subject: "old-subject",
			email: "old-plan@example.com",
		});
		await upsertChatGptPlanCredential(WRITE);
		const { userId, ...fields } = WRITE;
		expect(mocks.update).toHaveBeenCalledWith({
			where: { userId },
			data: {
				...fields,
				status: "ACTIVE",
				tier: "UNKNOWN",
				subscriptionActiveUntil: null,
				lastUsedAt: null,
			},
			select: { id: true },
		});
	});

	it.each([
		{ subject: "other-client-subject", email: " PLAN@EXAMPLE.COM " },
		{ subject: WRITE.subject, email: null },
		{ subject: WRITE.subject, email: "other@example.com" },
	])(
		"preserves state and omitted metadata for a matching identity: %j",
		async (identity) => {
			mocks.findUnique.mockResolvedValue({ id: "cred-1", ...identity });
			await upsertChatGptPlanCredential(WRITE);
			const { userId, ...fields } = WRITE;
			expect(mocks.update).toHaveBeenCalledWith({
				where: { userId },
				data: { ...fields, status: "ACTIVE" },
				select: { id: true },
			});
			expect(mocks.stateDeleteMany).not.toHaveBeenCalled();
			expect(mocks.servedDeleteMany).not.toHaveBeenCalled();
			expect(mocks.observationDeleteMany).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ storedEmail: null, incomingEmail: null },
		{ storedEmail: "", incomingEmail: " " },
		{ storedEmail: WRITE.email, incomingEmail: null },
		{ storedEmail: null, incomingEmail: WRITE.email },
	])(
		"resets state for different subjects without a matching email: %j",
		async ({ storedEmail, incomingEmail }) => {
			mocks.findUnique.mockResolvedValue({
				id: "cred-1",
				subject: "old-subject",
				email: storedEmail,
			});
			await upsertChatGptPlanCredential({
				...WRITE,
				email: incomingEmail,
			});
			expect(mocks.stateDeleteMany).toHaveBeenCalledWith(SOURCE);
			expect(mocks.servedDeleteMany).toHaveBeenCalledWith(SOURCE);
			expect(mocks.observationDeleteMany).toHaveBeenCalledWith(SOURCE);
		},
	);

	it("uses supplied subscription claims while clearing the previous account's last use", async () => {
		mocks.findUnique.mockResolvedValue({
			id: "cred-1",
			subject: "old-subject",
			email: null,
		});
		const subscriptionActiveUntil = new Date("2026-12-01T00:00:00Z");
		await upsertChatGptPlanCredential({
			...WRITE,
			tier: "PLUS",
			subscriptionActiveUntil,
		});
		expect(mocks.update).toHaveBeenCalledWith({
			where: { userId: WRITE.userId },
			data: expect.objectContaining({
				tier: "PLUS",
				subscriptionActiveUntil,
				lastUsedAt: null,
			}),
			select: { id: true },
		});
	});

	it("recognizes the same subject when both sign-ins omit email", async () => {
		mocks.findUnique.mockResolvedValue({
			subject: WRITE.subject,
			email: null,
		});
		await upsertChatGptPlanCredential({ ...WRITE, email: null });
		expect(mocks.stateDeleteMany).not.toHaveBeenCalled();
		expect(mocks.servedDeleteMany).not.toHaveBeenCalled();
		expect(mocks.observationDeleteMany).not.toHaveBeenCalled();
	});

	it.each([
		"stateDeleteMany",
		"servedDeleteMany",
		"observationDeleteMany",
	] as const)("aborts replacement if %s cleanup fails", async (cleanup) => {
		mocks.findUnique.mockResolvedValue({
			id: "cred-1",
			subject: "old-subject",
			email: null,
		});
		const error = new Error("synthetic cleanup failure");
		mocks[cleanup].mockRejectedValueOnce(error);
		await expect(upsertChatGptPlanCredential(WRITE)).rejects.toBe(error);
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
	});
});
