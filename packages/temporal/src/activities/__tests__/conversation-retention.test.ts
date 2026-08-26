/**
 * Unit tests for `purgeExpiredConversationsActivity`.
 *
 * This activity destroys customer conversation and agent history, so the tests
 * are weighted toward the properties whose failure is unrecoverable:
 *  1. Both opt-in gates hold — nothing is deleted without an explicit enable
 *     AND an explicit retention period. Either alone is a no-op.
 *  2. Pinned rows are never purged, regardless of age.
 *  3. The window is inactivity-based (`updatedAt`), not creation-based.
 *  4. Both named stores are covered (`ai_chat`, `agent_conversation`).
 *  5. Batching terminates and the safety cap is reported.
 *  6. Nothing logs message content.
 *
 * `db.$executeRawUnsafe` and the logger are mocked, matching the sibling
 * audit-log-retention tests — no live DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	executeRawUnsafeMock: vi.fn(),
	loggerInfoMock: vi.fn(),
	loggerWarnMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		$executeRawUnsafe: (...args: unknown[]) =>
			mocks.executeRawUnsafeMock(...args),
	},
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: (...args: unknown[]) => mocks.loggerInfoMock(...args),
		warn: (...args: unknown[]) => mocks.loggerWarnMock(...args),
		error: vi.fn(),
	},
}));

import { purgeExpiredConversationsActivity } from "../conversation-retention";

const ENABLED = "FABRIC_CONVERSATION_RETENTION_ENABLED";
const DAYS = "FABRIC_CONVERSATION_RETENTION_DAYS";

/** Delete `n` rows from the first table, then nothing (terminates the loop). */
function deleteThenDrain(n: number) {
	let calls = 0;
	mocks.executeRawUnsafeMock.mockImplementation(async () => {
		calls += 1;
		return calls === 1 ? n : 0;
	});
}

describe("purgeExpiredConversationsActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env[ENABLED] = "true";
		process.env[DAYS] = "90";
		mocks.executeRawUnsafeMock.mockResolvedValue(0);
	});

	afterEach(() => {
		delete process.env[ENABLED];
		delete process.env[DAYS];
	});

	// --- The gates. A regression here silently deletes customer data. ---

	it("does nothing when not enabled, even with a retention period set", async () => {
		delete process.env[ENABLED];

		const r = await purgeExpiredConversationsActivity();

		expect(r.enabled).toBe(false);
		expect(r.deletedCount).toBe(0);
		expect(mocks.executeRawUnsafeMock).not.toHaveBeenCalled();
	});

	it("does nothing when enabled but no retention period is set", async () => {
		delete process.env[DAYS];

		const r = await purgeExpiredConversationsActivity();

		expect(r.retentionDays).toBe(0);
		expect(r.deletedCount).toBe(0);
		expect(mocks.executeRawUnsafeMock).not.toHaveBeenCalled();
	});

	it.each(["0", "-1", "not-a-number", ""])(
		"treats %j as retain-forever rather than guessing a period",
		async (value) => {
			process.env[DAYS] = value;

			const r = await purgeExpiredConversationsActivity();

			expect(r.retentionDays).toBe(0);
			expect(mocks.executeRawUnsafeMock).not.toHaveBeenCalled();
		},
	);

	it('only enables when the flag is exactly "true"', async () => {
		process.env[ENABLED] = "1";

		expect((await purgeExpiredConversationsActivity()).enabled).toBe(false);
	});

	// --- Pinned is an explicit keep signal and must beat age. ---

	it("never purges pinned rows", async () => {
		await purgeExpiredConversationsActivity();

		expect(mocks.executeRawUnsafeMock).toHaveBeenCalled();
		for (const [sql] of mocks.executeRawUnsafeMock.mock.calls) {
			expect(sql).toContain(`"pinned" = false`);
		}
	});

	// --- Window semantics. ---

	it("purges on inactivity (updatedAt), not creation date", async () => {
		await purgeExpiredConversationsActivity();

		for (const [sql] of mocks.executeRawUnsafeMock.mock.calls) {
			expect(sql).toContain(`"updatedAt" < $1`);
			expect(sql).not.toContain(`"createdAt"`);
		}
	});

	it("binds the cutoff as a parameter and derives it from the retention period", async () => {
		process.env[DAYS] = "30";

		const r = await purgeExpiredConversationsActivity();

		const [, cutoff] = mocks.executeRawUnsafeMock.mock.calls[0];
		expect(cutoff).toBeInstanceOf(Date);
		expect(r.retentionDays).toBe(30);
		const ageDays =
			(Date.now() - new Date(r.cutoffAt).getTime()) /
			(24 * 60 * 60 * 1000);
		expect(ageDays).toBeGreaterThan(29.9);
		expect(ageDays).toBeLessThan(30.1);
	});

	it("uses one cutoff for the whole run so a long purge cannot drift", async () => {
		await purgeExpiredConversationsActivity();

		const cutoffs = mocks.executeRawUnsafeMock.mock.calls.map(([, c]) =>
			(c as Date).getTime(),
		);
		expect(new Set(cutoffs).size).toBe(1);
	});

	// --- Coverage of the stores C1.2 names. ---

	it("covers both conversation stores", async () => {
		await purgeExpiredConversationsActivity();

		const sql = mocks.executeRawUnsafeMock.mock.calls
			.map(([s]) => s)
			.join("\n");
		expect(sql).toContain(`"ai_chat"`);
		expect(sql).toContain(`"agent_conversation"`);
	});

	it("reports deleted counts per table", async () => {
		deleteThenDrain(42);

		const r = await purgeExpiredConversationsActivity();

		expect(r.deletedCount).toBe(42);
		expect(r.tables.map((t) => t.table)).toEqual([
			"ai_chat",
			"agent_conversation",
		]);
	});

	// --- Batching. ---

	it("keeps batching until a batch deletes nothing", async () => {
		let calls = 0;
		mocks.executeRawUnsafeMock.mockImplementation(async () => {
			calls += 1;
			return calls < 3 ? 5_000 : 0;
		});

		const r = await purgeExpiredConversationsActivity();

		// 2 full batches + 1 empty on ai_chat, then 1 empty on agent_conversation.
		expect(r.deletedCount).toBe(10_000);
		expect(r.hitSafetyCap).toBe(false);
	});

	it("stops at the safety cap and says so rather than looping forever", async () => {
		mocks.executeRawUnsafeMock.mockResolvedValue(5_000);

		const r = await purgeExpiredConversationsActivity();

		expect(r.hitSafetyCap).toBe(true);
		expect(mocks.loggerWarnMock).toHaveBeenCalled();
		const [payload] = mocks.loggerWarnMock.mock.calls[0];
		expect((payload as { event: string }).event).toBe(
			"conversation.retention.safety_cap_hit",
		);
	});

	// --- The control forbids exposing deleted data in logs. ---

	it("logs counts and cutoffs only — never message content", async () => {
		deleteThenDrain(7);

		await purgeExpiredConversationsActivity();

		const logged = JSON.stringify([
			...mocks.loggerInfoMock.mock.calls,
			...mocks.loggerWarnMock.mock.calls,
		]);
		expect(logged).not.toContain("messages");
		expect(logged).not.toContain("trajectory");
		expect(logged).not.toContain("title");
	});
});
