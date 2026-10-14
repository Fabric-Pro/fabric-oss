import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	currentDispatchDeadline,
	DispatchDeadlinePassedError,
	dispatchDeadlineIn,
	dispatchDeadlinePassed,
	dispatchDeadlineRemainingMs,
	isDispatchDeadlinePassedError,
	runWithDispatchDeadline,
	throwIfDeadlinePassed,
	throwIfDispatchDeadlinePassed,
} from "../lib/dispatch-deadline";

describe("dispatch deadline", () => {
	// The monotonic clock, held still unless a test moves it.
	let clock = 10_000;
	beforeEach(() => {
		clock = 10_000;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is read on the monotonic clock, not the wall clock", () => {
		const deadline = dispatchDeadlineIn(50_000);
		expect(deadline).toBe(60_000);
		// A wall-clock jump does not move it.
		vi.spyOn(Date, "now").mockReturnValue(0);
		expect(dispatchDeadlinePassed(deadline)).toBe(false);
		clock = 60_000;
		expect(dispatchDeadlinePassed(deadline)).toBe(true);
	});

	it("reports the time left, and 0 once it has passed", () => {
		const deadline = dispatchDeadlineIn(1_000);
		clock += 400;
		expect(dispatchDeadlineRemainingMs(deadline)).toBe(600);
		clock += 5_000;
		expect(dispatchDeadlineRemainingMs(deadline)).toBe(0);
	});

	it("throwIfDeadlinePassed throws only past a deadline that is set", () => {
		expect(() => throwIfDeadlinePassed(undefined)).not.toThrow();
		const deadline = dispatchDeadlineIn(100);
		expect(() => throwIfDeadlinePassed(deadline)).not.toThrow();
		clock += 100;
		expect(() => throwIfDeadlinePassed(deadline)).toThrow(
			DispatchDeadlinePassedError,
		);
	});

	describe("a scope", () => {
		it("is read by the send check inside it, in work it awaits, and is a no-op outside", async () => {
			const deadline = dispatchDeadlineIn(100);
			const send = vi.fn();
			const guardedSend = async () => {
				await Promise.resolve();
				throwIfDispatchDeadlinePassed();
				send();
			};

			await runWithDispatchDeadline(deadline, guardedSend);
			expect(send).toHaveBeenCalledTimes(1);

			clock += 100;
			await expect(
				runWithDispatchDeadline(deadline, guardedSend),
			).rejects.toBeInstanceOf(DispatchDeadlinePassedError);
			expect(send).toHaveBeenCalledTimes(1);

			// Outside any scope there is nothing to check.
			expect(currentDispatchDeadline()).toBeUndefined();
			await guardedSend();
			expect(send).toHaveBeenCalledTimes(2);
		});

		it("keeps the earlier deadline when nested", () => {
			runWithDispatchDeadline(500, () => {
				runWithDispatchDeadline(900, () => {
					expect(currentDispatchDeadline()).toBe(500);
				});
				runWithDispatchDeadline(200, () => {
					expect(currentDispatchDeadline()).toBe(200);
				});
			});
		});
	});

	it("recognises the error by name, through a cause chain", () => {
		const refused = new DispatchDeadlinePassedError();
		expect(isDispatchDeadlinePassedError(refused)).toBe(true);
		expect(
			isDispatchDeadlinePassedError(
				new Error("wrapped", { cause: refused }),
			),
		).toBe(true);
		// A copy of the class from another module instance.
		expect(
			isDispatchDeadlinePassedError(
				Object.assign(new Error("x"), {
					name: "DispatchDeadlinePassedError",
				}),
			),
		).toBe(true);
		expect(isDispatchDeadlinePassedError(new Error("timed out"))).toBe(
			false,
		);
		expect(
			isDispatchDeadlinePassedError(
				new DOMException("aborted", "TimeoutError"),
			),
		).toBe(false);
		expect(isDispatchDeadlinePassedError(undefined)).toBe(false);
	});
});
