/**
 * `logAiUsage` keeps the Vercel function alive for its post-insert work
 * (Fizzy #3528).
 *
 * The usage-limit recorder used to run as a bare floating promise. On Vercel
 * the function is frozen once the response is sent, so the recorder resumed
 * on a later request with a dead pg connection and production logged
 * "[AiUsageLimits] Failed to record usage / check overage" with
 * "Connection terminated due to connection timeout": the limit counters
 * silently missed that usage. Registering the work with `waitUntil` keeps the
 * function alive until it settles.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/log-ai-usage-keepalive.test.ts
 */

import { waitUntil } from "@vercel/functions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

const usageLogCreate = vi.fn();

vi.mock("../prisma/client", () => ({
	Prisma: { Decimal: class {}, DbNull: Symbol("DbNull") },
	db: {
		aiUsageLog: { create: usageLogCreate },
		aiModelProviderMapping: { findFirst: vi.fn() },
		aiModel: { findUnique: vi.fn() },
		agentWorkspaceFile: { findFirst: vi.fn().mockResolvedValue(null) },
		workflowExecution: { findFirst: vi.fn().mockResolvedValue(null) },
	},
}));

// Pass-through so no TTL cache or cleanup timer survives the run.
vi.mock("../prisma/queries/cache", () => ({
	aiModelCatalogCache: {
		getOrSet: async (_key: string, factory: () => Promise<unknown>) =>
			factory(),
	},
	aiTaskDefaultsCache: {
		getOrSet: async (_key: string, factory: () => Promise<unknown>) =>
			factory(),
	},
}));

const { logAiUsage, logAiUsageAsync, setAiUsageRecorder } = await import(
	"../prisma/queries/ai-models"
);

const USAGE = {
	userId: "user-1",
	organizationId: "org-1",
	provider: "OPENAI_DIRECT" as const,
	providerModelId: "gpt-4o",
	modelCanonicalName: "gpt-4o",
	inputTokens: 1000,
	outputTokens: 500,
	totalTokens: 1500,
	costUsd: 1.5,
	latencyMs: 42,
};

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
	const pending = Symbol("pending");
	const winner = await Promise.race([promise, Promise.resolve(pending)]);
	return winner !== pending;
}

describe("logAiUsage keeps the function alive for the usage-limit recorder", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		usageLogCreate.mockResolvedValue({ id: "usage-1" });
	});

	afterEach(() => {
		setAiUsageRecorder(null);
		vi.restoreAllMocks();
	});

	it("registers the recorder's pending work with waitUntil", async () => {
		const recording = deferred();
		const recorder = vi.fn(() => recording.promise);
		setAiUsageRecorder(recorder);

		await logAiUsage(USAGE);

		expect(recorder).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				totalTokens: 1500,
			}),
		);
		expect(waitUntil).toHaveBeenCalledTimes(1);
		const kept = vi.mocked(waitUntil).mock
			.calls[0]?.[0] as Promise<unknown>;
		// logAiUsage returned while the recorder was still running; the
		// promise handed to waitUntil is what keeps the function alive.
		expect(await isSettled(kept)).toBe(false);
		recording.resolve();
		await expect(kept).resolves.toBeUndefined();
	});

	it("hands waitUntil a promise that settles even when the recorder rejects", async () => {
		const recording = deferred();
		setAiUsageRecorder(() => recording.promise);

		await logAiUsage(USAGE);

		const kept = vi.mocked(waitUntil).mock
			.calls[0]?.[0] as Promise<unknown>;
		recording.reject(new Error("Connection terminated"));
		await expect(kept).resolves.toBeUndefined();
	});

	it("still records usage when waitUntil itself throws", async () => {
		vi.mocked(waitUntil).mockImplementationOnce(() => {
			throw new Error("no request context");
		});
		const recorder = vi.fn().mockResolvedValue(undefined);
		setAiUsageRecorder(recorder);

		await expect(logAiUsage(USAGE)).resolves.toEqual({ id: "usage-1" });
		expect(recorder).toHaveBeenCalledTimes(1);
	});

	it("skips the recorder and waitUntil for a zero-token, zero-cost row", async () => {
		const recorder = vi.fn().mockResolvedValue(undefined);
		setAiUsageRecorder(recorder);

		await logAiUsage({ ...USAGE, totalTokens: 0, costUsd: 0 });

		expect(recorder).not.toHaveBeenCalled();
		expect(waitUntil).not.toHaveBeenCalled();
	});
});

describe("logAiUsageAsync keeps the function alive for the whole log", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		usageLogCreate.mockResolvedValue({ id: "usage-1" });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers the usage insert with waitUntil before it completes", async () => {
		const insert = deferred();
		usageLogCreate.mockReturnValueOnce(
			insert.promise.then(() => ({ id: "usage-1" })),
		);

		logAiUsageAsync(USAGE);

		expect(waitUntil).toHaveBeenCalledTimes(1);
		const kept = vi.mocked(waitUntil).mock
			.calls[0]?.[0] as Promise<unknown>;
		expect(await isSettled(kept)).toBe(false);
		insert.resolve();
		await expect(kept).resolves.toBeUndefined();
		expect(usageLogCreate).toHaveBeenCalledTimes(1);
	});

	it("hands waitUntil a promise that settles and logs when the insert fails", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		usageLogCreate.mockRejectedValueOnce(new Error("pg down"));

		logAiUsageAsync(USAGE);

		const kept = vi.mocked(waitUntil).mock
			.calls[0]?.[0] as Promise<unknown>;
		await expect(kept).resolves.toBeUndefined();
		expect(consoleError).toHaveBeenCalledWith(
			"[AI Usage Logging] Failed to log usage:",
			expect.any(Error),
		);
	});
});
