import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildContext, buildInput } from "./integration-handler-fixtures";

const h = vi.hoisted(() => ({
	credentials: vi.fn(),
	authority: vi.fn(async () => ({ authorized: true })),
	readOnly: vi.fn(async () => null),
	fetch: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	fetchCredentialsByIdAndProviderInTenant: h.credentials,
	fetchCredentialsByProvider: h.credentials,
}));
vi.mock("../../authority-gate", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	checkIntegrationAuthority: h.authority,
}));
vi.mock("../../../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: h.readOnly,
}));
vi.mock("../../../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));
const { IntegrationHandler, getSupportedIntegrationOperations } = await import(
	"../integration-handler"
);
const { classifyIntegrationAccessLevel } = await import("../../authority-gate");
const inputs = {
	channel: "example-channel",
	message: "Example message",
	to: "dev@example.com",
	subject: "Example",
	url: "https://example.com",
	query: "Example",
	repo: "example/repo",
	title: "Example",
	project_id: "example-project",
	teamId: "example-team",
	body: "Example",
};
const credentials = {
	SLACK_TOKEN: "xoxb-example",
	RESEND_API_KEY: "example",
	PERPLEXITY_API_KEY: "example",
	FIRECRAWL_API_KEY: "example",
};
beforeEach(() => {
	vi.clearAllMocks();
	h.credentials.mockResolvedValue(credentials);
	h.authority.mockResolvedValue({ authorized: true });
	h.readOnly.mockResolvedValue(null);
	h.fetch.mockResolvedValue({
		ok: true,
		json: async () => ({ ok: true, ts: "1" }),
		text: async () => "ok",
	});
	vi.stubGlobal("fetch", h.fetch);
});

describe("legacy operation allowlist", () => {
	it.each([
		"SLACK",
		"GITHUB",
		"GITLAB",
		"LINEAR",
		"RESEND",
		"PERPLEXITY",
		"FIRECRAWL",
		"CUSTOM_WEBHOOK",
		"MICROSOFT_GRAPH",
	])("rejects %s before either gate", async (provider) => {
		const result = await new IntegrationHandler().execute(
			buildContext(
				buildInput(provider, {
					inputs: { ...inputs, operation: "get_status" },
				}),
			),
		);
		expect(result).toMatchObject({ handled: false, shouldFallback: false });
		expect(result.error).toContain("get_status");
		expect(result.error).toContain(provider);
		expect(result.error).toContain("Supported:");
		expect(h.authority).not.toHaveBeenCalled();
		expect(h.readOnly).not.toHaveBeenCalled();
		expect(h.fetch).not.toHaveBeenCalled();
	});

	it("falls back to MCP tools when the integration was not explicitly matched", async () => {
		const input = buildInput("SLACK", {
			inputs: { ...inputs, operation: "search_messages" },
		});
		for (const match of input.matchedIntegrations ?? []) {
			match.confidence = 0.3;
		}
		const result = await new IntegrationHandler().execute(
			buildContext(input),
		);
		expect(result).toMatchObject({ handled: false, shouldFallback: true });
		expect(result.error).toContain("search_messages");
		expect(h.authority).not.toHaveBeenCalled();
		expect(h.fetch).not.toHaveBeenCalled();
	});

	it.each([
		["executeSlack", "Slack"],
		["executeResend", "Resend"],
		["executeWebhook", "Webhook"],
		["executePerplexity", "Perplexity"],
		["executeFirecrawl", "Firecrawl"],
	])("%s rejects unknown names at dispatch", async (method, provider) => {
		const context = buildContext(buildInput("SLACK", { inputs }));
		// Exercise the private executor boundary independently of the step gate.
		const executor = new IntegrationHandler() as unknown as Record<
			string,
			(...args: unknown[]) => Promise<unknown>
		>;
		expect(
			await executor[method](
				"get_status",
				credentials,
				inputs,
				context,
				context.input.step,
			),
		).toEqual({
			success: false,
			error: `Unsupported ${provider} operation: get_status`,
		});
		expect(h.fetch).not.toHaveBeenCalled();
	});

	it.each([
		["SLACK", ["send_message", "post_notification", "send_dm"]],
		["GITHUB", ["create_issue", "create_pr", "create_comment"]],
		["GITLAB", ["create_issue", "create_merge_request"]],
		["LINEAR", ["create_issue", "update_issue"]],
		["RESEND", ["send_email"]],
		["CUSTOM_WEBHOOK", ["call_webhook"]],
		["MICROSOFT_GRAPH", ["send_email", "create_calendar_event"]],
	])("%s listed writes require WRITE", (provider, operations) => {
		for (const operation of operations) {
			expect(getSupportedIntegrationOperations(provider)).toContain(
				operation,
			);
			expect(classifyIntegrationAccessLevel(operation, provider)).toBe(
				"WRITE",
			);
		}
	});

	it("posts a listed Slack write after authority approval", async () => {
		const result = await new IntegrationHandler().execute(
			buildContext(
				buildInput("SLACK", {
					inputs: { ...inputs, operation: "send_message" },
				}),
			),
		);
		expect(result.handled).toBe(true);
		expect(h.authority).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "SLACK",
				operation: "send_message",
			}),
		);
		expect(h.fetch).toHaveBeenCalledWith(
			"https://slack.com/api/chat.postMessage",
			expect.objectContaining({ method: "POST" }),
		);
		expect(h.authority.mock.invocationCallOrder[0]).toBeLessThan(
			h.fetch.mock.invocationCallOrder[0],
		);
	});
});
