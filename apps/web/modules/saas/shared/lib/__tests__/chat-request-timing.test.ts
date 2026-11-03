import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ after: vi.fn(), now: 100 }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("react", () => ({
	cache: <T>(factory: () => T) => {
		let value: T | undefined;
		return () => {
			value ??= factory();
			return value;
		};
	},
}));

beforeEach(() => {
	vi.resetModules();
	mocks.after.mockReset();
	mocks.now = 100;
	vi.spyOn(performance, "now").mockImplementation(() => mocks.now);
});
afterEach(() => vi.restoreAllMocks());

describe("chat request timing", () => {
	it("retains overlapping phase offsets and emits only after the response", async () => {
		const { logChatRequestTiming, measureCatalogRequestPhase } =
			await import("../catalog-request-timing");
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		logChatRequestTiming("main");
		mocks.now = 105;
		await measureCatalogRequestPhase("saas_prefetch", async () => {
			mocks.now = 110;
			await measureCatalogRequestPhase("chat_preferences", async () => {
				mocks.now = 160;
			});
			mocks.now = 175;
		});
		expect(info).not.toHaveBeenCalled();
		expect(mocks.after).toHaveBeenCalledOnce();
		mocks.now = 230;
		mocks.after.mock.calls[0]?.[0]();
		expect(info).toHaveBeenCalledWith("Chat request timing", {
			event: "chat.request_timing",
			route: "main",
			elapsedAtAfterMs: 130,
			phases: { saas_prefetch: 70, chat_preferences: 50 },
			phaseOffsets: {
				saas_prefetch: { startMs: 5, endMs: 75 },
				chat_preferences: { startMs: 10, endMs: 60 },
			},
		});
	});

	it("preserves a failed operation without logging its input or error", async () => {
		const { logChatRequestTiming, measureCatalogRequestPhase } =
			await import("../catalog-request-timing");
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const failure = new Error("private example input");
		logChatRequestTiming("registered-agent");
		mocks.now = 110;
		await expect(
			measureCatalogRequestPhase("chat_registry", async () => {
				mocks.now = 130;
				throw failure;
			}),
		).rejects.toBe(failure);
		mocks.now = 180;
		mocks.after.mock.calls[0]?.[0]();
		expect(info).toHaveBeenCalledWith("Chat request timing", {
			event: "chat.request_timing",
			route: "registered-agent",
			elapsedAtAfterMs: 80,
			phases: { chat_registry: 20 },
			phaseOffsets: { chat_registry: { startMs: 10, endMs: 30 } },
		});
		expect(JSON.stringify(info.mock.calls)).not.toContain(failure.message);
	});
});
