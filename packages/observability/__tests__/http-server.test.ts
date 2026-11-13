import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	registerHttpServerShutdown,
	shutdownHttpServer,
} from "../lib/http-server";

const { flush } = vi.hoisted(() => ({ flush: vi.fn() }));
vi.mock("../lib/init", () => ({ shutdownObservability: flush }));

beforeEach(() => flush.mockReset());

it("drains requests before cleanup and flushes final telemetry", async () => {
	const order: string[] = [];
	let drained: (error?: Error) => void = () => {};
	flush.mockImplementation(async () => order.push("flush"));
	const task = shutdownHttpServer(
		{
			close(callback) {
				drained = callback;
				order.push("close");
			},
			closeIdleConnections() {
				order.push("idle");
			},
		},
		async () => {
			order.push("cleanup");
		},
	);
	expect(order).toEqual(["close", "idle"]);
	drained();
	await task;
	expect(order).toEqual(["close", "idle", "cleanup", "flush"]);
});

it("still flushes telemetry when application cleanup fails", async () => {
	const failure = new Error("cleanup failed");
	await expect(
		shutdownHttpServer(
			{
				close(callback) {
					callback();
				},
			},
			async () => {
				throw failure;
			},
		),
	).rejects.toBe(failure);
	expect(flush).toHaveBeenCalledOnce();
});

describe("registerHttpServerShutdown", () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let sigtermHandler: (() => void) | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		sigtermHandler = undefined;
		vi.spyOn(process, "on").mockImplementation(
			(
				event: string | symbol,
				listener: (...args: unknown[]) => void,
			) => {
				if (event === "SIGTERM") {
					sigtermHandler = listener as () => void;
				}
				return process;
			},
		);
		exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation(() => undefined as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("exits with 1 after custom deadlineMs when close never calls back", () => {
		const hangingServer = { close: vi.fn() };
		registerHttpServerShutdown(hangingServer, undefined, {
			deadlineMs: 25_000,
		});

		expect(sigtermHandler).toBeDefined();
		sigtermHandler?.();

		vi.advanceTimersByTime(15_000);
		expect(exitSpy).not.toHaveBeenCalled();

		vi.advanceTimersByTime(10_000);
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("exits with 1 after 15 seconds default deadline when no options provided", () => {
		const hangingServer = { close: vi.fn() };
		registerHttpServerShutdown(hangingServer);

		expect(sigtermHandler).toBeDefined();
		sigtermHandler?.();

		vi.advanceTimersByTime(14_999);
		expect(exitSpy).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("does not start a second shutdown on a second SIGTERM", () => {
		const hangingServer = { close: vi.fn() };
		registerHttpServerShutdown(hangingServer);

		expect(sigtermHandler).toBeDefined();
		sigtermHandler?.();
		sigtermHandler?.();

		expect(hangingServer.close).toHaveBeenCalledOnce();
	});
});
