import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let server: Server;
let received: Record<string, unknown>[];
let status: number;
let response: unknown;

beforeEach(async () => {
	received = [];
	status = 202;
	response = { ok: true, messageId: "native-message-1" };
	server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(Buffer.from(chunk));
		}
		received.push(JSON.parse(Buffer.concat(chunks).toString()));
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(response));
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
	vi.resetModules();
});
afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	vi.unstubAllEnvs();
});

describe("Fabric bridge durable prompt contract", () => {
	it("sends the stable prompt identity and returns the native persisted message identity", async () => {
		const { FabricBackgroundAdapter } = await import(
			"../src/lib/coding-execution/background-agents-provider"
		);
		const adapter = new FabricBackgroundAdapter();
		const receipt = await adapter.sendPrompt(
			"session-1",
			"Continue",
			"example-user",
			{ promptId: "attempt-1" },
		);
		expect(received[0]).toMatchObject({
			content: "Continue",
			promptId: "attempt-1",
		});
		expect(receipt).toEqual({ messageId: "native-message-1" });
	});
	it.each([409, 503])(
		"exposes recovery_required at HTTP %s as a typed recovery outcome",
		async (code) => {
			status = code;
			response = {
				code: "recovery_required",
				error: "Uncertain prior mutation",
			};
			const { FabricBackgroundAdapter } = await import(
				"../src/lib/coding-execution/background-agents-provider"
			);
			await expect(
				new FabricBackgroundAdapter().sendPrompt(
					"session-1",
					"Continue",
					"example-user",
					{ promptId: "attempt-1" },
				),
			).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
		},
	);
	it("preserves a real native checkpoint as input_required", async () => {
		status = 409;
		response = { code: "input_required" };
		const { FabricBackgroundAdapter } = await import(
			"../src/lib/coding-execution/background-agents-provider"
		);
		await expect(
			new FabricBackgroundAdapter().sendPrompt(
				"session-1",
				"yes",
				"example-user",
				{ promptId: "attempt-1" },
			),
		).rejects.toMatchObject({ code: "INPUT_REQUIRED" });
	});
	it.each([{ ok: true }, null, 42, { messageId: "" }])(
		"does not call malformed 202 payload %j a durable receipt",
		async (payload) => {
			response = payload;
			const { FabricBackgroundAdapter } = await import(
				"../src/lib/coding-execution/background-agents-provider"
			);
			await expect(
				new FabricBackgroundAdapter().sendPrompt(
					"session-1",
					"Continue",
					"example-user",
					{ promptId: "attempt-1" },
				),
			).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
		},
	);
});

it("does not offer branch-only spike execution before live replacement-runtime qualification", async () => {
	const { FABRIC_BACKGROUND_CAPABILITIES } = await import(
		"../src/lib/coding-execution/background-agents-provider"
	);
	expect(FABRIC_BACKGROUND_CAPABILITIES.pushBranchWithoutPr).toBe(false);
});
