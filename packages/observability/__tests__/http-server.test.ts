import { beforeEach, expect, it, vi } from "vitest";
import { shutdownHttpServer } from "../lib/http-server";

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
