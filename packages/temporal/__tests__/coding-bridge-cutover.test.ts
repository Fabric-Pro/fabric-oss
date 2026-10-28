import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let server: Server;
let calls: { path: string; body: Record<string, unknown> }[];
let createStatus: number;
beforeEach(async () => {
	calls = [];
	createStatus = 200;
	server = createServer(async (req, res) => {
		const parts: Buffer[] = [];
		for await (const part of req) {
			parts.push(Buffer.from(part));
		}
		const body = parts.length
			? JSON.parse(Buffer.concat(parts).toString())
			: {};
		calls.push({ path: req.url ?? "", body });
		res.setHeader("Content-Type", "application/json");
		if (req.url === "/webhook") {
			res.end(
				JSON.stringify({
					ok: true,
					controlPlaneSessionId: "example-bot-session",
				}),
			);
		} else if (req.url === "/sessions") {
			res.statusCode = createStatus;
			res.end(JSON.stringify({ sessionId: "example-session" }));
		} else {
			res.statusCode = 202;
			res.end(JSON.stringify({ ok: true }));
		}
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Missing test listener");
	}
	vi.stubEnv("BACKGROUND_AGENTS_URL", `http://127.0.0.1:${address.port}`);
	vi.stubEnv(
		"BACKGROUND_AGENTS_INTERNAL_SECRET",
		"synthetic-service-secret-for-contract-tests",
	);
	vi.stubEnv("FABRIC_BOT_URL", undefined);
	vi.stubEnv("FABRIC_BOT_SECRET", undefined);
	vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", undefined);
	vi.resetModules();
});
afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	vi.unstubAllEnvs();
});
const params = {
	repoOwner: "example-org",
	repoName: "example-repo",
	codingRunId: "example-run",
	branch: "main",
};
describe("operator-controlled native server cutover", () => {
	it("preserves the existing protocol while the new bridge is off by default", async () => {
		const {
			getBackgroundAgentsProvider,
			getCodingExecutionAdapterDefinition,
		} = await import("../src/lib/coding-execution/registry");
		expect(
			getCodingExecutionAdapterDefinition("BACKGROUND_AGENTS")
				.adapterName,
		).toBe("LegacyBackgroundAdapter");
		const provider = getBackgroundAgentsProvider();
		const created = await provider.createSession(params);
		await expect(
			provider.sendPrompt(created.sessionId, "Continue", "example-user", {
				promptId: "example-attempt",
			}),
		).resolves.toBeUndefined();
		expect(calls[0].body).toEqual({
			repoOwner: params.repoOwner,
			repoName: params.repoName,
			branch: "main",
		});
		expect(calls[1].body).toEqual({
			content: "Continue",
			authorId: "example-user",
			source: "fabric",
		});
	});
	it("preserves configured legacy bot session creation and ignores it after native opt-in", async () => {
		vi.stubEnv("FABRIC_BOT_URL", process.env.BACKGROUND_AGENTS_URL);
		vi.stubEnv("FABRIC_BOT_SECRET", "synthetic-legacy-bot-secret");
		const { getBackgroundAgentsProvider } = await import(
			"../src/lib/coding-execution/registry"
		);
		await expect(
			getBackgroundAgentsProvider().createSession(params),
		).resolves.toMatchObject({ sessionId: "example-bot-session" });
		expect(calls[0]).toMatchObject({
			path: "/webhook",
			body: { action: "started", codingRunId: params.codingRunId },
		});
		vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
		await getBackgroundAgentsProvider().createSession(params);
		expect(calls[1].path).toBe("/sessions");
	});
	it("requires explicit opt-in and a native receipt after cutover", async () => {
		vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
		const {
			getBackgroundAgentsProvider,
			getCodingExecutionAdapterDefinition,
		} = await import("../src/lib/coding-execution/registry");
		expect(
			getCodingExecutionAdapterDefinition("BACKGROUND_AGENTS"),
		).toMatchObject({
			adapterName: "FabricBackgroundAdapter",
			capabilities: { pushBranchWithoutPr: false },
		});
		const provider = getBackgroundAgentsProvider();
		await provider.createSession(params);
		expect(calls[0].body.codingRunId).toBe(params.codingRunId);
		await expect(
			provider.sendPrompt("example-session", "Continue", "example-user", {
				promptId: "example-attempt",
			}),
		).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
	});
	it("never falls back to the old client when the selected native server fails", async () => {
		vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
		createStatus = 503;
		const { getBackgroundAgentsProvider } = await import(
			"../src/lib/coding-execution/registry"
		);
		await expect(
			getBackgroundAgentsProvider().createSession(params),
		).rejects.toMatchObject({ code: "NETWORK_ERROR" });
		expect(calls).toHaveLength(1);
	});
	it("refuses native-only settings before sending to an old service", async () => {
		const { getBackgroundAgentsProvider } = await import(
			"../src/lib/coding-execution/registry"
		);
		await expect(
			getBackgroundAgentsProvider().createSession({
				...params,
				llmConnection: "kimi-cli",
			}),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
		expect(calls).toHaveLength(0);
	});
});
