/**
 * What git.ts does to a git that outlives its deadline (Fizzy #2878): SIGTERM
 * at the deadline, and SIGKILL a second later unless the process has gone by
 * then. The escalation must actually fire, and must be cleared once the
 * process exits.
 *
 * `spawn` is a scripted child and the clock is faked, so nothing here runs git.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remotes } from "../src/lib/instructions/git.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: spawnMock,
}));

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill = vi.fn();
}

let child: FakeChild;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	child = new FakeChild();
	spawnMock.mockReset();
	spawnMock.mockReturnValue(child);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a git that outlives its deadline", () => {
	it("is asked to stop at the deadline, and answers that it timed out", async () => {
		const pending = remotes("/work/rules", Date.now() + 5_000);

		await vi.advanceTimersByTimeAsync(5_000);

		expect(await pending).toEqual({
			kind: "unavailable",
			reason: "git timed out",
		});
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
	});

	it("is killed a second later when it ignored the request", async () => {
		const pending = remotes("/work/rules", Date.now() + 5_000);
		await vi.advanceTimersByTimeAsync(5_000);
		await pending;

		await vi.advanceTimersByTimeAsync(1_000);

		expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
	});

	it("is not killed a second time when it exited in between", async () => {
		const pending = remotes("/work/rules", Date.now() + 5_000);
		await vi.advanceTimersByTimeAsync(5_000);
		await pending;
		child.emit("close", null);

		await vi.advanceTimersByTimeAsync(5_000);

		expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
	});

	it("is left alone when it answers before the deadline", async () => {
		const pending = remotes("/work/rules", Date.now() + 5_000);
		child.stdout.emit("data", Buffer.from("origin\n"));
		child.emit("close", 0);

		const result = await pending;
		await vi.advanceTimersByTimeAsync(10_000);

		expect(result).toEqual({ kind: "ok", value: ["origin"] });
		expect(child.kill).not.toHaveBeenCalled();
	});
});
