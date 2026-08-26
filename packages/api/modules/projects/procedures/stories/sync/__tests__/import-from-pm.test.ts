/**
 * Tests for importFromPMProcedure overwrite behavior (F-1042 / Task 2.2)
 *
 * Focus: overwrite flag interaction with existing/non-existing stories,
 * 409 CONFLICT on duplicate without overwrite, update path when overwrite
 * is true, and creation path for new stories.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mocks -----------------------------------------------------------------

const mockCreateStory = vi.fn();
const mockUpdateStory = vi.fn();

vi.mock("@repo/database", () => ({
	resolvePMConfigForUser: vi.fn(),
	createStory: (...args: unknown[]) => mockCreateStory(...args),
	updateStory: (...args: unknown[]) => mockUpdateStory(...args),
	Prisma: {
		// Mirror the real Prisma namespace's known-request error class so the
		// import path's `instanceof` + `.code` check behaves like production.
		PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
			code: string;
			clientVersion: string;
			meta?: Record<string, unknown>;
			constructor(
				message: string,
				opts: {
					code: string;
					clientVersion: string;
					meta?: Record<string, unknown>;
				},
			) {
				super(message);
				this.name = "PrismaClientKnownRequestError";
				this.code = opts.code;
				this.clientVersion = opts.clientVersion;
				this.meta = opts.meta;
			}
		},
	},
	db: {
		project: {
			findFirst: vi.fn(),
		},
		userStory: {
			findFirst: vi.fn(),
			findUnique: vi.fn(),
			update: vi.fn(),
		},
		projectStoryStatus: {
			findMany: vi.fn().mockResolvedValue([]),
		},
	},
}));

const mockGetOrganizationIdFromContext = vi.fn();

vi.mock("../../../../../../orpc/middleware/tenant-context-middleware", () => ({
	getOrganizationIdFromContext: (...args: unknown[]) =>
		mockGetOrganizationIdFromContext(...args),
}));

const mockAnalyzePMToolCapabilities = vi.fn();
const mockExecuteMcpTool = vi.fn();
const mockRecordPmSyncLog = vi.fn();
const mockSyncStoryToPM = vi.fn();

const mockParsePMItemFromGetOutput = vi.fn();

// Fizzy #1745: a faithful (not identity) stand-in for the real
// `stripAttachmentBlock` in `packages/temporal/.../gitlab-attachment-block.ts`
// — mirrors its regex exactly so the "attachment block stripping on import"
// tests below exercise real strip behavior without pulling in the heavy
// `@repo/temporal` module graph. The primitive's own correctness is covered
// by that package's `gitlab-attachment-block-contract.test.ts`; this file
// only needs to prove `import-from-pm.ts` calls it and uses its result.
const ATTACHMENT_BLOCK_OPEN = "<!-- fabric:attachments -->";
const ATTACHMENT_BLOCK_CLOSE = "<!-- /fabric:attachments -->";
const mockStripAttachmentBlock = vi.fn((description: string) => {
	if (!description) {
		return description;
	}
	const pattern = new RegExp(
		`\\n*${ATTACHMENT_BLOCK_OPEN}[\\s\\S]*?${ATTACHMENT_BLOCK_CLOSE}\\n*`,
		"g",
	);
	return description.replace(pattern, "\n\n");
});

vi.mock("@repo/temporal", () => ({
	analyzePMToolCapabilities: mockAnalyzePMToolCapabilities,
	executeMcpTool: mockExecuteMcpTool,
	parsePMItemFromGetOutput: (...args: unknown[]) =>
		mockParsePMItemFromGetOutput(...args),
	recordPmSyncLog: (...args: unknown[]) => mockRecordPmSyncLog(...args),
	// Fizzy import converts `description_html` → markdown via this. Identity is
	// fine for these tests (none exercise Fizzy HTML conversion).
	simpleHtmlToMarkdown: (html: string) => html,
	syncStoryToPM: (...args: unknown[]) => mockSyncStoryToPM(...args),
	// Fizzy #1745: strips the Fabric-owned GitLab attachment block from a
	// remote description before it's written into Fabric. A real (not
	// identity) implementation so the "attachment block stripping on
	// import" tests below can assert it actually ran — none of the OTHER
	// fixtures in this file contain the block, so this is a no-op for them.
	stripAttachmentBlock: mockStripAttachmentBlock,
}));

const mockGetProjectPMServerKey = vi.fn();
const mockIsGitLabOfficialKey = vi.fn();
const mockResolveGitLabPMSource = vi.fn();
const mockGetGitLabIssueForPM = vi.fn();

vi.mock("../gitlab-pm-adapter", () => ({
	getProjectPMServerKey: (...args: unknown[]) =>
		mockGetProjectPMServerKey(...args),
	isGitLabOfficialKey: (...args: unknown[]) =>
		mockIsGitLabOfficialKey(...args),
	resolveGitLabPMSource: (...args: unknown[]) =>
		mockResolveGitLabPMSource(...args),
	getGitLabIssueForPM: (...args: unknown[]) =>
		mockGetGitLabIssueForPM(...args),
}));

const mockClientTools = vi.fn();

vi.mock("@repo/mcp", () => ({
	getCachedMcpClientForConfig: vi.fn().mockResolvedValue({
		client: { tools: () => mockClientTools() },
		serverUrl: "https://pm.example.com",
	}),
}));

const mockIngestPulledImages = vi.fn();

vi.mock("@repo/integrations/pm/pull-image-ingest", () => ({
	ingestPulledImages: (...args: unknown[]) => mockIngestPulledImages(...args),
	buildAdoIngestOptions: () => ({ providerLabel: "Azure DevOps" }),
	resolveAdoPat: () => "PAT-xyz",
	buildFizzyIngestOptions: () => ({ providerLabel: "Fizzy" }),
	resolveFizzyApiKey: () => "FZ-KEY",
}));

vi.mock("@repo/integrations/pm/pull-image-store", () => ({
	createStoryMediaPullStore: () => ({}),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/utils", () => ({
	COMMON_URL_FIELDS: ["url", "link", "webUrl", "web_url", "html_url"],
	normalizeUrl: (raw: string | null) => raw ?? undefined,
	resolveKindFromPmType: (pmType: string | null | undefined) => {
		const n = (pmType ?? "").trim().toLowerCase();
		if (n === "bug" || n === "defect") {
			return "BUG";
		}
		return "FEATURE";
	},
	parseWorkItemTypeMapping: () => ({}),
}));

vi.mock("../../../../../../orpc/procedures", () => {
	const chain = {
		route: () => chain,
		input: () => chain,
		output: () => chain,
		use: () => chain,
		handler: (fn: unknown) => ({ handler: fn }),
	};
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: () => (handler: unknown) => handler,
		Permissions: { STORY_UPDATE: "story:update" },
	};
});

import { db, Prisma, resolvePMConfigForUser } from "@repo/database";

// ---- Fixtures --------------------------------------------------------------

const baseCtx = {
	user: { id: "user-1", name: "Import User" },
	session: { id: "session-1" },
	tenantContext: { type: "personal" as const, userId: "user-1" },
};

function defaultSetup() {
	mockGetOrganizationIdFromContext.mockReturnValue(null);
	vi.mocked(db.project.findFirst).mockResolvedValue({
		id: "proj-1",
		organizationId: null,
		projectManagementMcpServerId: "mcp-server-1",
		projectManagementMcpConfigId: "mcp-cfg-1",
		projectManagementContainerId: "container-1",
		projectManagementAdditionalContext: null,
	} as never);

	vi.mocked(resolvePMConfigForUser).mockResolvedValue({
		id: "mcp-cfg-1",
		enabled: true,
		baseUrl: null,
		mcpServer: null,
	} as never);

	mockClientTools.mockResolvedValue({
		"get-item": {
			description: "Get a work item",
			inputSchema: {
				type: "object",
				properties: { id: { type: "string" } },
				required: ["id"],
			},
		},
	});

	mockAnalyzePMToolCapabilities.mockReturnValue({
		taskGet: {
			toolName: "get-item",
			idParam: "id",
			additionalRequiredParams: [],
		},
	});

	mockExecuteMcpTool.mockResolvedValue({
		success: true,
		output: {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						title: "PM Item Title",
						description: "PM Item Description",
						url: "https://pm.example.com/item/42",
					}),
				},
			],
		},
	});

	// Non-GitLab default — existing tests must hit the generic MCP path.
	mockGetProjectPMServerKey.mockResolvedValue("jira");
	mockIsGitLabOfficialKey.mockImplementation(
		(k: unknown) => k === "gitlab-official",
	);
	mockParsePMItemFromGetOutput.mockReturnValue({});
}

async function loadProcedureHandler() {
	const mod = await import("../import-from-pm");
	// biome-ignore lint/suspicious/noExplicitAny: test hatch — mocked procedure
	return (mod.importFromPMProcedure as any).handler as (args: {
		input: {
			projectId: string;
			externalId: string;
			overwrite?: boolean;
		};
		context: typeof baseCtx;
	}) => Promise<{
		success: boolean;
		story: Record<string, unknown>;
		imported: {
			title: string;
			externalId: string;
			externalUrl: string | null;
		};
	}>;
}

// ---- Tests -----------------------------------------------------------------

describe("importFromPMProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		mockUpdateStory.mockImplementation(
			(id: string, _projectId: string, data: Record<string, unknown>) =>
				db.userStory.update({
					where: { id },
					data,
					include: { status: true, tasks: true },
				}),
		);
	});

	it("overwrite: false (default) + existing story returns 409 CONFLICT", async () => {
		defaultSetup();
		vi.mocked(db.userStory.findFirst).mockResolvedValue({
			id: "story-1",
			identifier: "F-001",
			externalId: "42",
		} as never);

		const handler = await loadProcedureHandler();

		await expect(
			handler({
				input: { projectId: "proj-1", externalId: "42" },
				context: baseCtx,
			}),
		).rejects.toThrow(/already exists.*F-001/);

		expect(mockExecuteMcpTool).not.toHaveBeenCalled();
		expect(mockCreateStory).not.toHaveBeenCalled();
		expect(db.userStory.update).not.toHaveBeenCalled();
	});

	it("overwrite: true + existing story updates story with PM tool data", async () => {
		defaultSetup();
		vi.mocked(db.userStory.findFirst).mockResolvedValue({
			id: "story-1",
			identifier: "F-001",
			externalId: "42",
		} as never);

		const updatedStory = {
			id: "story-1",
			title: "PM Item Title",
			description: "PM Item Description",
			externalId: "42",
			externalUrl: "https://pm.example.com/item/42",
			status: { id: "s1", name: "Active" },
			tasks: [],
		};
		vi.mocked(db.userStory.update).mockResolvedValue(updatedStory as never);

		const handler = await loadProcedureHandler();
		const result = await handler({
			input: { projectId: "proj-1", externalId: "42", overwrite: true },
			context: baseCtx,
		});

		expect(result.success).toBe(true);
		expect(result.story).toEqual(updatedStory);
		expect(result.imported.title).toBe("PM Item Title");
		expect(result.imported.externalId).toBe("42");
		expect(result.imported.externalUrl).toBe(
			"https://pm.example.com/item/42",
		);

		expect(db.userStory.update).toHaveBeenCalledWith({
			where: { id: "story-1" },
			data: {
				title: "PM Item Title",
				description: "PM Item Description",
				externalUrl: "https://pm.example.com/item/42",
			},
			include: { status: true, tasks: true },
		});
		expect(mockUpdateStory).toHaveBeenCalledWith(
			"story-1",
			"proj-1",
			expect.objectContaining({
				title: "PM Item Title",
				description: "PM Item Description",
			}),
			{
				lastEditedByName: "Import User",
				lastEditedSource: "PM_PULL",
			},
		);

		expect(mockCreateStory).not.toHaveBeenCalled();
	});

	it("overwrite: true + no existing story creates new story", async () => {
		defaultSetup();
		vi.mocked(db.userStory.findFirst).mockResolvedValue(null as never);

		mockCreateStory.mockResolvedValue({
			id: "story-new",
			title: "PM Item Title",
		});

		const newStory = {
			id: "story-new",
			title: "PM Item Title",
			description: "PM Item Description",
			externalId: "42",
			externalUrl: "https://pm.example.com/item/42",
			status: { id: "s1", name: "New" },
			tasks: [],
		};
		vi.mocked(db.userStory.update).mockResolvedValue(newStory as never);

		const handler = await loadProcedureHandler();
		const result = await handler({
			input: { projectId: "proj-1", externalId: "42", overwrite: true },
			context: baseCtx,
		});

		expect(result.success).toBe(true);
		expect(result.story).toEqual(newStory);

		expect(mockCreateStory).toHaveBeenCalledWith({
			projectId: "proj-1",
			title: "PM Item Title",
			description: "PM Item Description",
			createdById: "user-1",
			source: "MANUAL",
		});

		// pmAutoSyncEnabled=true mirrors the spec §4.2 contract: paths that
		// stamp `externalId` at create time also opt into auto-sync so
		// observable behavior matches the pre-toggle world for imported rows.
		expect(db.userStory.update).toHaveBeenCalledWith({
			where: { id: "story-new" },
			data: {
				externalId: "42",
				externalUrl: "https://pm.example.com/item/42",
				labels: [],
				pmAutoSyncEnabled: true,
			},
			include: { status: true, tasks: true },
		});

		// The inbound import is recorded as a "pull" so it shows in Sync History.
		expect(mockRecordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "pull",
				status: "SUCCESS",
				entityType: "STORY",
				entityId: "story-new",
				externalId: "42",
				projectId: "proj-1",
			}),
		);
	});

	it("ingests ADO images on import and persists the rewritten description", async () => {
		defaultSetup();
		// Azure DevOps source → image ingest runs.
		mockAnalyzePMToolCapabilities.mockReturnValue({
			detectedType: "azure-devops",
			taskGet: {
				toolName: "get-item",
				idParam: "id",
				additionalRequiredParams: [],
			},
		});
		mockExecuteMcpTool.mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							title: "ADO Item",
							description:
								'<p><img src="https://dev.azure.com/org/_apis/wit/attachments/guid"></p>',
							url: "https://dev.azure.com/org/item/42",
						}),
					},
				],
			},
		});
		vi.mocked(db.userStory.findFirst).mockResolvedValue(null as never);
		mockCreateStory.mockResolvedValue({
			id: "story-ado",
			title: "ADO Item",
		});
		vi.mocked(db.userStory.update).mockResolvedValue({
			id: "story-ado",
			status: null,
			tasks: [],
		} as never);

		// The ingester rewrites the ADO URL to a Fabric-hosted <img>.
		mockIngestPulledImages.mockResolvedValue({
			description:
				'<p><img src="https://signed/story-media/proj-1/story-ado/pull-guid" data-s3-key="story-media/proj-1/story-ado/pull-guid"></p>',
			ingested: 1,
			reused: 0,
			failed: 0,
			skipped: 0,
		});

		const handler = await loadProcedureHandler();
		await handler({
			input: { projectId: "proj-1", externalId: "42", overwrite: true },
			context: baseCtx,
		});

		// Ingest was invoked with the story id and project id.
		expect(mockIngestPulledImages).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				storyId: "story-ado",
				description:
					'<p><img src="https://dev.azure.com/org/_apis/wit/attachments/guid"></p>',
			}),
		);

		// The follow-up update persisted the rewritten (Fabric-hosted) description.
		expect(db.userStory.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "story-ado" },
				data: expect.objectContaining({
					description:
						'<p><img src="https://signed/story-media/proj-1/story-ado/pull-guid" data-s3-key="story-media/proj-1/story-ado/pull-guid"></p>',
				}),
			}),
		);
	});

	it("imports a Fizzy card from description_html, not the plain placeholder text", async () => {
		defaultSetup();
		// Fizzy returns plain_text (attachments → `[filename]` placeholders) AND
		// description_html (the real markup). #1471: prefer the HTML.
		mockAnalyzePMToolCapabilities.mockReturnValue({
			detectedType: "fizzy",
			taskGet: {
				toolName: "fizzy_get_card",
				idParam: "card_id",
				additionalRequiredParams: [],
			},
		});
		mockExecuteMcpTool.mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							title: "Fizzy Card",
							description: "Body\n[download.jpg]\n[Test.xlsx]",
							description_html:
								'<div><p>Body</p><img src="/000000/rails/active_storage/blobs/redirect/SGID/download.jpg"></div>',
							url: "https://app.fizzy.do/000000/cards/5",
						}),
					},
				],
			},
		});
		vi.mocked(db.userStory.findFirst).mockResolvedValue(null as never);
		mockCreateStory.mockResolvedValue({
			id: "story-fz",
			title: "Fizzy Card",
		});
		vi.mocked(db.userStory.update).mockResolvedValue({
			id: "story-fz",
			status: null,
			tasks: [],
		} as never);
		mockIngestPulledImages.mockImplementation(
			async (a: { description: string }) => ({
				description: a.description,
				ingested: 0,
				reused: 0,
				failed: 0,
				skipped: 0,
			}),
		);

		const handler = await loadProcedureHandler();
		await handler({
			input: { projectId: "proj-1", externalId: "5", overwrite: true },
			context: baseCtx,
		});

		// createStory received the HTML-derived body (simpleHtmlToMarkdown is
		// identity in this mock), NOT the plain `[download.jpg]` placeholder.
		const createArg = mockCreateStory.mock.calls[0]?.[0] as {
			description?: string;
		};
		expect(createArg.description).toContain("<img");
		expect(createArg.description).not.toContain("[download.jpg]");
	});

	it("returns NOT_FOUND when project belongs to a different organization", async () => {
		// Caller is in org "org-other", but the requested project lives in
		// "org-owner" (or anywhere outside the caller's tenant). The tenant
		// filter on the project lookup must reject it with NOT_FOUND before
		// any PM-tool work runs.
		mockGetOrganizationIdFromContext.mockReturnValue("org-other");
		vi.mocked(db.project.findFirst).mockResolvedValue(null as never);

		const orgCtx = {
			...baseCtx,
			tenantContext: {
				type: "organization" as const,
				organizationId: "org-other",
				userId: "user-1",
			},
		};

		const handler = await loadProcedureHandler();

		await expect(
			handler({
				input: { projectId: "proj-1", externalId: "42" },
				context: orgCtx,
			}),
		).rejects.toThrow(/Project not found/);

		expect(db.project.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "proj-1", organizationId: "org-other" },
			}),
		);
		expect(mockExecuteMcpTool).not.toHaveBeenCalled();
		expect(mockCreateStory).not.toHaveBeenCalled();
	});

	it("org-context lookup scopes to the organization only and succeeds", async () => {
		// Caller is in org "org-owner" and the requested project belongs to
		// the same org. The tenant filter is org-scoped and must NOT carry
		// `userId` — org projects are shared, so the caller's id would scope
		// the lookup to projects they personally created (see the
		// teammate-project test below). The import path must run to
		// completion.
		mockGetOrganizationIdFromContext.mockReturnValue("org-owner");
		vi.mocked(db.project.findFirst).mockResolvedValue({
			id: "proj-1",
			organizationId: "org-owner",
			projectManagementMcpServerId: "mcp-server-1",
			projectManagementMcpConfigId: "mcp-cfg-1",
			projectManagementContainerId: "container-1",
			projectManagementAdditionalContext: null,
		} as never);
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "mcp-cfg-1",
			enabled: true,
			baseUrl: null,
			mcpServer: null,
		} as never);
		mockClientTools.mockResolvedValue({
			"get-item": {
				description: "Get a work item",
				inputSchema: {
					type: "object",
					properties: { id: { type: "string" } },
					required: ["id"],
				},
			},
		});
		mockAnalyzePMToolCapabilities.mockReturnValue({
			taskGet: {
				toolName: "get-item",
				idParam: "id",
				additionalRequiredParams: [],
			},
		});
		mockExecuteMcpTool.mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							title: "PM Item Title",
							description: "PM Item Description",
							url: "https://pm.example.com/item/42",
						}),
					},
				],
			},
		});
		vi.mocked(db.userStory.findFirst).mockResolvedValue(null as never);
		mockCreateStory.mockResolvedValue({ id: "story-new", title: "x" });
		vi.mocked(db.userStory.update).mockResolvedValue({
			id: "story-new",
			status: null,
			tasks: [],
		} as never);

		const orgCtx = {
			...baseCtx,
			tenantContext: {
				type: "organization" as const,
				organizationId: "org-owner",
				userId: "user-1",
			},
		};

		const handler = await loadProcedureHandler();
		const result = await handler({
			input: { projectId: "proj-1", externalId: "42", overwrite: true },
			context: orgCtx,
		});

		expect(result.success).toBe(true);
		expect(db.project.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "proj-1", organizationId: "org-owner" },
			}),
		);
	});

	it("imports into an org project created by a different member", async () => {
		// Org-shared projects carry the CREATOR's userId. Scoping the org-branch
		// lookup by the caller's userId would hide every teammate's project
		// behind a NOT_FOUND even though `requireProjectPermission` already
		// authorized the caller. The filter is applied for real here (against a
		// row seeded with a different creator) so the assertion is about the
		// import succeeding, not about the shape of a mock call.
		mockGetOrganizationIdFromContext.mockReturnValue("org-owner");
		const teammateProject = {
			id: "proj-1",
			organizationId: "org-owner",
			userId: "user-creator",
			projectManagementMcpServerId: "mcp-server-1",
			projectManagementMcpConfigId: "mcp-cfg-1",
			projectManagementContainerId: "container-1",
			projectManagementAdditionalContext: null,
		};
		vi.mocked(db.project.findFirst).mockImplementation((async (args: {
			where: Record<string, unknown>;
		}) => {
			const matches = Object.entries(args.where).every(
				([field, value]) =>
					teammateProject[field as keyof typeof teammateProject] ===
					value,
			);
			return matches ? teammateProject : null;
			// biome-ignore lint/suspicious/noExplicitAny: test hatch — mocked Prisma delegate
		}) as any);
		vi.mocked(resolvePMConfigForUser).mockResolvedValue({
			id: "mcp-cfg-1",
			enabled: true,
			baseUrl: null,
			mcpServer: null,
		} as never);
		mockClientTools.mockResolvedValue({
			"get-item": {
				description: "Get a work item",
				inputSchema: {
					type: "object",
					properties: { id: { type: "string" } },
					required: ["id"],
				},
			},
		});
		mockAnalyzePMToolCapabilities.mockReturnValue({
			taskGet: {
				toolName: "get-item",
				idParam: "id",
				additionalRequiredParams: [],
			},
		});
		mockExecuteMcpTool.mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							title: "PM Item Title",
							description: "PM Item Description",
							url: "https://pm.example.com/item/42",
						}),
					},
				],
			},
		});
		vi.mocked(db.userStory.findFirst).mockResolvedValue(null as never);
		mockCreateStory.mockResolvedValue({ id: "story-new", title: "x" });
		vi.mocked(db.userStory.update).mockResolvedValue({
			id: "story-new",
			status: null,
			tasks: [],
		} as never);

		const handler = await loadProcedureHandler();
		const result = await handler({
			input: { projectId: "proj-1", externalId: "42", overwrite: true },
			context: {
				...baseCtx,
				tenantContext: {
					type: "organization" as const,
					organizationId: "org-owner",
					userId: "user-1",
				},
			},
		});

		expect(result.success).toBe(true);
	});

	it("personal-context lookup uses XOR filter (organizationId=null, userId)", async () => {
		defaultSetup();
		vi.mocked(db.userStory.findFirst).mockResolvedValue(null as never);
		mockCreateStory.mockResolvedValue({ id: "story-new", title: "x" });
		vi.mocked(db.userStory.update).mockResolvedValue({
			id: "story-new",
			status: null,
			tasks: [],
		} as never);

		const handler = await loadProcedureHandler();
		await handler({
			input: { projectId: "proj-1", externalId: "42", overwrite: true },
			context: baseCtx,
		});

		expect(db.project.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "proj-1",
					organizationId: null,
					userId: "user-1",
				}),
			}),
		);
	});

	it("overwrite: false + no existing story creates new story", async () => {
		defaultSetup();
		vi.mocked(db.userStory.findFirst).mockResolvedValue(null as never);

		mockCreateStory.mockResolvedValue({
			id: "story-new",
			title: "PM Item Title",
		});

		const newStory = {
			id: "story-new",
			title: "PM Item Title",
			externalId: "42",
			externalUrl: "https://pm.example.com/item/42",
			status: { id: "s1", name: "New" },
			tasks: [],
		};
		vi.mocked(db.userStory.update).mockResolvedValue(newStory as never);

		const handler = await loadProcedureHandler();
		const result = await handler({
			input: { projectId: "proj-1", externalId: "42" },
			context: baseCtx,
		});

		expect(result.success).toBe(true);
		expect(mockCreateStory).toHaveBeenCalled();
	});

	// ----------------------------------------------------------------------
	// GitLab official branch — skips MCP discovery and routes through the
	// GitLab REST adapter so tier-gated accounts can still import issues.
	// ----------------------------------------------------------------------
	describe("GitLab official branch", () => {
		it("imports a new GitLab issue via getGitLabIssueForPM (REST adapter)", async () => {
			defaultSetup();
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
			mockResolveGitLabPMSource.mockResolvedValue({
				kind: "rest-adapter",
				token: "glpat-test",
			} as never);
			mockGetGitLabIssueForPM.mockResolvedValue({
				title: "Add OAuth reconnect flow",
				description: "Reconnect on 401",
				externalUrl: "https://gitlab.com/alice/widgets/-/issues/1",
				labels: ["workflow::todo"],
			});

			vi.mocked(db.userStory.findFirst).mockResolvedValue(null);
			mockCreateStory.mockResolvedValue({ id: "story-new" });
			vi.mocked(db.userStory.findUnique).mockResolvedValue({
				id: "story-new",
				title: "Add OAuth reconnect flow",
				externalId: "1",
				externalUrl: "https://gitlab.com/alice/widgets/-/issues/1",
				status: { id: "s1", name: "New" },
				tasks: [],
			} as never);

			const handler = await loadProcedureHandler();
			const result = await handler({
				input: { projectId: "proj-1", externalId: "1" },
				context: baseCtx,
			});

			// Generic MCP path is not exercised on the GitLab branch.
			expect(mockExecuteMcpTool).not.toHaveBeenCalled();
			expect(mockAnalyzePMToolCapabilities).not.toHaveBeenCalled();
			// resolvePMConfigForUser must be skipped — the MCPConfig can be
			// missing (auto-flipped tier probe) and the REST path still works.
			expect(resolvePMConfigForUser).not.toHaveBeenCalled();

			expect(mockGetGitLabIssueForPM).toHaveBeenCalledWith(
				expect.objectContaining({
					gitlabProjectId: "container-1",
					externalId: "1",
				}),
			);
			expect(mockCreateStory).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj-1",
					title: "Add OAuth reconnect flow",
					source: "GITLAB",
				}),
			);
			expect(result.success).toBe(true);
			expect(result.imported).toEqual({
				title: "Add OAuth reconnect flow",
				externalId: "1",
				externalUrl: "https://gitlab.com/alice/widgets/-/issues/1",
			});

			// GitLab import is recorded as a "pull" tagged "gitlab".
			expect(mockRecordPmSyncLog).toHaveBeenCalledWith(
				expect.objectContaining({
					direction: "pull",
					status: "SUCCESS",
					pmTool: "gitlab",
					entityId: "story-new",
					externalId: "1",
				}),
			);
		});

		it("throws BAD_REQUEST when GitLab is not connected (source resolver returns null)", async () => {
			defaultSetup();
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
			mockResolveGitLabPMSource.mockResolvedValue(null);

			const handler = await loadProcedureHandler();
			await expect(
				handler({
					input: { projectId: "proj-1", externalId: "1" },
					context: baseCtx,
				}),
			).rejects.toThrow(/GitLab not connected/);
			expect(mockGetGitLabIssueForPM).not.toHaveBeenCalled();
		});

		it("throws 409 CONFLICT when a story with the same external ID already exists and overwrite=false", async () => {
			defaultSetup();
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
			mockResolveGitLabPMSource.mockResolvedValue({
				kind: "rest-adapter",
				token: "glpat-test",
			} as never);
			vi.mocked(db.userStory.findFirst).mockResolvedValue({
				id: "story-1",
				identifier: "F-001",
				externalId: "1",
			} as never);

			const handler = await loadProcedureHandler();
			await expect(
				handler({
					input: { projectId: "proj-1", externalId: "1" },
					context: baseCtx,
				}),
			).rejects.toThrow(/already exists.*F-001/);
			expect(mockGetGitLabIssueForPM).not.toHaveBeenCalled();
		});

		it("overwrite re-runs label→status mapping and sets statusId", async () => {
			defaultSetup();
			// Project carries a label→status map: the GitLab label
			// "status:status-done" maps to the project status id "status-done".
			vi.mocked(db.project.findFirst).mockResolvedValue({
				id: "proj-1",
				organizationId: null,
				projectManagementMcpServerId: "mcp-server-1",
				projectManagementMcpConfigId: "mcp-cfg-1",
				projectManagementContainerId: "container-1",
				projectManagementAdditionalContext: {
					labelStatusMap: { "status:status-done": "status-done" },
				},
			} as never);
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
			mockResolveGitLabPMSource.mockResolvedValue({
				kind: "rest-adapter",
				token: "glpat-test",
			} as never);
			vi.mocked(db.userStory.findFirst).mockResolvedValue({
				id: "story-1",
				identifier: "F-001",
				externalId: "1",
			} as never);
			// Project has the status the label maps to.
			vi.mocked(db.projectStoryStatus.findMany).mockResolvedValue([
				{ id: "status-done" },
			] as never);
			mockGetGitLabIssueForPM.mockResolvedValue({
				title: "Updated title",
				description: "Updated body",
				externalUrl: "https://gitlab.com/alice/widgets/-/issues/1",
				labels: ["status:status-done"],
			});
			vi.mocked(db.userStory.update).mockImplementation(
				(args: unknown) =>
					Promise.resolve({
						id: "story-1",
						title: "Updated title",
						statusId: (args as { data: { statusId?: string } }).data
							.statusId,
						status: { id: "status-done", name: "Done" },
						tasks: [],
					}) as never,
			);

			const handler = await loadProcedureHandler();
			const result = await handler({
				input: {
					projectId: "proj-1",
					externalId: "1",
					overwrite: true,
					// biome-ignore lint/suspicious/noExplicitAny: test passes label map source
				} as any,
				context: baseCtx,
			});

			expect(result.success).toBe(true);
			// Overwrite path must re-run mapping and set the derived statusId.
			expect(db.userStory.update).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: "story-1" },
					data: expect.objectContaining({ statusId: "status-done" }),
				}),
			);
			expect((result.story as { statusId?: string }).statusId).toBe(
				"status-done",
			);
		});

		it("create race: P2002 from createStory recovers by updating the winner", async () => {
			defaultSetup();
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
			mockResolveGitLabPMSource.mockResolvedValue({
				kind: "rest-adapter",
				token: "glpat-test",
			} as never);
			mockGetGitLabIssueForPM.mockResolvedValue({
				title: "Racey issue",
				description: "body",
				externalUrl: "https://gitlab.com/alice/widgets/-/issues/9",
				labels: [],
			});

			// First dedup check: no existing story → take create path.
			// After P2002: findFirst returns the winner row.
			const winner = {
				id: "story-winner",
				identifier: "F-009",
				externalId: "9",
			};
			vi.mocked(db.userStory.findFirst)
				.mockResolvedValueOnce(null as never)
				.mockResolvedValueOnce(winner as never);

			// createStory rejects with a Prisma unique-violation (P2002),
			// constructed via the same class the implementation tests with.
			const p2002 = new Prisma.PrismaClientKnownRequestError(
				"Unique constraint failed",
				{
					code: "P2002",
					clientVersion: "x",
					meta: { target: ["projectId", "externalId"] },
				},
			);
			mockCreateStory.mockRejectedValue(p2002);

			vi.mocked(db.userStory.update).mockResolvedValue({
				id: "story-winner",
				title: "Racey issue",
				externalId: "9",
				externalUrl: "https://gitlab.com/alice/widgets/-/issues/9",
				status: { id: "s1", name: "New" },
				tasks: [],
			} as never);

			const handler = await loadProcedureHandler();
			const result = await handler({
				input: {
					projectId: "proj-1",
					externalId: "9",
					overwrite: false,
				},
				context: baseCtx,
			});

			expect(result.success).toBe(true);
			expect(db.userStory.update).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: "story-winner" },
				}),
			);
		});

		it("create error: P2002 on a DIFFERENT constraint rethrows (no winner-recovery)", async () => {
			defaultSetup();
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
			mockResolveGitLabPMSource.mockResolvedValue({
				kind: "rest-adapter",
				token: "glpat-test",
			} as never);
			mockGetGitLabIssueForPM.mockResolvedValue({
				title: "Some issue",
				description: "body",
				externalUrl: "https://gitlab.com/alice/widgets/-/issues/9",
				labels: [],
			});

			// No existing story → create path.
			vi.mocked(db.userStory.findFirst).mockResolvedValue(null as never);

			// createStory rejects with a P2002 on the per-project `identifier`
			// constraint — NOT the (projectId, externalId) index. The handler
			// must rethrow, not attempt winner-recovery.
			const p2002 = new Prisma.PrismaClientKnownRequestError(
				"Unique constraint failed",
				{
					code: "P2002",
					clientVersion: "x",
					meta: { target: ["identifier"] },
				},
			);
			mockCreateStory.mockRejectedValue(p2002);

			const handler = await loadProcedureHandler();
			await expect(
				handler({
					input: {
						projectId: "proj-1",
						externalId: "9",
						overwrite: false,
					},
					context: baseCtx,
				}),
			).rejects.toThrow(/Unique constraint failed/);

			// The first findFirst is the dedup check (returned null). The
			// winner-recovery findFirst must NOT run, and no update is issued.
			expect(vi.mocked(db.userStory.findFirst)).toHaveBeenCalledTimes(1);
			expect(db.userStory.update).not.toHaveBeenCalled();
		});

		it("updates an existing story when overwrite=true", async () => {
			defaultSetup();
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
			mockResolveGitLabPMSource.mockResolvedValue({
				kind: "rest-adapter",
				token: "glpat-test",
			} as never);
			vi.mocked(db.userStory.findFirst).mockResolvedValue({
				id: "story-1",
				identifier: "F-001",
				externalId: "1",
			} as never);
			mockGetGitLabIssueForPM.mockResolvedValue({
				title: "Updated title",
				description: "Updated body",
				externalUrl: "https://gitlab.com/alice/widgets/-/issues/1",
				labels: [],
			});
			vi.mocked(db.userStory.update).mockResolvedValue({
				id: "story-1",
				title: "Updated title",
				externalId: "1",
				externalUrl: "https://gitlab.com/alice/widgets/-/issues/1",
				status: { id: "s1", name: "Done" },
				tasks: [],
			} as never);

			const handler = await loadProcedureHandler();
			const result = await handler({
				input: {
					projectId: "proj-1",
					externalId: "1",
					overwrite: true,
				},
				context: baseCtx,
			});

			expect(mockCreateStory).not.toHaveBeenCalled();
			expect(db.userStory.update).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: "story-1" },
					data: expect.objectContaining({ title: "Updated title" }),
				}),
			);
			expect(mockUpdateStory).toHaveBeenCalledWith(
				"story-1",
				"proj-1",
				expect.objectContaining({ title: "Updated title" }),
				{
					lastEditedByName: "Import User",
					lastEditedSource: "PM_PULL",
				},
			);
			expect(result.success).toBe(true);
		});
	});

	// Fizzy #1745 review finding (2): a fourth block-ingress route. Without a
	// strip, importing/re-pulling a GitLab issue that carries the Fabric-owned
	// attachment block (because the story had previously been pushed with
	// attachments) writes the block into Fabric's story/FeatureVersion/
	// AI-Update context, and the next push appends a second copy on top of it.
	describe("attachment block stripping on import (Fizzy #1745)", () => {
		const REMOTE_DESCRIPTION_WITH_BLOCK =
			"Issue body\n\n<!-- fabric:attachments -->\n### Attachments\n- [spec.pdf](/uploads/abc/spec.pdf)\n<!-- /fabric:attachments -->";

		it("GitLab official path: strips the attachment block before creating a new story", async () => {
			defaultSetup();
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
			mockResolveGitLabPMSource.mockResolvedValue({
				kind: "rest-adapter",
				token: "glpat-test",
			} as never);
			mockGetGitLabIssueForPM.mockResolvedValue({
				title: "Add OAuth reconnect flow",
				description: REMOTE_DESCRIPTION_WITH_BLOCK,
				externalUrl: "https://gitlab.com/alice/widgets/-/issues/1",
				labels: [],
			});

			vi.mocked(db.userStory.findFirst).mockResolvedValue(null);
			mockCreateStory.mockResolvedValue({ id: "story-new" });
			vi.mocked(db.userStory.findUnique).mockResolvedValue({
				id: "story-new",
				title: "Add OAuth reconnect flow",
				externalId: "1",
				externalUrl: "https://gitlab.com/alice/widgets/-/issues/1",
				status: { id: "s1", name: "New" },
				tasks: [],
			} as never);

			const handler = await loadProcedureHandler();
			const result = await handler({
				input: { projectId: "proj-1", externalId: "1" },
				context: baseCtx,
			});

			expect(mockStripAttachmentBlock).toHaveBeenCalledWith(
				REMOTE_DESCRIPTION_WITH_BLOCK,
			);
			const createdDescription = (
				mockCreateStory.mock.calls[0]?.[0] as { description?: string }
			).description;
			expect(createdDescription).toContain("Issue body");
			expect(createdDescription).not.toContain("fabric:attachments");
			expect(createdDescription).not.toContain("spec.pdf");
			expect(result.success).toBe(true);
		});

		it("GitLab official path: strips the attachment block on an overwrite of an existing story", async () => {
			defaultSetup();
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-official");
			mockResolveGitLabPMSource.mockResolvedValue({
				kind: "rest-adapter",
				token: "glpat-test",
			} as never);
			vi.mocked(db.userStory.findFirst).mockResolvedValue({
				id: "story-1",
				identifier: "F-001",
				externalId: "1",
			} as never);
			mockGetGitLabIssueForPM.mockResolvedValue({
				title: "Updated title",
				description: REMOTE_DESCRIPTION_WITH_BLOCK,
				externalUrl: "https://gitlab.com/alice/widgets/-/issues/1",
				labels: [],
			});
			vi.mocked(db.userStory.update).mockResolvedValue({
				id: "story-1",
				title: "Updated title",
				externalId: "1",
				externalUrl: "https://gitlab.com/alice/widgets/-/issues/1",
				status: { id: "s1", name: "Done" },
				tasks: [],
			} as never);

			const handler = await loadProcedureHandler();
			const result = await handler({
				input: {
					projectId: "proj-1",
					externalId: "1",
					overwrite: true,
				},
				context: baseCtx,
			});

			expect(mockStripAttachmentBlock).toHaveBeenCalledWith(
				REMOTE_DESCRIPTION_WITH_BLOCK,
			);
			const updateCall = mockUpdateStory.mock.calls[0] as [
				string,
				string,
				{ description?: string },
			];
			expect(updateCall[2].description).toContain("Issue body");
			expect(updateCall[2].description).not.toContain(
				"fabric:attachments",
			);
			expect(updateCall[2].description).not.toContain("spec.pdf");
			expect(result.success).toBe(true);
		});

		it("generic MCP path: strips the attachment block when the connected tool self-reports as GitLab (e.g. a non-'gitlab-official'-keyed self-hosted server)", async () => {
			defaultSetup();
			// Not the official key — routes through the generic MCP path
			// (`fetchPMItemData`), not `handleGitLabImport`.
			mockGetProjectPMServerKey.mockResolvedValue("gitlab-selfhosted");
			mockAnalyzePMToolCapabilities.mockReturnValue({
				detectedType: "gitlab",
				taskGet: {
					toolName: "get-item",
					idParam: "id",
					additionalRequiredParams: [],
				},
			});
			mockExecuteMcpTool.mockResolvedValue({
				success: true,
				output: {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								title: "Self-hosted GitLab issue",
								description: REMOTE_DESCRIPTION_WITH_BLOCK,
								url: "https://gitlab.example.com/g/p/-/issues/7",
							}),
						},
					],
				},
			});
			vi.mocked(db.userStory.findFirst).mockResolvedValue(null as never);
			mockCreateStory.mockResolvedValue({ id: "story-new" });
			vi.mocked(db.userStory.update).mockResolvedValue({
				id: "story-new",
				title: "Self-hosted GitLab issue",
				description: "Issue body",
				externalId: "7",
				externalUrl: "https://gitlab.example.com/g/p/-/issues/7",
				status: { id: "s1", name: "New" },
				tasks: [],
			} as never);

			const handler = await loadProcedureHandler();
			const result = await handler({
				input: { projectId: "proj-1", externalId: "7" },
				context: baseCtx,
			});

			expect(mockStripAttachmentBlock).toHaveBeenCalledWith(
				REMOTE_DESCRIPTION_WITH_BLOCK,
			);
			const createdDescription = (
				mockCreateStory.mock.calls[0]?.[0] as { description?: string }
			).description;
			expect(createdDescription).toContain("Issue body");
			expect(createdDescription).not.toContain("fabric:attachments");
			expect(createdDescription).not.toContain("spec.pdf");
			expect(result.success).toBe(true);
		});
	});

	describe("FEATURE_PM_TYPE_MAPPING — kind on create", () => {
		it("flag on + ADO 'Bug' → createStory called with kind:'BUG'", async () => {
			process.env.FEATURE_PM_TYPE_MAPPING = "true";
			defaultSetup();
			mockParsePMItemFromGetOutput.mockReturnValue({
				workItemType: "Bug",
			});
			vi.mocked(db.userStory.findFirst).mockResolvedValue(null as never);
			mockCreateStory.mockResolvedValue({ id: "story-new", title: "x" });
			vi.mocked(db.userStory.update).mockResolvedValue({
				id: "story-new",
				status: null,
				tasks: [],
			} as never);

			const handler = await loadProcedureHandler();
			await handler({
				input: { projectId: "proj-1", externalId: "42" },
				context: baseCtx,
			});

			expect(mockCreateStory).toHaveBeenCalledWith(
				expect.objectContaining({ kind: "BUG" }),
			);
			delete process.env.FEATURE_PM_TYPE_MAPPING;
		});

		it("flag off → createStory called without kind", async () => {
			delete process.env.FEATURE_PM_TYPE_MAPPING;
			defaultSetup();
			mockParsePMItemFromGetOutput.mockReturnValue({
				workItemType: "Bug",
			});
			vi.mocked(db.userStory.findFirst).mockResolvedValue(null as never);
			mockCreateStory.mockResolvedValue({ id: "story-new", title: "x" });
			vi.mocked(db.userStory.update).mockResolvedValue({
				id: "story-new",
				status: null,
				tasks: [],
			} as never);

			const handler = await loadProcedureHandler();
			await handler({
				input: { projectId: "proj-1", externalId: "42" },
				context: baseCtx,
			});

			const callArg = mockCreateStory.mock.calls[0]?.[0] as Record<
				string,
				unknown
			>;
			expect(callArg).not.toHaveProperty("kind");
		});
	});
});
