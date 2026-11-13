import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	after: vi.fn(),
}));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("react", () => ({
	cache: <T>(factory: () => T) => {
		let value: T | undefined;
		return () => {
			if (value === undefined) {
				value = factory();
			}
			return value;
		};
	},
}));

import { parseProxyTiming } from "@shared/lib/proxy-timing";
import { logAppRequestTiming } from "../catalog-request-timing";

function runAfterCallback(index: number) {
	const callback = mocks.after.mock.calls[index]?.[0];
	expect(callback).toBeTypeOf("function");
	callback?.();
}

describe("app request timing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("logs the first request and slow ones, and skips fast repeats", () => {
		// Arrange
		let clock = 1000;
		vi.spyOn(performance, "now").mockImplementation(() => clock);
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const receivedAt = Math.round(performance.timeOrigin + 1000 - 2400);
		// Microseconds: the whole process so far, or the delta since a start.
		vi.spyOn(process, "cpuUsage").mockImplementation((since) =>
			since
				? { user: 4000, system: 1000 }
				: { user: 90000, system: 10000 },
		);

		// Act
		logAppRequestTiming(`${receivedAt};300;1`);
		clock = 1500;
		runAfterCallback(0);
		logAppRequestTiming(null);
		clock = 1600;
		runAfterCallback(1);
		logAppRequestTiming(null);
		clock = 3000;
		runAfterCallback(2);

		// Assert
		expect(info).toHaveBeenCalledTimes(2);
		expect(info).toHaveBeenNthCalledWith(1, "App request timing", {
			event: "app.request_timing",
			moduleRequestIndex: 1,
			moduleEvaluatedAtMs: expect.any(Number),
			processUptimeMs: 1000,
			proxyToRenderMs: 2400,
			proxyUptimeMs: 300,
			proxyRequestIndex: 1,
			responseMs: 500,
			cpuMs: 5,
			loopStallMaxMs: expect.any(Number),
			processCpuMs: 100,
			phases: {},
		});
		expect(info).toHaveBeenNthCalledWith(
			2,
			"App request timing",
			expect.objectContaining({
				moduleRequestIndex: 3,
				proxyToRenderMs: undefined,
				responseMs: 2000,
			}),
		);
	});
});

describe("proxy timing header", () => {
	it("reads the three fields the proxy writes", () => {
		// Arrange
		const value = "1793976298483;582;4";

		// Act
		const timing = parseProxyTiming(value);

		// Assert
		expect(timing).toEqual({
			receivedAt: 1793976298483,
			uptimeMs: 582,
			requestIndex: 4,
		});
	});

	it.each([null, "", "1;2", "1;2;3;4", "a;b;c", "1.5;2;3"])(
		"ignores a malformed value %j",
		(value) => {
			// Act
			const timing = parseProxyTiming(value);

			// Assert
			expect(timing).toBeUndefined();
		},
	);
});
