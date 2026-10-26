import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DispatchBudget,
	type DispatchBudgetRequest,
	type DispatchGuard,
	dispatchBudgetSend,
	runWithDispatchGuard,
} from "../lib/dispatch-guard";

const request: DispatchBudgetRequest = {
	modality: "external",
	inputEstimate: 12,
	requestedOutputTokens: 100,
	minOutputTokens: 100,
	enforcesOutputCap: false,
};
function fixture() {
	const budget = {
		reserve: vi.fn(async () => ({ attemptId: "attempt-1", outputCap: 42 })),
		settle: vi.fn(async () => {}),
		markUnknown: vi.fn(async () => {}),
		release: vi.fn(async () => {}),
	} satisfies DispatchBudget;
	const guard: DispatchGuard = {
		key: "example-turn",
		assertDispatchable: vi.fn(async () => {}),
		abortSignal: () => undefined,
		rethrowIfStopped: () => {},
		budget,
	};
	return { budget, guard };
}
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
describe("dispatchBudgetSend", () => {
	it("passes the original signal and result through outside a guard", async () => {
		const signal = new AbortController().signal;
		const result = { ok: true };
		const send = vi.fn(async () => ({ result }));
		expect(await dispatchBudgetSend({ request, signal, send })).toBe(
			result,
		);
		expect(send).toHaveBeenCalledWith(signal, null);
	});
	it("checks a guard without a budget and merges its signal", async () => {
		const { guard } = fixture();
		const controller = new AbortController();
		const stopped = vi.fn();
		const unledgered = {
			...guard,
			budget: undefined,
			abortSignal: () => controller.signal,
			throwIfStopped: stopped,
		};
		const send = vi.fn(async () => ({ result: "ok" }));
		await runWithDispatchGuard(unledgered, () =>
			dispatchBudgetSend({ request, send }),
		);
		expect(guard.assertDispatchable).toHaveBeenCalledOnce();
		expect(stopped).toHaveBeenCalled();
		expect(send).toHaveBeenCalledWith(controller.signal, null);
	});
	it("sends unreserved with no terminal transition when reserve returns null", async () => {
		const { guard, budget } = fixture();
		const reserve = vi.fn(async () => null);
		const send = vi.fn(async () => ({
			result: "ok",
			usage: { inputTokens: 1, outputTokens: 2 },
		}));
		expect(
			await runWithDispatchGuard(
				{ ...guard, budget: { ...budget, reserve } },
				() => dispatchBudgetSend({ request, send }),
			),
		).toBe("ok");
		expect(reserve).toHaveBeenCalledWith(request);
		expect(send).toHaveBeenCalledWith(undefined, null);
		expect(budget.settle).not.toHaveBeenCalled();
		expect(budget.markUnknown).not.toHaveBeenCalled();
		expect(budget.release).not.toHaveBeenCalled();
	});
	it("propagates refused admission before calling send", async () => {
		const { guard, budget } = fixture();
		const error = new Error("refused");
		budget.reserve.mockRejectedValue(error);
		const send = vi.fn(async () => ({ result: "bad" }));
		await expect(
			runWithDispatchGuard(guard, () =>
				dispatchBudgetSend({ request, send }),
			),
		).rejects.toBe(error);
		expect(send).not.toHaveBeenCalled();
		expect(budget.markUnknown).not.toHaveBeenCalled();
	});
	it("releases when a stop latches during reservation without calling send", async () => {
		const { guard, budget } = fixture();
		const stop = new Error("stopped");
		let stopped = false;
		budget.reserve.mockImplementation(async () => {
			stopped = true;
			return { attemptId: "attempt-1", outputCap: 42 };
		});
		guard.throwIfStopped = () => {
			if (stopped) {
				throw stop;
			}
		};
		const send = vi.fn(async () => ({ result: "bad" }));
		await expect(
			runWithDispatchGuard(guard, () =>
				dispatchBudgetSend({ request, send }),
			),
		).rejects.toBe(stop);
		expect(send).not.toHaveBeenCalled();
		expect(budget.release).toHaveBeenCalledWith("attempt-1");
		expect(budget.markUnknown).not.toHaveBeenCalled();
	});
	it("settles complete provider usage after the send with the granted cap", async () => {
		const { guard, budget } = fixture();
		const usage = { inputTokens: 5, outputTokens: 7 };
		const send = vi.fn(async () => {
			expect(budget.reserve).toHaveBeenCalledWith(request);
			return { result: "ok", usage };
		});
		expect(
			await runWithDispatchGuard(guard, () =>
				dispatchBudgetSend({ request, send }),
			),
		).toBe("ok");
		expect(send).toHaveBeenCalledWith(undefined, 42);
		expect(budget.settle).toHaveBeenCalledWith("attempt-1", usage);
		expect(budget.markUnknown).not.toHaveBeenCalled();
	});
	it.each([
		undefined,
		{ inputTokens: 4 },
		{ outputTokens: 2 },
		{ inputTokens: Number.NaN, outputTokens: 2 },
	])("keeps incomplete usage charged: %j", async (usage) => {
		const { guard, budget } = fixture();
		await runWithDispatchGuard(guard, () =>
			dispatchBudgetSend({
				request,
				send: async () => ({ result: "ok", usage }),
			}),
		);
		expect(budget.markUnknown).toHaveBeenCalledWith("attempt-1");
		expect(budget.settle).not.toHaveBeenCalled();
	});
	it.each(["transport error", "body parse failure", "abort after send"])(
		"keeps the charge after %s",
		async (message) => {
			const { guard, budget } = fixture();
			const error = new Error(message);
			await expect(
				runWithDispatchGuard(guard, () =>
					dispatchBudgetSend({
						request,
						send: async () => {
							throw error;
						},
					}),
				),
			).rejects.toBe(error);
			expect(budget.markUnknown).toHaveBeenCalledWith("attempt-1");
			expect(budget.release).not.toHaveBeenCalled();
		},
	);
	it.each(["settle", "markUnknown"] as const)(
		"a failed %s does not fail a successful send",
		async (transition) => {
			const { guard, budget } = fixture();
			budget[transition].mockRejectedValue(
				new Error("ledger unavailable"),
			);
			vi.spyOn(console, "warn").mockImplementation(() => {});
			expect(
				await runWithDispatchGuard(guard, () =>
					dispatchBudgetSend({
						request,
						send: async () => ({
							result: "ok",
							...(transition === "settle"
								? { usage: { inputTokens: 1, outputTokens: 2 } }
								: {}),
						}),
					}),
				),
			).toBe("ok");
			expect(budget[transition]).toHaveBeenCalledOnce();
			expect(budget.release).not.toHaveBeenCalled();
		},
	);
	it.each(["settle", "markUnknown"] as const)(
		"bounds the wait for %s without racing a second transition",
		async (transition) => {
			vi.useFakeTimers();
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const { guard, budget } = fixture();
			budget[transition].mockImplementation(() => new Promise(() => {}));
			const running = runWithDispatchGuard(guard, () =>
				dispatchBudgetSend({
					request,
					send: async () => ({
						result: "ok",
						...(transition === "settle"
							? { usage: { inputTokens: 1, outputTokens: 2 } }
							: {}),
					}),
				}),
			);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await running).toBe("ok");
			expect(budget[transition]).toHaveBeenCalledOnce();
			expect(budget.release).not.toHaveBeenCalled();
		},
	);
	it("releases an already aborted ledgered request before send", async () => {
		const { guard, budget } = fixture();
		const signal = AbortSignal.abort(new Error("timeout"));
		const send = vi.fn();
		await expect(
			runWithDispatchGuard(guard, () =>
				dispatchBudgetSend({ request, signal, send }),
			),
		).rejects.toBe(signal.reason);
		expect(budget.release).toHaveBeenCalledWith("attempt-1");
		expect(send).not.toHaveBeenCalled();
	});
});
