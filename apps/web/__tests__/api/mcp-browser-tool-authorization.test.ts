import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserToolScope } from "../../modules/saas/mcp/lib/gateway/browser-tool-scope";

vi.mock("@fabricorg/mcp-server", () => ({ UpstashSessionStore: vi.fn() }));
const verifyUserApiKey = vi.fn();
vi.mock("@repo/api/modules/users/procedures/api-keys", () => ({
	verifyUserApiKey: (key: string) => verifyUserApiKey(key),
}));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));

const workflowStart = vi.fn();
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: workflowStart } }),
}));

const keyFindFirst = vi.fn();
const templateFindFirst = vi.fn();
const templateFindMany = vi.fn();
const canExecuteOrganizationAgents = vi.fn();
const canCreateOrganizationContext = vi.fn();
const canManageOrganizationReportTemplates = vi.fn();
const canReadOrganizationReportTemplates = vi.fn();
vi.mock("@repo/database", () => ({
	isOrganizationLive: async () => true,
	isOrganizationMember: async () => true,
	resolveUserOrganization: async () => ({
		kind: "resolved",
		organizationId: "example-org",
	}),
	recordOrganizationCliReach: async () => ({
		firstReachForOrganization: false,
	}),
	canExecuteOrganizationAgents: (...args: unknown[]) =>
		canExecuteOrganizationAgents(...args),
	canCreateOrganizationContext: (...args: unknown[]) =>
		canCreateOrganizationContext(...args),
	canManageOrganizationReportTemplates: (...args: unknown[]) =>
		canManageOrganizationReportTemplates(...args),
	canReadOrganizationReportTemplates: (...args: unknown[]) =>
		canReadOrganizationReportTemplates(...args),
	db: {
		organizationApiKey: {
			findFirst: (args: unknown) => keyFindFirst(args),
			update: vi.fn().mockResolvedValue({}),
		},
		user: {
			findUnique: async () => ({
				name: "Example User",
				email: "dev@example.com",
				role: "user",
			}),
		},
		automationTemplate: {
			findFirst: (args: unknown) => templateFindFirst(args),
			findMany: (args: unknown) => templateFindMany(args),
		},
	},
}));
vi.mock("@repo/api/lib/audit", () => ({ recordAuditFromRequest: vi.fn() }));

const toolArgs: Record<string, Record<string, unknown>> = {
	run_browser_task: { url: "https://example.com" },
	run_hybrid_task: { mode: "api-only", steps: [] },
	extract_web_content: { urls: ["https://example.com"] },
	execute_template: { templateId: "template-1", parameters: {} },
	list_templates: {},
};

function requestBody(
	id: number,
	method: string,
	params: Record<string, unknown>,
) {
	return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function call(
	method: string,
	params: Record<string, unknown>,
	scopes: string[],
	keyKind: "organization" | "personal" = "organization",
) {
	keyFindFirst.mockResolvedValue(
		keyKind === "organization"
			? {
					id: "key-1",
					organizationId: "example-org",
					createdByUserId: "user-1",
					scopes,
				}
			: null,
	);
	verifyUserApiKey.mockResolvedValue({
		valid: true,
		userId: "user-1",
		keyId: "personal-key-1",
		scopes,
	});
	const { POST } = await import("../../app/mcp/route");
	const headers = {
		host: "localhost:3001",
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		authorization:
			keyKind === "organization"
				? "Bearer org_example_key"
				: "Bearer fab_example_key",
	};
	const init = await POST(
		new Request("http://localhost:3001/mcp", {
			method: "POST",
			headers,
			body: requestBody(1, "initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "test-client", version: "1.0.0" },
			}),
		}) as never,
	);
	const sessionId = init.headers.get("mcp-session-id");
	expect(sessionId).toBeTruthy();
	const response = await POST(
		new Request("http://localhost:3001/mcp", {
			method: "POST",
			headers: { ...headers, "mcp-session-id": sessionId as string },
			body: requestBody(2, method, params),
		}) as never,
	);
	const body = await response.text();
	const data = body.split("\n").find((line) => line.startsWith("data:"));
	return JSON.parse(data?.slice(5).trim() ?? "{}");
}

async function callTool(
	name: string,
	scopes: string[],
	keyKind: "organization" | "personal" = "organization",
) {
	return call(
		"tools/call",
		{ name, arguments: toolArgs[name] ?? {} },
		scopes,
		keyKind,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
	vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
	workflowStart.mockResolvedValue({ result: async () => ({ ok: true }) });
	templateFindFirst.mockResolvedValue({
		id: "template-1",
		organizationId: "example-org",
	});
	templateFindMany.mockResolvedValue([]);
	canExecuteOrganizationAgents.mockResolvedValue(true);
	canCreateOrganizationContext.mockResolvedValue(true);
	canManageOrganizationReportTemplates.mockResolvedValue(true);
	canReadOrganizationReportTemplates.mockResolvedValue(true);
});

describe("hosted browser tools", () => {
	it("refuses a browser dispatch name missing from the scope allowlist", () => {
		expect(browserToolScope("unknown_browser_tool")).toBeUndefined();
		expect(browserToolScope("toString")).toBeUndefined();
	});

	it("refuses an unknown tool call", async () => {
		const result = await callTool("unknown_browser_tool", ["*"]);
		expect(JSON.stringify(result)).toMatch(
			/Tool unknown_browser_tool not found/,
		);
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("refuses a dispatched browser tool when its scope table entry is missing", async () => {
		const { BROWSER_TOOL_SCOPES } = await import(
			"../../modules/saas/mcp/lib/gateway/browser-tool-scope"
		);
		const required = BROWSER_TOOL_SCOPES.run_browser_task;
		delete BROWSER_TOOL_SCOPES.run_browser_task;
		try {
			const result = await callTool("run_browser_task", ["*"]);
			expect(JSON.stringify(result)).toContain(
				"Unknown tool: run_browser_task",
			);
			expect(workflowStart).not.toHaveBeenCalled();
		} finally {
			BROWSER_TOOL_SCOPES.run_browser_task = required;
		}
	});

	it.each([
		"run_browser_task",
		"run_hybrid_task",
		"extract_web_content",
		"execute_template",
	])(
		"refuses %s without browser:write before a workflow starts",
		async (name) => {
			const result = await callTool(name, ["orgs:read"]);
			expect(JSON.stringify(result)).toContain("browser:write");
			expect(workflowStart).not.toHaveBeenCalled();
		},
	);

	it("refuses list_templates without browser:read", async () => {
		const result = await callTool("list_templates", ["orgs:read"]);
		expect(JSON.stringify(result)).toContain("browser:read");
		expect(templateFindMany).not.toHaveBeenCalled();
	});

	it("refuses a personal key without browser:write", async () => {
		const result = await callTool(
			"run_browser_task",
			["orgs:read"],
			"personal",
		);
		expect(JSON.stringify(result)).toContain("browser:write");
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("honors the shared MCP umbrella scopes", async () => {
		const run = await callTool("run_browser_task", ["mcp:write"]);
		expect(JSON.stringify(run)).toContain("ok");
		const list = await callTool("list_templates", ["mcp:read"]);
		expect(JSON.stringify(list)).toContain("templates");
	});

	it("refuses a wildcard key when its viewer creator lacks template management", async () => {
		canManageOrganizationReportTemplates.mockResolvedValue(false);
		const result = await callTool("execute_template", ["*"]);
		expect(JSON.stringify(result)).toMatch(/permission/i);
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("refuses a wildcard personal key when its creator lacks template management", async () => {
		canManageOrganizationReportTemplates.mockResolvedValue(false);
		const result = await callTool("execute_template", ["*"], "personal");
		expect(JSON.stringify(result)).toMatch(/permission/i);
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("fails closed when the live permission cannot be read", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		canManageOrganizationReportTemplates.mockRejectedValue(
			new Error("lookup failed"),
		);
		try {
			const result = await callTool("execute_template", ["*"]);
			expect(JSON.stringify(result)).toContain(
				"Could not verify your organization permission; try again.",
			);
			expect(workflowStart).not.toHaveBeenCalled();
			expect(log).toHaveBeenCalledWith(
				"[MCP Gateway] Browser tool permission check failed:",
				expect.objectContaining({
					toolName: "execute_template",
					error: "lookup failed",
				}),
			);
		} finally {
			log.mockRestore();
		}
	});

	it.each([
		["run_browser_task", canExecuteOrganizationAgents],
		["run_hybrid_task", canExecuteOrganizationAgents],
		["extract_web_content", canCreateOrganizationContext],
	])(
		"refuses %s when the creator loses the live permission",
		async (name, permission) => {
			permission.mockResolvedValue(false);
			const result = await callTool(name, ["*"]);
			expect(JSON.stringify(result)).toMatch(/permission/i);
			expect(workflowStart).not.toHaveBeenCalled();
		},
	);

	it("refuses list_templates when the creator loses read permission", async () => {
		canReadOrganizationReportTemplates.mockResolvedValue(false);
		const result = await callTool("list_templates", ["*"]);
		expect(JSON.stringify(result)).toMatch(/permission/i);
		expect(templateFindMany).not.toHaveBeenCalled();
	});

	it("refuses execute_template without workflows:run even with browser:write", async () => {
		const result = await callTool("execute_template", ["browser:write"]);
		expect(JSON.stringify(result)).toContain("workflows:run");
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("refuses list_templates without workflows:read even with browser:read", async () => {
		const result = await callTool("list_templates", ["browser:read"]);
		expect(JSON.stringify(result)).toContain("workflows:read");
		expect(templateFindMany).not.toHaveBeenCalled();
	});

	it("allows an authorized admin to execute a template", async () => {
		const result = await callTool("execute_template", [
			"browser:write",
			"workflows:run",
		]);
		expect(JSON.stringify(result)).toContain("ok");
		expect(canManageOrganizationReportTemplates).toHaveBeenCalledWith(
			"user-1",
			"example-org",
		);
		expect(workflowStart).toHaveBeenCalledTimes(1);
	});

	it("lists only organization templates, including a public one in that organization", async () => {
		const fixtures = [
			{
				id: "same-org-public",
				organizationId: "example-org",
				isPublic: true,
			},
			{
				id: "other-org-public",
				organizationId: "other-org",
				isPublic: true,
			},
			{ id: "personal", organizationId: null, userId: "user-1" },
		];
		templateFindMany.mockImplementation(
			async ({ where }: { where: { organizationId: string } }) =>
				fixtures.filter(
					(template) =>
						template.organizationId === where.organizationId,
				),
		);
		const result = await callTool("list_templates", [
			"browser:read",
			"workflows:read",
		]);
		expect(JSON.stringify(result)).toContain("same-org-public");
		expect(JSON.stringify(result)).not.toContain("other-org-public");
		expect(JSON.stringify(result)).not.toContain("personal");
		expect(templateFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organizationId: "example-org" },
			}),
		);
	});

	it("refuses a template outside the caller's organization", async () => {
		const otherPublicTemplate = {
			id: "template-1",
			organizationId: "other-org",
			isPublic: true,
		};
		templateFindFirst.mockImplementation(
			async ({
				where,
			}: {
				where: { id: string; organizationId: string };
			}) =>
				where.id === otherPublicTemplate.id &&
				where.organizationId === otherPublicTemplate.organizationId
					? otherPublicTemplate
					: null,
		);
		const result = await callTool("execute_template", [
			"browser:write",
			"workflows:run",
		]);
		expect(JSON.stringify(result)).toMatch(/not found/i);
		expect(templateFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "template-1", organizationId: "example-org" },
			}),
		);
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("refuses execution if the scoped template lookup fails", async () => {
		templateFindFirst.mockRejectedValue(new Error("lookup failed"));
		const result = await callTool("execute_template", [
			"browser:write",
			"workflows:run",
		]);
		expect(JSON.stringify(result)).toContain("lookup failed");
		expect(workflowStart).not.toHaveBeenCalled();
	});
});
