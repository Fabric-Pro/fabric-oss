import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	settings: vi.fn(),
	purge: vi.fn(),
	log: vi.fn(),
}));

vi.mock("../parlume-attendee", () => ({
	getParlumeBridgeSettings: () => mocks.settings(),
	purgeParlumeBridgeStorage: (...args: unknown[]) => mocks.purge(...args),
}));

vi.mock("../parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

import { requestParlumeBridgePurge } from "../parlume-bridge-purge";

const bridge = {
	bridgeUrl: "wss://bridge.example.com/live",
	callbackUrl: "https://fabric.example.com/api/internal/parlume/callback",
	serviceSecret: "service-secret",
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.settings.mockReturnValue(bridge);
	mocks.purge.mockResolvedValue({ purged: true });
});

describe("requestParlumeBridgePurge", () => {
	it("asks the session's bridge to purge its storage", async () => {
		await requestParlumeBridgePurge("session-1", "finalized");

		expect(mocks.purge).toHaveBeenCalledWith({
			settings: bridge,
			sessionId: "session-1",
		});
		expect(mocks.log).not.toHaveBeenCalled();
	});

	it("never fails its caller when the bridge cannot be reached, and logs it", async () => {
		mocks.purge.mockRejectedValue(new Error("bridge unavailable"));

		await expect(
			requestParlumeBridgePurge("session-1", "deleted"),
		).resolves.toBeUndefined();
		expect(mocks.log).toHaveBeenCalledWith("warn", "bridge.purge_failed", {
			sessionId: "session-1",
			reason: "deleted",
			error: "bridge unavailable",
		});
	});

	it("logs a purge the bridge refused while a stream is still connected", async () => {
		mocks.purge.mockResolvedValue({ purged: false });

		await requestParlumeBridgePurge("session-1", "finalized");

		expect(mocks.log).toHaveBeenCalledWith(
			"info",
			"bridge.purge_deferred",
			{ sessionId: "session-1", reason: "finalized" },
		);
	});

	it("asks nothing when no bridge is configured", async () => {
		mocks.settings.mockReturnValue(null);

		await requestParlumeBridgePurge("session-1", "finalized");

		expect(mocks.purge).not.toHaveBeenCalled();
	});
});
