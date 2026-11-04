import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({
	access: vi.fn(),
	deleted: vi.fn(),
	read: vi.fn(),
	legacy: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getProjectAccessContext: m.access,
	isProjectSoftDeleted: m.deleted,
	listProjectContextSummaries: m.legacy,
}));
vi.mock(
	"@repo/api/modules/projects/lib/context-manifest-reader",
	async (original) => ({
		...(await original<Record<string, unknown>>()),
		readContextManifest: m.read,
	}),
);
vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi.fn(async () => ({
		availability: "UPLOAD",
		readState: "DIRECT",
	})),
}));

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../platform-tools";

const session: GatewaySession = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	userName: "Example",
	email: "dev@example.com",
	role: "user",
	credential: "organization-key",
	scopes: ["projects:read"],
	createdAt: new Date(),
	expiresAt: new Date(Date.now() + 60000),
};
const args = {
	projectId: "example-project",
	format: "manifest",
	limit: 5,
	offset: 10,
	includeCodeContexts: false,
};
function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}
beforeEach(() => {
	vi.resetAllMocks();
	m.access.mockResolvedValue({ organizationId: session.organizationId });
	m.deleted.mockResolvedValue(false);
	m.read.mockResolvedValue({
		version: 1,
		sources: [],
		omissions: { sourceBodies: true, workspaceDocuments: "separate_scope" },
	});
});
describe("existing MCP context list manifest format", () => {
	it("advertises one optional format on the existing tool and forwards its authenticated host", async () => {
		const definition = PLATFORM_TOOL_DEFINITIONS.find(
			(tool) => tool.name === "fabric_list_project_contexts",
		);
		expect(definition?.inputSchema).toMatchObject({
			properties: { format: { enum: ["summary", "manifest"] } },
		});
		const result = await executePlatformTool(
			"fabric_list_project_contexts",
			args,
			session,
		);
		expect(result.isError).not.toBe(true);
		expect(payload(result)).toMatchObject({
			version: 1,
			omissions: { sourceBodies: true },
		});
		expect(m.read).toHaveBeenCalledWith(
			{
				userId: session.userId,
				organizationId: session.organizationId,
				projectId: args.projectId,
			},
			{
				limit: 5,
				offset: 10,
				includeCodeContexts: false,
				type: undefined,
			},
		);
		expect(m.legacy).not.toHaveBeenCalled();
	});
	it("refuses a cross-organization key before metadata", async () => {
		m.access.mockResolvedValue({ organizationId: "other-org" });
		const result = await executePlatformTool(
			"fabric_list_project_contexts",
			args,
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).code).toBe("NOT_FOUND");
		expect(m.read).not.toHaveBeenCalled();
	});
	it("uses the project's host for a currently authorized personal-key guest", async () => {
		m.access.mockResolvedValue({ organizationId: "host-org" });
		await executePlatformTool("fabric_list_project_contexts", args, {
			...session,
			credential: "personal-key",
		});
		expect(m.read).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "host-org" }),
			expect.anything(),
		);
	});
	it("requires declared scope and enforces a bound project before discovery", async () => {
		expect(
			(
				await executePlatformTool(
					"fabric_list_project_contexts",
					args,
					{ ...session, scopes: [] },
				)
			).isError,
		).toBe(true);
		expect(
			(
				await executePlatformTool(
					"fabric_list_project_contexts",
					args,
					{ ...session, projectId: "other-project" },
				)
			).isError,
		).toBe(true);
		expect(m.read).not.toHaveBeenCalled();
	});
	it("preserves the shared current-role refusal rather than returning empty success", async () => {
		const { ContextManifestError } = await import(
			"@repo/api/modules/projects/lib/context-manifest-reader"
		);
		m.read.mockRejectedValue(new ContextManifestError("FORBIDDEN"));
		const result = await executePlatformTool(
			"fabric_list_project_contexts",
			args,
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).code).toBe("FORBIDDEN");
	});
	it("keeps the established summary response unchanged unless manifest is requested", async () => {
		m.legacy.mockResolvedValue({
			contexts: [],
			total: 0,
			hasMore: false,
			excludedCodeContexts: 0,
		});
		const result = await executePlatformTool(
			"fabric_list_project_contexts",
			{ projectId: args.projectId },
			session,
		);
		expect(payload(result)).toMatchObject({ contexts: [], total: 0 });
		expect(m.read).not.toHaveBeenCalled();
		expect(m.legacy).toHaveBeenCalledTimes(1);
	});
});
