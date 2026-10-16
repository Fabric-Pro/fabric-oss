import { logger } from "@repo/logs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { warmParlumeSession } from "../parlume-warmup";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	load: vi.fn(),
	collect: vi.fn(),
	model: vi.fn(),
	speech: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { parlumeMeetingSession: { findUnique: mocks.session } },
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.model,
	getAISpeechModel: mocks.speech,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../parlume-agent", () => ({ loadParlumeAgent: mocks.load }));
vi.mock("../direct-chat/mcp-tools", () => ({
	collectMcpToolsActivity: mocks.collect,
}));
vi.mock("../shared/project-context-block", () => ({}));

const session = {
	id: "session",
	status: "ACTIVE",
	agentKind: "FABRIC_AGENT",
	agentInstanceSId: null,
	projectId: "project",
	organizationId: "org",
	userId: "user",
};

function warmLog() {
	const call = vi
		.mocked(logger.info)
		.mock.calls.find(([message]) => message === "[Parlume] session.warmed");
	return call?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.session.mockResolvedValue(session);
	mocks.load.mockResolvedValue({
		kind: "FABRIC_AGENT",
		revision: "revision",
		enabledMcpConfigIds: ["server"],
	});
	mocks.collect.mockResolvedValue({ mcpToolInfo: [] });
	mocks.model.mockResolvedValue({});
	mocks.speech.mockResolvedValue(null);
});

describe("Parlume session warm-up", () => {
	it("runs the first steps of a spoken turn and logs what each cost", async () => {
		await warmParlumeSession({ sessionId: "session" });

		expect(mocks.load).toHaveBeenCalledWith(session);
		expect(mocks.collect).toHaveBeenCalledWith("user", "org", ["server"]);
		expect(mocks.model).toHaveBeenCalledWith(
			expect.objectContaining({ requiresToolCalling: true }),
			expect.objectContaining({
				featureKey: "parlume",
				conversationId: "session",
				userId: "user",
				organizationId: "org",
			}),
		);
		expect(mocks.speech).toHaveBeenCalledWith({
			userId: "user",
			organizationId: "org",
		});
		const log = warmLog();
		expect(log).toMatchObject({
			sessionId: "session",
			live: true,
			failed: [],
		});
		expect(Object.keys(log?.timings as object).sort()).toEqual(
			[
				"agentLoadMs",
				"modelResolveMs",
				"projectBlockImportMs",
				"sessionLoadMs",
				"speechRouteMs",
			].sort(),
		);
	});

	it("loads a custom agent without collecting tools for it", async () => {
		mocks.load.mockResolvedValue({
			kind: "TEMPLATE_INSTANCE",
			revision: "r",
		});
		await warmParlumeSession({ sessionId: "session" });
		expect(mocks.load).toHaveBeenCalledTimes(1);
		expect(mocks.collect).not.toHaveBeenCalled();
	});

	it("does nothing for a session that is not in a meeting", async () => {
		mocks.session.mockResolvedValue({ ...session, status: "ENDED" });
		await warmParlumeSession({ sessionId: "session" });
		expect(mocks.load).not.toHaveBeenCalled();
		expect(mocks.model).not.toHaveBeenCalled();
		expect(warmLog()).toMatchObject({ live: false });
	});

	it("does nothing for a session that does not exist", async () => {
		mocks.session.mockResolvedValue(null);
		await expect(
			warmParlumeSession({ sessionId: "gone" }),
		).resolves.toBeUndefined();
		expect(mocks.load).not.toHaveBeenCalled();
	});

	it("skips a step that fails, reports it, and still runs the others", async () => {
		mocks.load.mockRejectedValue(new Error("Database unavailable"));
		mocks.model.mockRejectedValue(new Error("No provider"));
		await expect(
			warmParlumeSession({ sessionId: "session" }),
		).resolves.toBeUndefined();
		expect(mocks.speech).toHaveBeenCalledTimes(1);
		expect((warmLog()?.failed as string[]).sort()).toEqual([
			"agentLoadMs",
			"modelResolveMs",
		]);
	});

	it("never throws, even when the session cannot be read", async () => {
		mocks.session.mockRejectedValue(new Error("Connection lost"));
		await expect(
			warmParlumeSession({ sessionId: "session" }),
		).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(
			"[Parlume] session.warm_failed",
			expect.objectContaining({ sessionId: "session" }),
		);
	});
});
