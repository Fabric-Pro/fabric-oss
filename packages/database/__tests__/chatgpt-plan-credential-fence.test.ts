/**
 * Per-source writes bound to the sign-in the work behind them used
 * (Fizzy #3037): the check runs under the source's refresh lock, in the same
 * transaction as the write, and a source with another sign-in, or none,
 * refuses the write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	locks: [] as number[],
	steps: [] as string[],
	credential: null as { id: string; subject: string } | null,
	account: null as { id: string; subject: string } | null,
	reads: [] as unknown[],
}));

vi.mock("../prisma/client", () => {
	const record =
		(step: string, result: unknown = { count: 1 }) =>
		async (args: unknown) => {
			db.steps.push(step);
			db.reads.push(args);
			return result;
		};
	const tx = {
		$executeRaw: async (
			_sql: TemplateStringsArray,
			_class: number,
			key: number,
		) => {
			db.steps.push("lock");
			db.locks.push(key);
			return 1;
		},
		chatGptPlanCredential: {
			findUnique: async (args: unknown) => {
				db.steps.push("read sign-in");
				db.reads.push(args);
				return db.credential;
			},
		},
		chatGptPlanOrgAccount: {
			findUnique: async (args: unknown) => {
				db.steps.push("read sign-in");
				db.reads.push(args);
				return db.account;
			},
		},
		chatGptPlanSourceState: {
			upsert: record("upsert state"),
			updateMany: record("clear state"),
		},
		chatGptPlanServedModel: {
			deleteMany: record("delete served"),
			createMany: record("create served"),
		},
	};
	return {
		db: {
			$transaction: async (work: (client: typeof tx) => unknown) =>
				work(tx),
		},
	};
});

import { replaceChatGptPlanServedModels } from "../prisma/queries/chatgpt-plan-served-models";
import {
	markChatGptPlanSourceAnswered,
	recordChatGptPlanSourceExhausted,
} from "../prisma/queries/chatgpt-plan-source-state";
import {
	chatGptPlanCredentialFingerprint,
	withChatGptPlanCredentialFence,
} from "../prisma/queries/lib/chatgpt-plan-credential-fence";
import {
	advisoryObjectKey,
	chatGptPlanLockKey,
	chatGptPlanOrgAccountLockKey,
} from "../prisma/queries/lib/refresh-lock-key";

const SIGN_IN_A = { id: "cred_1", subject: "subject-a" };
const A = chatGptPlanCredentialFingerprint(SIGN_IN_A);
const USER = { sourceKind: "USER" as const, sourceId: "user_1" };
const ORG = { sourceKind: "ORG" as const, sourceId: "acc_1" };

beforeEach(() => {
	db.locks = [];
	db.steps = [];
	db.reads = [];
	db.credential = SIGN_IN_A;
	db.account = { id: "acc_1", subject: "subject-a" };
});

describe("chatGptPlanCredentialFingerprint", () => {
	it("is short, opaque and changes with the row or the account", () => {
		expect(A).toMatch(/^[0-9a-f]{16}$/);
		expect(A).not.toContain("subject-a");
		expect(chatGptPlanCredentialFingerprint(SIGN_IN_A)).toBe(A);
		expect(
			chatGptPlanCredentialFingerprint({ ...SIGN_IN_A, id: "cred_2" }),
		).not.toBe(A);
		expect(
			chatGptPlanCredentialFingerprint({
				...SIGN_IN_A,
				subject: "subject-b",
			}),
		).not.toBe(A);
	});
});

describe("withChatGptPlanCredentialFence", () => {
	it("checks the sign-in under the source's own lock, then writes in the same transaction", async () => {
		const write = vi.fn(async () => {
			db.steps.push("write");
		});
		await expect(
			withChatGptPlanCredentialFence(USER, A, write),
		).resolves.toBe(true);
		expect(db.steps).toEqual(["lock", "read sign-in", "write"]);
		expect(db.locks).toEqual([
			advisoryObjectKey(chatGptPlanLockKey("user_1")),
		]);
		expect(db.reads[0]).toMatchObject({ where: { userId: "user_1" } });
	});

	it("takes a shared account's own lock and reads it by id", async () => {
		const fingerprint = chatGptPlanCredentialFingerprint({
			id: "acc_1",
			subject: "subject-a",
		});
		await expect(
			withChatGptPlanCredentialFence(ORG, fingerprint, async () => {}),
		).resolves.toBe(true);
		expect(db.locks).toEqual([
			advisoryObjectKey(chatGptPlanOrgAccountLockKey("acc_1")),
		]);
		expect(db.reads[0]).toMatchObject({ where: { id: "acc_1" } });
	});

	it.each([
		["another account replaced it", { id: "cred_1", subject: "subject-b" }],
		[
			"it was reconnected after a disconnect",
			{ id: "cred_2", subject: "subject-a" },
		],
		["it was disconnected", null],
	])("refuses the write when %s", async (_, current) => {
		db.credential = current;
		const write = vi.fn(async () => {});
		await expect(
			withChatGptPlanCredentialFence(USER, A, write),
		).resolves.toBe(false);
		expect(write).not.toHaveBeenCalled();
	});

	it("accepts any current sign-in for a reporter that names none, but never no sign-in", async () => {
		db.credential = { id: "cred_2", subject: "subject-b" };
		const write = vi.fn(async () => {});
		await expect(
			withChatGptPlanCredentialFence(USER, null, write),
		).resolves.toBe(true);
		db.credential = null;
		await expect(
			withChatGptPlanCredentialFence(USER, null, write),
		).resolves.toBe(false);
		expect(write).toHaveBeenCalledTimes(1);
	});
});

describe("fenced per-source writes", () => {
	const exhaustion = (credentialFingerprint: string | null) => ({
		...USER,
		openUntil: new Date("2026-10-10T12:00:00Z"),
		resetAt: null,
		consecutiveUnknownResets: 1,
		exhaustedAt: new Date("2026-10-10T11:00:00Z"),
		credentialFingerprint,
	});

	it("records a refusal, an answer and a model list only for the sign-in they came from", async () => {
		await expect(
			recordChatGptPlanSourceExhausted(exhaustion(A)),
		).resolves.toBe(true);
		await expect(markChatGptPlanSourceAnswered(USER, A)).resolves.toBe(
			true,
		);
		await expect(
			replaceChatGptPlanServedModels({
				...USER,
				models: [],
				checkedAt: new Date(),
				credentialFingerprint: A,
			}),
		).resolves.toBe(true);
		expect(db.steps.filter((step) => step !== "lock")).toEqual([
			"read sign-in",
			"upsert state",
			"read sign-in",
			"clear state",
			"clear state",
			"read sign-in",
			"delete served",
			"create served",
		]);

		db.steps = [];
		db.credential = { id: "cred_1", subject: "subject-b" };
		await expect(
			recordChatGptPlanSourceExhausted(exhaustion(A)),
		).resolves.toBe(false);
		await expect(markChatGptPlanSourceAnswered(USER, A)).resolves.toBe(
			false,
		);
		await expect(
			replaceChatGptPlanServedModels({
				...USER,
				models: [],
				checkedAt: new Date(),
				credentialFingerprint: A,
			}),
		).resolves.toBe(false);
		expect(db.steps.filter((step) => step !== "lock")).toEqual([
			"read sign-in",
			"read sign-in",
			"read sign-in",
		]);
	});

	it("never stores the fingerprint on the state row", async () => {
		await recordChatGptPlanSourceExhausted(exhaustion(A));
		const upsert = db.reads.find(
			(args) => (args as { create?: unknown }).create !== undefined,
		) as {
			create: Record<string, unknown>;
			update: Record<string, unknown>;
		};
		expect(upsert.create).not.toHaveProperty("credentialFingerprint");
		expect(upsert.update).not.toHaveProperty("credentialFingerprint");
	});
});
