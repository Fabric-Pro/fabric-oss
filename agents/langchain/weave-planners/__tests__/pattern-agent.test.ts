import { retrieveProjectContexts } from "@repo/rag";
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
vi.mock("@repo/rag", async () => ({
	...(await import("@repo/rag/lib/project-contexts/retrieval")),
	contextMetaHeader: () => "",
	retrieveProjectContexts: vi.fn(async () => [
		{
			id: "example-source",
			type: "TEXT",
			score: 1,
			content: "WHOLE_BODY".repeat(10000),
			matchedPassages: [
				{ content: "MATCHED_PASSAGE", score: 1 },
				{ content: "x".repeat(30000), score: 0.5 },
			],
			sourcePath: "docs/plan.md",
			metadata: { filename: "wrong" },
		},
		{ id: "example-two", type: "TEXT", score: 1, content: "unnamed body" },
	]),
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
	expect(retrieveProjectContexts).toHaveBeenCalledWith(
		expect.objectContaining({ includeMatchedPassages: true }),
	);
	expect(result.research).not.toContain("WHOLE_BODY");
	expect(result.research).toContain("MATCHED_PASSAGE");
	expect(
		result.research.match(
			/<project_context>[\s\S]*?<\/project_context>/,
		)?.[0].length,
	).toBeLessThanOrEqual(20000);
	expect(result.research).toContain("### From: docs/plan.md");
	expect(result.research).toContain("### From: Context 2");
	expect(plainFetch).not.toHaveBeenCalled();
	expect(getAgentModelAsync).not.toHaveBeenCalled();
});

it("cancels reader delegation without starting fallback research or model calls", async () => {
	const controller = new AbortController();
	let received: AbortSignal | undefined;
	sendMessageSecure.mockImplementation(
		async (_url, _message, _tenant, options) => {
			received = options.signal;
			controller.abort();
			throw new Error("503 request aborted");
		},
	);
	const plainFetch = vi.fn(async () => Response.json({ response: "unused" }));
	vi.stubGlobal("fetch", plainFetch);
	await expect(
		patternGraph.invoke(
			{
				messages: [],
				projectContext: {
					projectId: "example-project",
					projectName: "Example",
				},
				tenantContext: {
					userId: "example-user",
					organizationId: "example-org",
				},
			},
			{ signal: controller.signal },
		),
	).rejects.toBeDefined();
	expect(received?.aborted).toBe(true);
	expect(sendMessageSecure).toHaveBeenCalledTimes(1);
	expect(plainFetch).not.toHaveBeenCalled();
	expect(getAgentModelAsync).not.toHaveBeenCalled();
});

it.each([true, false])(
	"searches planner inputs in order (optional=%s)",
	async (optional) => {
		sendMessageSecure.mockResolvedValue({ messages: [] });
		await patternGraph.invoke(
			{
				messages: [{ role: "user", content: "Request" }],
				projectContext: {
					projectId: "example-project",
					projectName: "Example",
					...(optional ? { techStack: "TypeScript" } : {}),
				},
				tenantContext: {
					userId: "example-user",
					organizationId: "example-org",
				},
			},
			{ interruptAfter: ["researchNode"] },
		);
		expect(retrieveProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({
				query: optional ? "Request TypeScript" : "Request",
			}),
		);
	},
);
