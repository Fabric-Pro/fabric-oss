import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSseController } from "../src/utils/sse-controller";

const bytes = (text: string) => new TextEncoder().encode(text);
const decode = (data: unknown) => new TextDecoder().decode(data as Uint8Array);

function makeController(
	overrides: Partial<ReadableStreamDefaultController<Uint8Array>> = {},
) {
	return {
		enqueue: vi.fn(),
		close: vi.fn(),
		desiredSize: 1,
		error: vi.fn(),
		...overrides,
	} as unknown as ReadableStreamDefaultController<Uint8Array>;
}

function invalidState() {
	return Object.assign(new Error("closed"), { code: "ERR_INVALID_STATE" });
}

describe("createSseController", () => {
	describe("enqueue", () => {
		it("enqueues on an open controller and returns true", () => {
			const controller = makeController();
			const sse = createSseController();
			sse.attach(controller);
			const data = bytes("hello");
			expect(sse.enqueue(data)).toBe(true);
			expect(controller.enqueue).toHaveBeenCalledWith(data);
			expect(sse.isOpen).toBe(true);
		});

		it("returns false and skips the controller after close", () => {
			const controller = makeController();
			const sse = createSseController();
			sse.attach(controller);
			sse.close();
			expect(sse.enqueue(bytes("late"))).toBe(false);
			expect(controller.enqueue).not.toHaveBeenCalled();
		});

		it("returns false when nothing is attached yet", () => {
			const sse = createSseController();
			expect(sse.isOpen).toBe(false);
			expect(sse.enqueue(bytes("early"))).toBe(false);
		});

		it("treats ERR_INVALID_STATE as closed and fires the callback once", () => {
			const onClosedDuringEnqueue = vi.fn();
			const controller = makeController({
				enqueue: vi.fn(() => {
					throw invalidState();
				}),
			});
			const sse = createSseController({ onClosedDuringEnqueue });
			sse.attach(controller);
			expect(sse.enqueue(bytes("a"))).toBe(false);
			expect(sse.isOpen).toBe(false);
			expect(sse.enqueue(bytes("b"))).toBe(false);
			expect(controller.enqueue).toHaveBeenCalledTimes(1);
			expect(onClosedDuringEnqueue).toHaveBeenCalledTimes(1);
		});

		it("rethrows other errors and stays open", () => {
			const boom = Object.assign(new Error("boom"), { code: "OTHER" });
			const controller = makeController({
				enqueue: vi.fn(() => {
					throw boom;
				}),
			});
			const onClosedDuringEnqueue = vi.fn();
			const sse = createSseController({ onClosedDuringEnqueue });
			sse.attach(controller);
			expect(() => sse.enqueue(bytes("a"))).toThrow(boom);
			expect(sse.isOpen).toBe(true);
			expect(onClosedDuringEnqueue).not.toHaveBeenCalled();
		});
	});

	describe("close", () => {
		it("closes the controller once and marks it closed", () => {
			const controller = makeController();
			const sse = createSseController();
			sse.attach(controller);
			sse.close();
			sse.close();
			expect(controller.close).toHaveBeenCalledTimes(1);
			expect(sse.isOpen).toBe(false);
		});

		it("swallows a throw from controller.close and fires the callback", () => {
			const onCloseThrew = vi.fn();
			const controller = makeController({
				close: vi.fn(() => {
					throw invalidState();
				}),
			});
			const sse = createSseController({ onCloseThrew });
			sse.attach(controller);
			expect(() => sse.close()).not.toThrow();
			expect(onCloseThrew).toHaveBeenCalledTimes(1);
			expect(sse.isOpen).toBe(false);
		});

		it("swallows a close error that is not ERR_INVALID_STATE", () => {
			const controller = makeController({
				close: vi.fn(() => {
					throw new Error("boom");
				}),
			});
			const sse = createSseController();
			sse.attach(controller);
			expect(() => sse.close()).not.toThrow();
			expect(sse.isOpen).toBe(false);
		});

		it("does not call controller.close after a discovered closure", () => {
			const controller = makeController({
				enqueue: vi.fn(() => {
					throw invalidState();
				}),
			});
			const sse = createSseController();
			sse.attach(controller);
			sse.enqueue(bytes("a"));
			sse.close();
			expect(controller.close).not.toHaveBeenCalled();
		});
	});

	describe("desiredSize", () => {
		it("reads through to the attached controller", () => {
			const sse = createSseController();
			expect(sse.desiredSize).toBeNull();
			sse.attach(makeController({ desiredSize: -2 }));
			expect(sse.desiredSize).toBe(-2);
		});

		it("reflects a queue size that changes after attach", () => {
			const controller = { ...makeController(), desiredSize: 1 };
			const sse = createSseController();
			sse.attach(controller);
			expect(sse.desiredSize).toBe(1);
			controller.desiredSize = -3;
			expect(sse.desiredSize).toBe(-3);
		});
	});

	describe("keepalive", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it("enqueues the keepalive comment at the interval", () => {
			const controller = makeController();
			const sse = createSseController();
			sse.attach(controller);
			sse.startKeepalive({ intervalMs: 1000, stopOnClosed: false });
			expect(controller.enqueue).not.toHaveBeenCalled();
			vi.advanceTimersByTime(2500);
			expect(controller.enqueue).toHaveBeenCalledTimes(2);
			expect(
				decode(vi.mocked(controller.enqueue).mock.calls[0]?.[0]),
			).toBe(":keepalive\n\n");
			sse.stopKeepalive();
		});

		it("stopOnClosed true stops the timer after a failed enqueue", () => {
			const controller = makeController({
				enqueue: vi.fn(() => {
					throw invalidState();
				}),
			});
			const sse = createSseController();
			sse.attach(controller);
			sse.startKeepalive({ intervalMs: 1000, stopOnClosed: true });
			vi.advanceTimersByTime(5000);
			expect(controller.enqueue).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("stopOnClosed true keeps firing while enqueues succeed", () => {
			let closed = false;
			const controller = makeController({
				enqueue: vi.fn(() => {
					if (closed) {
						throw invalidState();
					}
				}),
			});
			const sse = createSseController();
			sse.attach(controller);
			sse.startKeepalive({ intervalMs: 1000, stopOnClosed: true });
			vi.advanceTimersByTime(3000);
			expect(controller.enqueue).toHaveBeenCalledTimes(3);
			expect(vi.getTimerCount()).toBe(1);
			closed = true;
			vi.advanceTimersByTime(3000);
			expect(controller.enqueue).toHaveBeenCalledTimes(4);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("stopKeepalive leaves the controller open for later enqueues", () => {
			const controller = makeController();
			const sse = createSseController();
			sse.attach(controller);
			sse.startKeepalive({ intervalMs: 1000, stopOnClosed: false });
			sse.stopKeepalive();
			expect(sse.isOpen).toBe(true);
			expect(sse.enqueue(bytes("after"))).toBe(true);
		});

		it("stopOnClosed false keeps firing after a failed enqueue", () => {
			const controller = makeController();
			const sse = createSseController();
			sse.attach(controller);
			sse.startKeepalive({ intervalMs: 1000, stopOnClosed: false });
			vi.advanceTimersByTime(1000);
			sse.close();
			expect(vi.getTimerCount()).toBe(1);
			vi.advanceTimersByTime(3000);
			expect(vi.getTimerCount()).toBe(1);
			expect(controller.enqueue).toHaveBeenCalledTimes(1);
			sse.stopKeepalive();
		});

		it("stopKeepalive is idempotent and stops further enqueues", () => {
			const controller = makeController();
			const sse = createSseController();
			sse.attach(controller);
			sse.startKeepalive({ intervalMs: 1000, stopOnClosed: false });
			vi.advanceTimersByTime(1000);
			sse.stopKeepalive();
			expect(() => sse.stopKeepalive()).not.toThrow();
			vi.advanceTimersByTime(5000);
			expect(controller.enqueue).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("stopKeepalive works before attach (cancel path) and without start", () => {
			const sse = createSseController();
			expect(() => sse.stopKeepalive()).not.toThrow();
		});

		it("startKeepalive replaces a previous timer instead of leaking it", () => {
			const sse = createSseController();
			sse.attach(makeController());
			sse.startKeepalive({ intervalMs: 1000, stopOnClosed: false });
			sse.startKeepalive({ intervalMs: 1000, stopOnClosed: false });
			expect(vi.getTimerCount()).toBe(1);
			sse.stopKeepalive();
		});
	});
});
