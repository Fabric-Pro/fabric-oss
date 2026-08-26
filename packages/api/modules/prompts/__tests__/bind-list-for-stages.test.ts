import { beforeEach, describe, expect, it, vi } from "vitest";

const { listPromptsForStages, verifyOrganizationMembership } = vi.hoisted(
	() => ({
		listPromptsForStages: vi.fn(),
		verifyOrganizationMembership: vi.fn(),
	}),
);

vi.mock("@repo/database", () => ({
	listPromptDefaultRecipients: vi.fn().mockResolvedValue([]),
	listPromptsForStages,
	bindPromptVersion: vi.fn(),
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership,
}));

// Binding announces the change to whoever is subject to it; not under test here.
vi.mock("../../../lib/notification-service", () => ({
	fanOut: { promptDefaultUpdated: vi.fn() },
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_READ: "prompt:read", PROMPT_UPDATE: "prompt:update" },
	requirePermission: () => (next: unknown) => next,
	requireInputOrgPermission: () => (next: unknown) => next,
	resolveOrganizationId: (
		input: string | null | undefined,
		_session: unknown,
	) => input ?? null,
	tenantProtectedProcedure: {
		use: () => ({
			route: () => ({
				input: () => ({
					output: () => ({
						handler: (fn: unknown) => fn,
					}),
				}),
			}),
		}),
	},
}));

import { bindProcedures } from "../procedures/bind";

const STAGES = ["PLACEHOLDER", "ACTIVE_ANALYSIS", "SANITY_CHECK", "DRAFT"];

describe("prompts.bind.listForStages procedure", () => {
	beforeEach(() => {
		listPromptsForStages.mockReset();
		verifyOrganizationMembership.mockReset();
		verifyOrganizationMembership.mockResolvedValue({
			organizationId: "org-1",
			userId: "user-1",
			role: "member",
		});
	});

	it("is registered on bindProcedures", () => {
		expect(bindProcedures.listForStages).toBeTypeOf("function");
	});

	it("delegates to listPromptsForStages with resolved org id", async () => {
		listPromptsForStages.mockResolvedValue([]);

		await (
			bindProcedures.listForStages as (args: unknown) => Promise<unknown>
		)({
			input: {
				targetType: "AGENT",
				targetKey: "project_document_generator",
				documentTypes: STAGES,
				organizationId: "org-1",
			},
			context: {
				user: { id: "user-1" },
				session: {},
			},
		});

		expect(listPromptsForStages).toHaveBeenCalledWith({
			agentName: "project_document_generator",
			documentTypes: STAGES,
			// Procedure defaults storyKind to null when omitted from input.
			storyKind: null,
			userId: "user-1",
			organizationId: "org-1",
			// Both added by the project prompt tier (#3178): the procedure
			// always forwards them, null and undefined included, so the
			// resolver sees one argument shape rather than two.
			projectId: null,
			scope: undefined,
		});
	});

	it("passes organizationId: null for personal context", async () => {
		listPromptsForStages.mockResolvedValue([]);

		await (
			bindProcedures.listForStages as (args: unknown) => Promise<unknown>
		)({
			input: {
				targetType: "AGENT",
				targetKey: "project_document_generator",
				documentTypes: STAGES,
				organizationId: null,
			},
			context: {
				user: { id: "user-1" },
				session: {},
			},
		});

		expect(listPromptsForStages).toHaveBeenCalledWith({
			agentName: "project_document_generator",
			documentTypes: STAGES,
			storyKind: null,
			userId: "user-1",
			organizationId: null,
			projectId: null,
			scope: undefined,
		});
	});

	it("forwards the scope filter when provided", async () => {
		listPromptsForStages.mockResolvedValue([]);

		await (
			bindProcedures.listForStages as (args: unknown) => Promise<unknown>
		)({
			input: {
				targetType: "AGENT",
				targetKey: "project_document_generator",
				documentTypes: STAGES,
				organizationId: "org-1",
				scope: "ORG",
			},
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(listPromptsForStages).toHaveBeenCalledWith({
			agentName: "project_document_generator",
			documentTypes: STAGES,
			storyKind: null,
			userId: "user-1",
			organizationId: "org-1",
			projectId: null,
			scope: "ORG",
		});
	});

	it("verifies org membership before querying when organizationId is set", async () => {
		listPromptsForStages.mockResolvedValue([]);

		await (
			bindProcedures.listForStages as (args: unknown) => Promise<unknown>
		)({
			input: {
				targetType: "AGENT",
				targetKey: "project_document_generator",
				documentTypes: STAGES,
				organizationId: "org-1",
			},
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(verifyOrganizationMembership).toHaveBeenCalledWith(
			"org-1",
			"user-1",
		);
	});

	it("throws FORBIDDEN when the caller is not a member of the requested org", async () => {
		verifyOrganizationMembership.mockResolvedValue(null);

		await expect(
			(
				bindProcedures.listForStages as (
					args: unknown,
				) => Promise<unknown>
			)({
				input: {
					targetType: "AGENT",
					targetKey: "project_document_generator",
					documentTypes: STAGES,
					organizationId: "other-org",
				},
				context: { user: { id: "user-1" }, session: {} },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(listPromptsForStages).not.toHaveBeenCalled();
	});

	it("skips the membership check in personal context", async () => {
		listPromptsForStages.mockResolvedValue([]);

		await (
			bindProcedures.listForStages as (args: unknown) => Promise<unknown>
		)({
			input: {
				targetType: "AGENT",
				targetKey: "project_document_generator",
				documentTypes: STAGES,
				organizationId: null,
			},
			context: { user: { id: "user-1" }, session: {} },
		});

		expect(verifyOrganizationMembership).not.toHaveBeenCalled();
	});

	it("returns the array shape unchanged from the query", async () => {
		const payload = STAGES.map((documentType) => ({
			documentType,
			bindings: [],
		}));
		listPromptsForStages.mockResolvedValue(payload);

		const result = await (
			bindProcedures.listForStages as (args: unknown) => Promise<unknown>
		)({
			input: {
				targetType: "AGENT",
				targetKey: "project_document_generator",
				documentTypes: STAGES,
				organizationId: null,
			},
			context: { user: { id: "u" }, session: {} },
		});

		expect(result).toEqual(payload);
	});
});
