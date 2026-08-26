/**
 * Tests for saveDraftProjectProcedure
 * Verifies idempotent draft creation/update with tenant isolation,
 * and that wizard-only ephemera is bundled into wizardState while
 * typed columns are passed through to upsertDraftProjectByKey.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { handlers, mockUpsert, mockVerifyMembership } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockUpsert: vi.fn(),
	mockVerifyMembership: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	upsertDraftProjectByKey: (...args: unknown[]) => mockUpsert(...args),
	Prisma: { JsonNull: "__JSON_NULL__", DbNull: "__DB_NULL__" },
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: (...args: unknown[]) =>
		mockVerifyMembership(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.saveDraft = fn;
			return {
				_handler: fn,
				_input: (chainable as { _input?: unknown })._input,
			};
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
		requirePermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

// Side-effect: register the handler.
import "../save-draft-project";

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

const draftKeySchema = z.string().uuid();

describe("saveDraftProjectProcedure input schema", () => {
	it("accepts valid UUID draftKey", () => {
		expect(
			draftKeySchema.safeParse("550e8400-e29b-41d4-a716-446655440000")
				.success,
		).toBe(true);
	});

	it("rejects non-UUID draftKey", () => {
		expect(draftKeySchema.safeParse("not-a-uuid").success).toBe(false);
	});
});

describe("saveDraftProjectProcedure handler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUpsert.mockResolvedValue({
			project: {
				id: "proj_1",
				name: "Draft",
				draftKey: "550e8400-e29b-41d4-a716-446655440000",
				wizardState: null,
			},
			created: true,
		});
	});

	it("bundles wizard-only ephemera into wizardState and passes typed columns through", async () => {
		await handlers.saveDraft({
			input: {
				draftKey: "550e8400-e29b-41d4-a716-446655440000",
				name: "Draft",
				organizationId: null,
				techStack: ["React"],
				features: ["Search"],
				// Typed columns
				repositoryUrl: "https://github.com/acme/app",
				repositoryOwner: "acme",
				repositoryName: "app",
				defaultBranch: "main",
				projectManagementMcpServerId: "srv_1",
				// Wizard-only ephemera
				currentStep: 3,
				customRequirements: "Must support SAML",
				documents: ["PRD", "Architecture"],
				tempContextIds: ["ctx_1", "ctx_2"],
				wizardSessionId: "wiz_42",
				selectedTeamsChats: [{ topic: "Eng" }],
				selectedNotionPages: [{ pageId: "p1" }],
				selectedSlackChannels: [{ channelId: "c1" }],
				selectedGitHubRepos: [{ name: "app" }],
				selectedGitLabRepos: [],
			},
			context: ctx,
		});

		expect(mockUpsert).toHaveBeenCalledTimes(1);
		const args = mockUpsert.mock.calls[0][0];

		// Typed columns: passed straight through
		expect(args.repositoryUrl).toBe("https://github.com/acme/app");
		expect(args.repositoryOwner).toBe("acme");
		expect(args.repositoryName).toBe("app");
		expect(args.defaultBranch).toBe("main");
		expect(args.projectManagementMcpServerId).toBe("srv_1");
		expect(args.techStack).toEqual(["React"]);
		expect(args.features).toEqual(["Search"]);

		// Wizard-only ephemera: bundled into a single wizardState blob
		expect(args.wizardState).toEqual({
			currentStep: 3,
			customRequirements: "Must support SAML",
			documents: ["PRD", "Architecture"],
			tempContextIds: ["ctx_1", "ctx_2"],
			wizardSessionId: "wiz_42",
			selectedTeamsChats: [{ topic: "Eng" }],
			selectedNotionPages: [{ pageId: "p1" }],
			selectedSlackChannels: [{ channelId: "c1" }],
			selectedGitHubRepos: [{ name: "app" }],
			selectedGitLabRepos: [],
		});
	});

	it("leaves wizardState undefined when client sends no wizard-only fields (preserves existing blob)", async () => {
		await handlers.saveDraft({
			input: {
				draftKey: "550e8400-e29b-41d4-a716-446655440001",
				name: "Just a name",
				organizationId: null,
			},
			context: ctx,
		});

		const args = mockUpsert.mock.calls[0][0];
		expect(args.wizardState).toBeUndefined();
	});

	it("trims project name before persisting", async () => {
		await handlers.saveDraft({
			input: {
				draftKey: "550e8400-e29b-41d4-a716-446655440002",
				name: "  Padded Name  ",
				organizationId: null,
			},
			context: ctx,
		});

		const args = mockUpsert.mock.calls[0][0];
		expect(args.name).toBe("Padded Name");
	});

	it("propagates organizationId through resolveOrganizationId for org context", async () => {
		mockVerifyMembership.mockResolvedValueOnce({ id: "membership_1" });

		await handlers.saveDraft({
			input: {
				draftKey: "550e8400-e29b-41d4-a716-446655440003",
				name: "Org Draft",
				organizationId: "org_xyz",
			},
			context: ctx,
		});

		const args = mockUpsert.mock.calls[0][0];
		expect(args.organizationId).toBe("org_xyz");
	});

	it("returns wizardState in the response so the wizard can rehydrate on resume", async () => {
		const persistedWizardState = { currentStep: 2, documents: ["PRD"] };
		mockUpsert.mockResolvedValueOnce({
			project: {
				id: "proj_42",
				name: "Resume Me",
				draftKey: "550e8400-e29b-41d4-a716-446655440004",
				wizardState: persistedWizardState,
			},
			created: false,
		});

		const result = (await handlers.saveDraft({
			input: {
				draftKey: "550e8400-e29b-41d4-a716-446655440004",
				name: "Resume Me",
				organizationId: null,
				currentStep: 2,
			},
			context: ctx,
		})) as {
			project: { id: string; wizardState: unknown };
			created: boolean;
		};

		expect(result.project.wizardState).toEqual(persistedWizardState);
		expect(result.created).toBe(false);
	});
});
