import { afterEach, expect, it, vi } from "vitest";
import { patternGraph } from "../src/pattern/agent.js";

const { sendMessageSecure, getAgentModelAsync } = vi.hoisted(() => ({
	sendMessageSecure: vi.fn(),
	getAgentModelAsync: vi.fn(),
}));

vi.mock("@repo/agent-core", () => ({
	SecureA2AClient: class {
		sendMessageSecure = sendMessageSecure;
	},
	getAgentModelAsync,
	logAgentUsageFromRunnableConfig: vi.fn(),
}));
vi.mock("@repo/database/prisma/client", () => ({ db: {} }));
vi.mock("@repo/rag", () => ({
	retrieveProjectContexts: vi.fn(async () => []),
}));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

it("opts both research reader calls into service authentication without using plain fetch", async () => {
	vi.stubEnv("WEAVE_READERS_URL", "https://readers.example.com");
	const plainFetch = vi.fn(async () =>
		Response.json({ response: "Fallback answer" }),
	);
	vi.stubGlobal("fetch", plainFetch);
	sendMessageSecure.mockResolvedValue({
		messages: [{ role: "agent", parts: [{ text: "Example research" }] }],
	});
	const tenantContext = {
		userId: "example-user",
		organizationId: "example-org",
	};

	// Exercise the exported graph through research, stopping before model calls.
	const result = await patternGraph.invoke(
		{
			messages: [],
			projectContext: {
				projectId: "example-project",
				projectName: "Example project",
			},
			tenantContext,
		},
		{ interruptAfter: ["researchNode"] },
	);

	expect(sendMessageSecure).toHaveBeenCalledTimes(2);
	for (const call of sendMessageSecure.mock.calls) {
		expect(call).toEqual([
			"https://readers.example.com",
			expect.objectContaining({ role: "user" }),
			tenantContext,
			expect.objectContaining({ trustedDestination: true }),
		]);
	}
	expect(result.research).toContain("## External research\nExample research");
	expect(result.research).toContain(
		"## Codebase grounding\nExample research",
	);
	expect(plainFetch).not.toHaveBeenCalled();
	expect(getAgentModelAsync).not.toHaveBeenCalled();
});
