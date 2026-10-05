/**
 * `refineDescriptionProcedure` authorizes the tenant it runs in before it
 * resolves a model or a RAG provider.
 *
 * The procedure used `requirePermission(PROJECT_UPDATE)`, which evaluates the
 * caller's role in their SESSION organization, and then resolved the AI model
 * and RAG provider config for `input.organizationId`. An admin of one
 * organization could therefore name another and run on (and bill) its AI
 * provider. Now, in the handler and before any model or RAG call:
 *
 * - with `projectId` (the wizard's DRAFT project), PROJECT_UPDATE is checked on
 *   THAT project (`assertProjectPermission`, the decision
 *   `requireProjectPermission` makes) and everything runs in the project's
 *   organization — so an accepted project guest with no membership of the
 *   project's organization keeps working;
 * - without `projectId`, membership and the PROJECT_UPDATE role are checked in
 *   the organization the input resolves to (`authorizeInputOrganization`, the
 *   check `requireInputOrgPermission` runs), with an organization required.
 *
 * The real permission functions run here. Only their data sources are doubled:
 * organization membership, the project row, and the effective project access
 * (built from the real project-role permission sets).
 */

import { Permissions, resolveProjectPermissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(() => ({ effectiveWriteOrgId: undefined })),
	projectFindUnique: vi.fn(),
	hasProjectAccess: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	getRAGProviderConfig: vi.fn(),
	logModelUsageAsync: vi.fn(),
	generateText: vi.fn(),
	retrieveWizardContexts: vi.fn(),
	retrieveProjectContexts: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		member: { findFirst: vi.fn(), findUnique: vi.fn() },
		projectMember: { findUnique: vi.fn() },
	},
	grantProjectAccess: vi.fn(),
	hasProjectAccess: mocks.hasProjectAccess,
	getOrganizationMembership: mocks.getOrganizationMembership,
	getTenantContext: mocks.getTenantContext,
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));
vi.mock("@repo/rag", () => ({
	retrieveWizardContexts: mocks.retrieveWizardContexts,
	retrieveProjectContexts: mocks.retrieveProjectContexts,
	formatWizardContextsForPrompt: vi.fn(() => ""),
	formatContextsForPrompt: vi.fn(() => ""),
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	getRAGProviderConfig: mocks.getRAGProviderConfig,
	logModelUsageAsync: mocks.logModelUsageAsync,
}));
vi.mock("ai", () => ({ generateText: mocks.generateText }));

vi.mock("../../../../orpc/procedures", async () => {
	const permissionModule = await vi.importActual<
		typeof import("../../../../orpc/middleware/require-permission")
	>("../../../../orpc/middleware/require-permission");
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	// Any middleware still attached runs ahead of the handler, as in oRPC.
	type Mw = (
		opts: { context: unknown; next: () => Promise<unknown> },
		input: unknown,
	) => Promise<unknown>;
	const middlewares: Mw[] = [];
	const builder: Record<string, unknown> = {};
	builder.use = (mw: Mw) => {
		middlewares.push(mw);
		return builder;
	};
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (
		fn: (args: { input: unknown; context: unknown }) => unknown,
	) => ({
		run: async (args: { input: unknown; context: unknown }) => {
			let index = 0;
			const dispatch = async (): Promise<unknown> => {
				const mw = middlewares[index++];
				if (mw) {
					return mw(
						{ context: args.context, next: dispatch },
						args.input,
					);
				}
				return fn(args);
			};
			return dispatch();
		},
	});
	return {
		tenantProtectedProcedure: builder,
		Permissions,
		requirePermission: permissionModule.requirePermission,
		requireInputOrgPermission: permissionModule.requireInputOrgPermission,
		assertProjectPermission: permissionModule.assertProjectPermission,
		authorizeInputOrganization: permissionModule.authorizeInputOrganization,
	};
});

const USER_ID = "user-1";
const SESSION_ORG = "org-a"; // where the caller is an owner
const FOREIGN_ORG = "org-b"; // where the caller has no membership
const PROJECT_ID = "draft-project";

const context = {
	user: { id: USER_ID },
	session: { activeOrganizationId: SESSION_ORG },
	tenantContext: {
		userId: USER_ID,
		type: "organization" as const,
		organizationId: SESSION_ORG,
	},
	activeOrganizationRole: "owner",
};

async function run(input: Record<string, unknown>) {
	const mod = await import("../refine-description");
	return (
		mod.refineDescriptionProcedure as unknown as {
			run: (args: {
				input: unknown;
				context: unknown;
			}) => Promise<unknown>;
		}
	).run({
		input: { sessionId: "session-1", description: "A tool", ...input },
		context,
	});
}

function projectMember(role: "EDITOR" | "VIEWER", organizationId: string) {
	return {
		source: "project-member" as const,
		permissions: resolveProjectPermissions(role),
		organizationId,
	};
}

function expectNoAiOrRag() {
	expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
	expect(mocks.getRAGProviderConfig).not.toHaveBeenCalled();
	expect(mocks.retrieveProjectContexts).not.toHaveBeenCalled();
	expect(mocks.retrieveWizardContexts).not.toHaveBeenCalled();
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getTenantContext.mockReturnValue({ effectiveWriteOrgId: undefined });
	mocks.getOrganizationMembership.mockImplementation(
		async (organizationId: string) =>
			organizationId === SESSION_ORG ? { role: "owner" } : null,
	);
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		source: "none",
		permissions: [],
		organizationId: null,
	});
	mocks.projectFindUnique.mockResolvedValue({ organizationId: FOREIGN_ORG });
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: { id: "stub" },
		metadata: {},
		trackUsage: vi.fn(),
	});
	mocks.getRAGProviderConfig.mockResolvedValue({
		apiKey: "key",
		provider: "OPENAI",
	});
	mocks.retrieveWizardContexts.mockResolvedValue([]);
	mocks.retrieveProjectContexts.mockResolvedValue([]);
	mocks.generateText.mockResolvedValue({ text: "Refined", usage: {} });
});

describe("refineDescriptionProcedure — without a project: the input organization", () => {
	it("refuses an organization the caller is not a member of, before any model or RAG resolution", async () => {
		await expect(
			run({ organizationId: FOREIGN_ORG }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			FOREIGN_ORG,
			USER_ID,
		);
		expectNoAiOrRag();
	});

	it("refuses an explicit null organization rather than skipping the check", async () => {
		await expect(run({ organizationId: null })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		expectNoAiOrRag();
	});

	it("serves an organization the caller is a member of, resolving everything there", async () => {
		await run({ organizationId: SESSION_ORG });

		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			{ userId: USER_ID, organizationId: SESSION_ORG },
		);
		expect(mocks.getRAGProviderConfig).toHaveBeenCalledWith({
			userId: USER_ID,
			organizationId: SESSION_ORG,
		});
	});

	it("falls back to the session organization when the input names none", async () => {
		await run({});

		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			SESSION_ORG,
			USER_ID,
		);
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			{ userId: USER_ID, organizationId: SESSION_ORG },
		);
	});
});

describe("refineDescriptionProcedure — with a project: the project and its organization", () => {
	it("serves an accepted project guest with no membership of the project's organization, in that organization", async () => {
		// Session organization A; an accepted EDITOR ProjectMember row on a
		// project in organization B; no membership of B. The wizard sends
		// the project's organization alongside the project.
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
			projectMember("EDITOR", FOREIGN_ORG),
		);

		await run({ projectId: PROJECT_ID, organizationId: FOREIGN_ORG });

		expect(mocks.resolveEffectiveProjectPermissions).toHaveBeenCalledWith(
			PROJECT_ID,
			USER_ID,
		);
		expect(mocks.getOrganizationMembership).not.toHaveBeenCalled();
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			{ userId: USER_ID, organizationId: FOREIGN_ORG },
		);
		expect(mocks.getRAGProviderConfig).toHaveBeenCalledWith({
			userId: USER_ID,
			organizationId: FOREIGN_ORG,
		});
		expect(mocks.retrieveProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT_ID,
				organizationId: FOREIGN_ORG,
			}),
		);
	});

	it("runs in the project's organization even when the input names another the caller belongs to", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
			projectMember("EDITOR", FOREIGN_ORG),
		);

		await run({ projectId: PROJECT_ID, organizationId: SESSION_ORG });

		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			{ userId: USER_ID, organizationId: FOREIGN_ORG },
		);
	});

	it("refuses a project the caller can see but not update, before any model or RAG resolution", async () => {
		expect(
			resolveProjectPermissions("VIEWER").includes(
				Permissions.PROJECT_UPDATE,
			),
		).toBe(false);
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
			projectMember("VIEWER", FOREIGN_ORG),
		);

		// The input names the caller's own organization, where they are an
		// owner: that role must not stand in for the project decision.
		await expect(
			run({ projectId: PROJECT_ID, organizationId: SESSION_ORG }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expectNoAiOrRag();
	});

	it("answers NOT_FOUND for a project the caller has no tie to, before any model or RAG resolution", async () => {
		await expect(
			run({ projectId: PROJECT_ID, organizationId: SESSION_ORG }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expectNoAiOrRag();
	});

	it("refuses a project with no organization, before any model or RAG resolution", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "owner",
			permissions: resolveProjectPermissions("OWNER"),
			organizationId: null,
		});
		mocks.projectFindUnique.mockResolvedValue({ organizationId: null });

		await expect(
			run({ projectId: PROJECT_ID, organizationId: SESSION_ORG }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expectNoAiOrRag();
	});
});
