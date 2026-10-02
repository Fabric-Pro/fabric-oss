import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	recordInstructionSnapshotProgress: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	recordInstructionSnapshotProgress: (...a: unknown[]) =>
		m.recordInstructionSnapshotProgress(...a),
}));
vi.mock("@repo/logs", () => ({ logger: { warn: m.warn } }));

import { createSnapshotProgress } from "../instruction-progress";

const target = {
	snapshotId: "s",
	projectId: "p",
	organizationId: "o",
	validationAttemptId: "attempt-1",
};

function writtenDone(): number[] {
	return m.recordInstructionSnapshotProgress.mock.calls.map(
		([input]) => (input as { done: number }).done,
	);
}

beforeEach(() => {
	m.recordInstructionSnapshotProgress.mockReset();
	m.recordInstructionSnapshotProgress.mockResolvedValue({ changed: true });
	m.warn.mockReset();
});

describe("createSnapshotProgress", () => {
	it("writes the pass start immediately: nothing decided yet, out of every file", async () => {
		const progress = createSnapshotProgress(target, "CHECKING", 40);

		await progress.begin();

		expect(m.recordInstructionSnapshotProgress).toHaveBeenCalledWith({
			...target,
			phase: "CHECKING",
			done: 0,
			total: 40,
		});
	});

	it("writes at most once a second, and always writes the final count", async () => {
		let clock = 0;
		const progress = createSnapshotProgress(
			target,
			"SAVING",
			5,
			() => clock,
		);

		await progress.begin();
		clock = 100;
		await progress.advance(1);
		clock = 900;
		await progress.advance(2);
		clock = 1000;
		await progress.advance(3);
		clock = 1100;
		await progress.advance(4);
		clock = 1200;
		await progress.advance(5);

		expect(writtenDone()).toEqual([0, 3, 5]);
	});

	it("does not write the same count twice", async () => {
		const progress = createSnapshotProgress(target, "CHECKING", 1);

		await progress.advance(1);
		await progress.advance(1);

		expect(writtenDone()).toEqual([1]);
	});

	it("awaits its write before the pass moves on", async () => {
		let release!: () => void;
		m.recordInstructionSnapshotProgress.mockReturnValue(
			new Promise((resolve) => {
				release = () => resolve({ changed: true });
			}),
		);
		const progress = createSnapshotProgress(target, "CHECKING", 3);
		let settled = false;

		const pending = progress.begin().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		await pending;

		expect(settled).toBe(true);
	});

	it("logs a failed write by error class and carries on", async () => {
		m.recordInstructionSnapshotProgress.mockRejectedValue(
			new TypeError("connection to host db.internal refused"),
		);
		const progress = createSnapshotProgress(target, "CHECKING", 2);

		await expect(progress.begin()).resolves.toBeUndefined();
		await expect(progress.advance(2)).resolves.toBeUndefined();

		expect(m.warn).toHaveBeenCalledTimes(2);
		const [context] = m.warn.mock.calls[0] as [Record<string, unknown>];
		expect(context.failure).toBe("TypeError");
		expect(JSON.stringify(context)).not.toContain("db.internal");
	});

	it("carries no token for a run that started without one", async () => {
		const progress = createSnapshotProgress(
			{ snapshotId: "s", projectId: "p", organizationId: "o" },
			"SCANNING",
			1,
		);

		await progress.begin();

		expect(m.recordInstructionSnapshotProgress).toHaveBeenCalledWith({
			snapshotId: "s",
			projectId: "p",
			organizationId: "o",
			phase: "SCANNING",
			done: 0,
			total: 1,
		});
	});
});
