import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FabricBackgroundAdapter } from "../src/lib/coding-execution/background-agents-provider";

const secret = "example-connection-specific-service-secret";
const f = vi.hoisted(() => ({ secret: vi.fn(), disabled: false }));
vi.mock("@repo/database", () => ({ getRemoteAgentServerSecret: f.secret }));
let server: Server;
let url: string;
let paths: string[];
let payloads: unknown[];
beforeEach(async () => {
	paths = [];
	payloads = [];
	f.disabled = false;
	f.secret.mockReset().mockImplementation(async (_target, active) => {
		if (active && f.disabled) {
			throw new Error("Connection disconnected");
		}
		return secret;
	});
	server = createServer(async (request, response) => {
		const [timestamp, signature] = (
			request.headers.authorization?.slice(7) ?? ""
		).split(".");
		if (
			signature !==
			createHmac("sha256", secret)
				.update(timestamp ?? "")
				.digest("hex")
		) {
			response.writeHead(401);
			response.end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(Buffer.from(chunk));
		}
		if (chunks.length) {
			payloads.push(JSON.parse(Buffer.concat(chunks).toString()));
		}
		paths.push(request.url ?? "");
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify(
				request.url === "/sessions/readiness"
					? {
							protocolVersion: 2,
							profileId: "example-profile",
							ready: true,
							capabilities: {
								durableReceipts: true,
								wholeRunCancellation: true,
							},
						}
					: request.url?.endsWith("/messages")
						? {
								messages: [
									{
										id: "example-message",
										role: "assistant",
										content: "Actual remote response",
									},
								],
								webPath:
									"/?ws=example&route=allSessions%2Fsession%2Fexample-session",
							}
						: request.url?.endsWith("/stop")
							? { confirmed: true }
							: request.url?.endsWith("/prompt")
								? { messageId: "example-receipt" }
								: { sessionId: "example-session" },
			),
		);
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Missing listener");
	}
	url = `http://127.0.0.1:${address.port}`;
	vi.stubEnv("BACKGROUND_AGENTS_URL", "http://127.0.0.1:1");
	vi.stubEnv("FABRIC_AGENTS_DEFAULT_CONNECTION", "wrong-global-connection");
	vi.stubEnv("FABRIC_AGENTS_DEFAULT_MODEL", "wrong-global-model");
	vi.stubEnv(
		"BACKGROUND_AGENTS_INTERNAL_SECRET",
		"example-wrong-global-service-secret",
	);
});
afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	vi.unstubAllEnvs();
});
function adapter() {
	return new FabricBackgroundAdapter({
		url,
		profileId: "example-profile",
		connectionId: "example-connection",
		projectId: "example-project",
		organizationId: "example-org",
		userId: "example-user",
	});
}
it("uses the selected connection and secret instead of the global server for the whole lifecycle", async () => {
	vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
	const { getCodingExecutionProvider } = await import(
		"../src/lib/coding-execution/registry"
	);
	const provider = getCodingExecutionProvider("BACKGROUND_AGENTS", {
		executionRuntime: "fabric-agent-server",
		executionTarget: {
			url,
			profileId: "example-profile",
			connectionId: "example-connection",
			projectId: "example-project",
			organizationId: "example-org",
			userId: "example-user",
		},
	});
	const result = await provider.createSession({
		repoOwner: "example-org",
		repoName: "example-repo",
		organizationId: "example-org",
	});
	expect(result.providerMetadata?.executionTarget).toMatchObject({
		url,
		connectionId: "example-connection",
		organizationId: "example-org",
	});
	expect(JSON.stringify(result)).not.toContain(secret);
	expect(
		await provider.sendPrompt(
			"example-session",
			"Example instruction",
			"example-user",
			{ promptId: "example-prompt" },
		),
	).toEqual({ messageId: "example-receipt" });
	const conversation = await provider.getSessionMessages?.("example-session");
	if (!conversation) {
		throw new Error("Missing registered-server conversation capability");
	}
	expect(conversation.messages[0].content).toBe("Actual remote response");
	expect(
		new URL(conversation.webUrl ?? "https://missing.example.com").origin,
	).toBe(url);
	await provider.cancelSession("example-session");
	expect(paths).toContain("/sessions/example-session/stop");
	expect(JSON.stringify(payloads)).not.toContain("wrong-global");
});
it("prevents new prompts after disconnect while allowing confirmed cleanup", async () => {
	f.disabled = true;
	await expect(
		adapter().sendPrompt(
			"example-session",
			"Example instruction",
			"example-user",
			{ promptId: "example-prompt" },
		),
	).rejects.toThrow("disconnected");
	expect(paths).not.toContain("/sessions/example-session/prompt");
	await expect(
		adapter().cancelSession("example-session"),
	).resolves.toBeUndefined();
});
