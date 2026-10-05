/**
 * A gateway session bound to ONE project: what its tools may name and reach.
 *
 * A session opened at a project's URL has the project's platform tools and
 * nothing else, and every one of them acts on that project. Two routes lead
 * out of it and both are closed here: a tool that takes a project id, which is
 * defaulted and refused for any other, and a tool that takes a feature, a
 * document or a context id, which resolves the project from the row and asks
 * the project-access helpers about it. The session is handed to the real
 * `executePlatformTool`; only the database is stood in for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getProjectAccessContext: vi.fn(),
	getProjectSummaryById: vi.fn(),
	getPublishedInstructionSummariesForProjects: vi.fn(),
	getStoryById: vi.fn(),
	getDocumentById: vi.fn(),
	getContextById: vi.fn(),
	listProjects: vi.fn(),
	resolveProjectAccess: vi.fn(),
	updateDocument: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectAccessContext: mocks.getProjectAccessContext,
	getProjectSummaryById: mocks.getProjectSummaryById,
	getPublishedInstructionSummariesForProjects:
		mocks.getPublishedInstructionSummariesForProjects,
	getStoryById: mocks.getStoryById,
	getDocumentById: mocks.getDocumentById,
	getContextById: mocks.getContextById,
	listProjects: mocks.listProjects,
	resolveProjectAccess: mocks.resolveProjectAccess,
	updateDocument: mocks.updateDocument,
	// Destructured by the handlers before they authorize, so the strict mock
	// has to carry them even though no case here reaches a write.
	DocumentVersionConflictError: class extends Error {},
	IntegrationContractStatusManagedError: class extends Error {},
	readProjectContextBodyPage: vi.fn(),
	hasPermission: () => true,
	Permissions: {
		PROJECT_UPDATE: "project:update",
		STORY_UPDATE: "story:update",
		CONTEXT_CREATE: "context:create",
		CONTEXT_UPDATE: "context:update",
	},
}));

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../platform-tools";
import {
	PROJECT_BOUND_HIDDEN_TOOL_NAMES,
	PROJECT_BOUND_TOOL_NAMES,
	projectBoundTools,
} from "../project-binding";
import type { GatewaySession } from "../types";

const ORG = "org-example-alpha";
const BOUND = "project-example-one";
const OTHER = "project-example-two";

function session(overrides: Partial<GatewaySession> = {}): GatewaySession {
	return {
		sessionId: "session-1",
		userId: "user-1",
		organizationId: ORG,
		projectId: BOUND,
		userName: "Dev",
		email: "dev@example.com",
		role: "user",
		credential: "oauth",
		scopes: ["mcp:read", "instructions:read", "instructions:write"],
		createdAt: new Date("2026-10-04T12:00:00Z"),
		expiresAt: new Date("2026-10-05T12:00:00Z"),
		...overrides,
	};
}

const organizationWide = () => session({ projectId: null });

function text(result: { content: Array<{ text: string }> }): string {
	return result.content.map((part) => part.text).join("\n");
}

const PROJECT_SUMMARY = {
	id: BOUND,
	name: "Example Project",
	description: null,
	status: "ACTIVE",
	heroEmojis: [],
	createdAt: new Date("2026-09-01T00:00:00Z"),
	updatedAt: new Date("2026-09-02T00:00:00Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getProjectAccessContext.mockResolvedValue({ organizationId: ORG });
	mocks.getProjectSummaryById.mockResolvedValue(PROJECT_SUMMARY);
	mocks.getPublishedInstructionSummariesForProjects.mockResolvedValue(
		new Map(),
	);
	mocks.getStoryById.mockResolvedValue(null);
	mocks.listProjects.mockResolvedValue({
		projects: [],
		total: 0,
		hasMore: false,
	});
	mocks.resolveProjectAccess.mockResolvedValue({
		isVisible: true,
		source: "owner",
		permissions: [],
		organizationId: ORG,
	});
});

describe("the tools a project-bound session has", () => {
	it("are offered with projectId optional, and with a note that it defaults", () => {
		const offered = projectBoundTools(PLATFORM_TOOL_DEFINITIONS);

		expect(offered.map((tool) => tool.name).sort()).toEqual(
			[...PROJECT_BOUND_TOOL_NAMES].sort(),
		);
		for (const tool of offered) {
			const required = tool.inputSchema.required;
			expect(
				Array.isArray(required) && required.includes("projectId"),
				tool.name,
			).toBe(false);
		}
		const featureTool = offered.find(
			(tool) => tool.name === "fabric_get_feature",
		);
		expect(featureTool?.inputSchema.required).toEqual(["featureId"]);
		expect(featureTool?.description).toContain(
			"projectId is optional and defaults to the connected project",
		);
	});

	it("leave every other tool out, including each one that reaches past a project", () => {
		const offered = new Set(
			projectBoundTools(PLATFORM_TOOL_DEFINITIONS).map(
				(tool) => tool.name,
			),
		);

		for (const hidden of PROJECT_BOUND_HIDDEN_TOOL_NAMES) {
			expect(offered.has(hidden), hidden).toBe(false);
		}
	});

	it("keep the schema of a tool that never required a project as it was", () => {
		const listProjects = PLATFORM_TOOL_DEFINITIONS.find(
			(tool) => tool.name === "fabric_list_projects",
		);

		expect(
			projectBoundTools(PLATFORM_TOOL_DEFINITIONS).find(
				(tool) => tool.name === "fabric_list_projects",
			),
		).toEqual(listProjects);
	});
});

describe("a tool the session does not have", () => {
	it.each([...PROJECT_BOUND_HIDDEN_TOOL_NAMES])(
		"%s is refused without touching anything",
		async (toolName) => {
			const result = await executePlatformTool(toolName, {}, session());

			expect(result.isError).toBe(true);
			expect(text(result)).toContain(
				"not available on a connection to one project",
			);
			for (const mock of Object.values(mocks)) {
				expect(mock).not.toHaveBeenCalled();
			}
		},
	);

	it("is refused whatever its scope would have said", async () => {
		const result = await executePlatformTool(
			"fabric_create_project",
			{ name: "Another" },
			session({ scopes: ["*"] }),
		);

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("not available on a connection");
	});

	it("is still available to an organization-wide session", async () => {
		const result = await executePlatformTool(
			"fabric_list_workspaces",
			{},
			organizationWide(),
		);

		expect(text(result)).not.toContain("not available on a connection");
	});
});

describe("the project a call names", () => {
	it("defaults to the bound project when the call names none", async () => {
		await executePlatformTool(
			"fabric_get_feature",
			{ featureId: "f1" },
			session(),
		);

		expect(mocks.getStoryById).toHaveBeenCalledWith("f1", BOUND);
	});

	it("is accepted when it is the bound project", async () => {
		await executePlatformTool(
			"fabric_get_feature",
			{ featureId: "f1", projectId: BOUND },
			session(),
		);

		expect(mocks.getStoryById).toHaveBeenCalledWith("f1", BOUND);
	});

	it.each([
		["another project's id", OTHER],
		["an id of the wrong type", 7],
		["an object", { id: BOUND }],
	])(
		"is refused as a project that does not exist when it is %s",
		async (_label, projectId) => {
			const result = await executePlatformTool(
				"fabric_get_feature",
				{ featureId: "f1", projectId },
				session(),
			);

			expect(result.isError).toBe(true);
			expect(text(result)).toBe(
				JSON.stringify({ error: "Project not found or access denied" }),
			);
			expect(mocks.getStoryById).not.toHaveBeenCalled();
			expect(mocks.getProjectAccessContext).not.toHaveBeenCalled();
		},
	);
});

describe("fabric_get_project and fabric_list_projects", () => {
	it("get_project reads the bound project when asked for no project", async () => {
		const result = await executePlatformTool(
			"fabric_get_project",
			{},
			session(),
		);

		expect(mocks.getProjectSummaryById).toHaveBeenCalledWith(
			"project-example-one",
			"user-1",
			ORG,
		);
		expect(JSON.parse(text(result))).toMatchObject({ id: BOUND });
	});

	it("get_project refuses another project without reading it", async () => {
		const result = await executePlatformTool(
			"fabric_get_project",
			{ projectId: OTHER },
			session(),
		);

		expect(result.isError).toBe(true);
		expect(mocks.getProjectSummaryById).not.toHaveBeenCalled();
	});

	it("list_projects lists the bound project alone and never the organization's", async () => {
		const result = await executePlatformTool(
			"fabric_list_projects",
			{},
			session(),
		);

		expect(mocks.listProjects).not.toHaveBeenCalled();
		expect(mocks.getProjectSummaryById).toHaveBeenCalledWith(
			BOUND,
			"user-1",
			ORG,
		);
		expect(JSON.parse(text(result))).toMatchObject({
			projects: [{ id: BOUND, name: "Example Project" }],
			total: 1,
			hasMore: false,
		});
	});

	it("list_projects lists nothing when the person can no longer read the project", async () => {
		mocks.getProjectSummaryById.mockResolvedValue(null);

		const result = await executePlatformTool(
			"fabric_list_projects",
			{},
			session(),
		);

		expect(JSON.parse(text(result))).toMatchObject({
			projects: [],
			total: 0,
		});
	});

	it("list_projects still lists the organization for an organization-wide session", async () => {
		await executePlatformTool(
			"fabric_list_projects",
			{},
			organizationWide(),
		);

		expect(mocks.listProjects).toHaveBeenCalledOnce();
	});
});

describe("a tool that resolves its project from a feature, a document or a context", () => {
	it("refuses a document of another project, though the person may read both", async () => {
		mocks.getDocumentById.mockResolvedValue({
			id: "d1",
			projectId: OTHER,
			type: "PRD",
			title: "Secret",
			content: "other project's body",
			status: "COMPLETE",
		});

		const result = await executePlatformTool(
			"fabric_get_document",
			{ documentId: "d1" },
			session(),
		);

		expect(result.isError).toBe(true);
		expect(text(result)).not.toContain("other project's body");
		expect(mocks.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("serves a document of the bound project", async () => {
		mocks.getDocumentById.mockResolvedValue({
			id: "d1",
			projectId: BOUND,
			type: "PRD",
			title: "Plan",
			content: "this project's body",
			status: "COMPLETE",
		});

		const result = await executePlatformTool(
			"fabric_get_document",
			{ documentId: "d1" },
			session(),
		);

		expect(result.isError).toBeUndefined();
		expect(text(result)).toContain("this project's body");
	});

	it("refuses to write a document of another project before asking what the person may do there", async () => {
		mocks.getDocumentById.mockResolvedValue({
			id: "d1",
			projectId: OTHER,
			type: "PRD",
			title: "Plan",
			content: "body",
			status: "COMPLETE",
			version: 1,
		});

		const result = await executePlatformTool(
			"fabric_update_document",
			{ documentId: "d1", content: "rewritten" },
			session({ scopes: ["*"] }),
		);

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Document not found or access denied");
		expect(mocks.resolveProjectAccess).not.toHaveBeenCalled();
		expect(mocks.updateDocument).not.toHaveBeenCalled();
	});

	it("refuses a context of another project", async () => {
		mocks.getContextById.mockResolvedValue({
			id: "c1",
			projectId: OTHER,
			type: "FILE",
			title: "Notes",
		});

		const result = await executePlatformTool(
			"fabric_get_project_context",
			{ contextId: "c1" },
			session(),
		);

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Context not found or access denied");
		expect(mocks.getProjectAccessContext).not.toHaveBeenCalled();
	});

	describe("answer a row that is missing and one the caller may not reach in the same words", () => {
		const ROW = {
			id: "row-1",
			type: "PRD",
			title: "Plan",
			content: "body",
		};

		const cases = [
			{
				tool: "fabric_get_document",
				args: { documentId: "row-1" },
				lookup: mocks.getDocumentById,
				row: { ...ROW, status: "COMPLETE", version: 1 },
				message: "Document not found or access denied",
			},
			{
				tool: "fabric_update_document",
				args: { documentId: "row-1", content: "rewritten" },
				lookup: mocks.getDocumentById,
				row: { ...ROW, status: "COMPLETE", version: 1 },
				message: "Document not found or access denied",
			},
			{
				tool: "fabric_get_project_context",
				args: { contextId: "row-1" },
				lookup: mocks.getContextById,
				row: { ...ROW, type: "FILE" },
				message: "Context not found or access denied",
			},
		] as const;

		const deniedSessions = {
			"another project's row, in a project-bound session": {
				session: () => session({ scopes: ["*"] }),
				prepare: () => undefined,
			},
			"a row of a project the person cannot see, in an organization-wide session":
				{
					session: () => session({ projectId: null, scopes: ["*"] }),
					prepare: () => {
						mocks.getProjectAccessContext.mockResolvedValue(null);
						mocks.resolveProjectAccess.mockResolvedValue({
							isVisible: false,
							source: null,
							permissions: [],
							organizationId: null,
						});
					},
				},
		};

		it.each(cases)(
			"$tool",
			async ({ tool, args, lookup, row, message }) => {
				lookup.mockResolvedValue(null);
				const missing = await executePlatformTool(
					tool,
					{ ...args },
					session({ scopes: ["*"] }),
				);

				for (const [label, denied] of Object.entries(deniedSessions)) {
					lookup.mockResolvedValue({ ...row, projectId: OTHER });
					denied.prepare();

					const result = await executePlatformTool(
						tool,
						{ ...args },
						denied.session(),
					);

					expect(result.isError, label).toBe(true);
					expect(text(result), label).toBe(text(missing));
				}
				expect(missing.isError).toBe(true);
				expect(text(missing)).toBe(JSON.stringify({ error: message }));
			},
		);
	});

	it("reaches the access helpers for the same document in an organization-wide session", async () => {
		mocks.getDocumentById.mockResolvedValue({
			id: "d1",
			projectId: OTHER,
			type: "PRD",
			title: "Plan",
			content: "body",
			status: "COMPLETE",
		});

		const result = await executePlatformTool(
			"fabric_get_document",
			{ documentId: "d1" },
			organizationWide(),
		);

		expect(result.isError).toBeUndefined();
		expect(mocks.getProjectAccessContext).toHaveBeenCalledWith(
			OTHER,
			"user-1",
		);
	});
});

describe("the key's scopes", () => {
	it("still decide what a project-bound session may write", async () => {
		const result = await executePlatformTool(
			"fabric_update_feature_status",
			{ featureId: "f1", statusId: "s1" },
			session({ scopes: ["mcp:read"] }),
		);

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("does not have the");
		expect(text(result)).toContain("features:write");
	});
});
