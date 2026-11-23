import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

vi.mock("@repo/logs", () => ({ logger: mocks }));

import { parlumeLog } from "../parlume-log";

describe("parlumeLog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("opts an info line in to the log sinks", () => {
		parlumeLog("info", "speech_health", {
			sessionId: "session-1",
			botId: "bot-1",
			slowStops: 1,
		});

		expect(mocks.info).toHaveBeenCalledWith("[Parlume] speech_health", {
			component: "parlume",
			event: "parlume.speech_health",
			sessionId: "session-1",
			botId: "bot-1",
			slowStops: 1,
			forward: true,
		});
	});

	it.each(["warn", "error"] as const)("marks a %s line too", (level) => {
		parlumeLog(level, "stream.error", { sessionId: "session-1" });

		expect(mocks[level]).toHaveBeenCalledWith(
			"[Parlume] stream.error",
			expect.objectContaining({
				event: "parlume.stream.error",
				forward: true,
			}),
		);
	});

	it("keeps the opt-in when a caller's fields name forward", () => {
		parlumeLog("info", "session.started", {
			sessionId: "session-1",
			forward: false,
		});

		expect(mocks.info).toHaveBeenCalledWith(
			"[Parlume] session.started",
			expect.objectContaining({ forward: true }),
		);
	});
});
