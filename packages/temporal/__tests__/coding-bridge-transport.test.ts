import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let server: Server;
let url: string;
let profile: string;
let artifactStatus: number;
let session: Record<string, unknown>;
let mutations: number;
beforeEach(async () => {
	profile = "example-profile";
	artifactStatus = 200;
	mutations = 0;
	session = {
		id: "example-session",
		status: "completed",
		branchName: "feat/example",
	};
	server = createServer((req, res) => {
		res.setHeader("Content-Type", "application/json");
		if (req.url === "/sessions/readiness") {
			res.end(
				JSON.stringify({
					protocolVersion: 2,
					profileId: profile,
					ready: true,
					capabilities: {
						durableReceipts: true,
						wholeRunCancellation: true,
					},
				}),
			);
		} else if (req.url?.endsWith("/artifacts")) {
			res.statusCode = artifactStatus;
			res.end(JSON.stringify({ artifacts: [] }));
		} else if (req.method === "POST") {
			mutations++;
			res.end(JSON.stringify({ ok: true }));
		} else {
			res.end(JSON.stringify(session));
		}
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Missing listener");
	}
	url = `http://127.0.0.1:${address.port}`;
	vi.stubEnv("BACKGROUND_AGENTS_URL", url);
	vi.stubEnv(
		"BACKGROUND_AGENTS_INTERNAL_SECRET",
		"synthetic-service-secret-for-contract-tests",
	);
	vi.resetModules();
});
afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
const adapter = async (pin = false) => {
	const { FabricBackgroundAdapter } = await import(
		"../src/lib/coding-execution/background-agents-provider"
	);
	return new FabricBackgroundAdapter(
		pin ? { url, profileId: "example-profile" } : undefined,
	);
};

describe("native coding transport guarantees", () => {
	it("does not turn an unavailable artifacts endpoint into an authoritative empty result", async () => {
		artifactStatus = 503;
		await expect(
			(await adapter()).getSessionStatus("example-session"),
		).rejects.toMatchObject({ code: "NETWORK_ERROR", statusCode: 503 });
	});
	it("rejects status returned for a different native session", async () => {
		session.id = "another-session";
		await expect(
			(await adapter()).getSessionStatus("example-session"),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
	});
	it("fences a mutation when the configured endpoint now points at a different profile", async () => {
		profile = "replacement-profile";
		await expect(
			(await adapter(true)).sendPrompt(
				"example-session",
				"Continue",
				"example-user",
				{ promptId: "example-prompt" },
			),
		).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
		expect(mutations).toBe(0);
	});
	it("does not accept an old ok-only stop acknowledgement as confirmed whole-run cancellation", async () => {
		await expect(
			(await adapter()).cancelSession("example-session"),
		).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
	});
	it("bounds status/artifact requests so a stalled endpoint cannot outlive activity retries", async () => {
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
		await expect(
			(await adapter()).getSessionStatus("example-session"),
		).rejects.toBeDefined();
		expect(AbortSignal.timeout).toHaveBeenCalledWith(20_000);
	});
});
