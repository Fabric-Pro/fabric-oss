/**
 * No personal default for the client-only Main prompt (Fizzy #2801).
 *
 * A personal (USER) binding outranks the organization's at resolution, so a
 * personal prompt on `proposal_client_main` would let one member decide what
 * every client of theirs reads, internal notes included. The refusal sits on
 * the write: precedence and every reader are unchanged. These pin that both
 * write paths refuse it, and that nothing else about binding moved.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	bindPromptVersion,
	bindPromptVersionToTargets,
	clearPromptBinding,
	promptVersionFindUnique,
	projectFindFirst,
	requireOrganizationAdmin,
} = vi.hoisted(() => ({
	bindPromptVersion: vi.fn(),
	bindPromptVersionToTargets: vi.fn(),
	clearPromptBinding: vi.fn(),
	promptVersionFindUnique: vi.fn(),
	projectFindFirst: vi.fn(),
	requireOrganizationAdmin: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listPromptDefaultAudience: vi.fn().mockResolvedValue([]),
	markOwnOverrides: vi.fn().mockResolvedValue([]),
	bindPromptVersion,
	bindPromptVersionToTargets,
	clearPromptBinding,
	listActionsForPrompt: vi.fn(),
	listPromptsForStages: vi.fn(),
	db: {
		promptVersion: { findUnique: promptVersionFindUnique },
		project: { findFirst: projectFindFirst },
	},
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));

// Binding announces the change to whoever is subject to it; not under test here.
vi.mock("../../../lib/notification-service", () => ({
	fanOut: { promptDefaultUpdated: vi.fn() },
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_READ: "prompt:read", PROMPT_UPDATE: "prompt:update" },
	requirePermission: () => (next: unknown) => next,
	requireInputOrgPermission: () => (next: unknown) => next,
	requireOrganizationAdmin,
	resolveOrganizationId: (input: string | null | undefined) => input ?? null,
	tenantProtectedProcedure: {
		use: () => ({
			route: () => ({
				input: () => ({
					output: () => ({ handler: (fn: unknown) => fn }),
				}),
			}),
		}),
	},
}));

import { bindProcedures } from "../procedures/bind";

const MAIN = "proposal_client_main";
const ANALYSIS = "proposal_internal_analysis";

type Scope = "SYSTEM" | "ORG" | "USER";

const context = (role: string | null = null) => ({
	user: { id: "user-1", role },
	session: {},
});

const callSet = (args: {
	targetKey: string;
	scope: Scope;
	organizationId?: string | null;
	role?: string | null;
}) =>
	(bindProcedures.set as (a: unknown) => Promise<unknown>)({
		input: {
			targetType: "AGENT",
			targetKey: args.targetKey,
			documentType: "PROPOSAL",
			storyKind: null,
			scope: args.scope,
			organizationId: args.organizationId ?? null,
			projectId: null,
			promptVersionId: "pv-1",
			isDefault: true,
		},
		context: context(args.role),
	});

const target = (targetKey: string, documentType = "PROPOSAL") => ({
	targetType: "AGENT" as const,
	targetKey,
	documentType,
	storyKind: null,
});

const callSetMany = (args: {
	targets: ReturnType<typeof target>[];
	scope: Scope;
	organizationId?: string | null;
}) =>
	(bindProcedures.setMany as (a: unknown) => Promise<unknown>)({
		input: {
			targets: args.targets,
			scope: args.scope,
			organizationId: args.organizationId ?? null,
			promptVersionId: "pv-1",
			isDefault: true,
		},
		context: context(),
	});

const callClear = (args: { targetKey: string; scope: Scope }) =>
	(bindProcedures.clear as (a: unknown) => Promise<unknown>)({
		input: {
			targetType: "AGENT",
			targetKey: args.targetKey,
			documentType: "PROPOSAL",
			storyKind: null,
			scope: args.scope,
			organizationId: null,
			projectId: null,
		},
		context: context(),
	});

describe("binding the client-only Main proposal prompt", () => {
	beforeEach(() => {
		bindPromptVersion.mockReset();
		bindPromptVersion.mockResolvedValue({ id: "binding-1" });
		bindPromptVersionToTargets.mockReset();
		bindPromptVersionToTargets.mockResolvedValue({ bound: 2 });
		clearPromptBinding.mockReset();
		clearPromptBinding.mockResolvedValue({ cleared: false });
		promptVersionFindUnique.mockReset();
		// A SYSTEM version: reachable by everyone, and suitable at every tier,
		// so only the rule under test can refuse.
		promptVersionFindUnique.mockResolvedValue({
			scope: "SYSTEM",
			userId: null,
			organizationId: null,
			content: "A system prompt",
		});
		projectFindFirst.mockReset();
		requireOrganizationAdmin.mockReset();
		requireOrganizationAdmin.mockResolvedValue(undefined);
	});

	describe("set", () => {
		it("refuses a personal default on the Main action, before any write", async () => {
			const refusal = await callSet({
				targetKey: MAIN,
				scope: "USER",
			}).catch((error: unknown) => error);

			expect(refusal).toBeInstanceOf(ORPCError);
			expect((refusal as ORPCError<string, unknown>).code).toBe(
				"BAD_REQUEST",
			);
			expect((refusal as Error).message).toMatch(/personal default/i);
			expect((refusal as Error).message).toMatch(/organization admin/i);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("accepts a personal default on the analysis action", async () => {
			await callSet({ targetKey: ANALYSIS, scope: "USER" });

			expect(bindPromptVersion).toHaveBeenCalledWith(
				expect.objectContaining({
					targetKey: ANALYSIS,
					scope: "USER",
					userId: "user-1",
				}),
			);
		});

		it("accepts an organization default on the Main action from an org admin", async () => {
			await callSet({
				targetKey: MAIN,
				scope: "ORG",
				organizationId: "org-1",
			});

			expect(requireOrganizationAdmin).toHaveBeenCalledWith(
				"org-1",
				"user-1",
			);
			expect(bindPromptVersion).toHaveBeenCalledWith(
				expect.objectContaining({
					targetKey: MAIN,
					scope: "ORG",
					organizationId: "org-1",
				}),
			);
		});

		it("still requires an org admin for the organization default on the Main action", async () => {
			requireOrganizationAdmin.mockRejectedValue(new Error("FORBIDDEN"));

			await expect(
				callSet({
					targetKey: MAIN,
					scope: "ORG",
					organizationId: "org-1",
				}),
			).rejects.toThrow("FORBIDDEN");
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("accepts the system default on the Main action from a platform admin", async () => {
			await callSet({ targetKey: MAIN, scope: "SYSTEM", role: "admin" });

			expect(bindPromptVersion).toHaveBeenCalledWith(
				expect.objectContaining({ targetKey: MAIN, scope: "SYSTEM" }),
			);
		});

		it("leaves personal defaults on the Draft flow's PROPOSAL action as they were", async () => {
			await callSet({
				targetKey: "project_document_generator",
				scope: "USER",
			});

			expect(bindPromptVersion).toHaveBeenCalledWith(
				expect.objectContaining({
					targetKey: "project_document_generator",
					scope: "USER",
				}),
			);
		});
	});

	describe("setMany", () => {
		it("refuses the whole request when the Main action is among personal targets", async () => {
			await expect(
				callSetMany({
					targets: [target(ANALYSIS), target(MAIN)],
					scope: "USER",
				}),
			).rejects.toThrow(/personal default/i);
			expect(bindPromptVersionToTargets).not.toHaveBeenCalled();
		});

		it("binds personal targets that do not include the Main action", async () => {
			await callSetMany({
				targets: [
					target(ANALYSIS),
					target("project_document_generator"),
				],
				scope: "USER",
			});

			expect(bindPromptVersionToTargets).toHaveBeenCalledWith(
				expect.objectContaining({ scope: "USER", userId: "user-1" }),
			);
		});

		it("binds the Main action among organization targets", async () => {
			await callSetMany({
				targets: [target(MAIN), target(ANALYSIS)],
				scope: "ORG",
				organizationId: "org-1",
			});

			expect(bindPromptVersionToTargets).toHaveBeenCalledWith(
				expect.objectContaining({
					scope: "ORG",
					organizationId: "org-1",
				}),
			);
		});
	});

	describe("clear", () => {
		it("still lets a member clear a personal binding on the Main action", async () => {
			// Clearing takes a personal row out of force however it got there;
			// refusing it could only strand one.
			await callClear({ targetKey: MAIN, scope: "USER" });

			expect(clearPromptBinding).toHaveBeenCalledWith(
				expect.objectContaining({
					targetKey: MAIN,
					scope: "USER",
					userId: "user-1",
				}),
			);
		});
	});
});
