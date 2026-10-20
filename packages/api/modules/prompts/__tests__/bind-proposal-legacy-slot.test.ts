/**
 * No new organization or project default at the legacy Proposal action while
 * the Proposal artifact is on (Fizzy #2946).
 *
 * A gate-on organization writes its Proposals from Client proposal (Main), so
 * a default at `project_document_generator`/PROPOSAL (or the unread
 * `document_generator`/PROPOSAL) would never run. The bind write refuses it
 * with a coded BAD_REQUEST naming Client proposal (Main). USER and SYSTEM
 * binds and `clear` stay open, the gate is read only when a target could be
 * superseded, and a caller without org-admin authority is refused before the
 * gate is read at all.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	bindPromptVersion,
	bindPromptVersionToTargets,
	clearPromptBinding,
	isProposalArtifactEnabledForOrganization,
	promptVersionFindUnique,
	projectFindFirst,
	requireOrganizationAdmin,
} = vi.hoisted(() => ({
	bindPromptVersion: vi.fn(),
	bindPromptVersionToTargets: vi.fn(),
	clearPromptBinding: vi.fn(),
	isProposalArtifactEnabledForOrganization: vi.fn(),
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
	isProposalArtifactEnabledForOrganization,
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

const LEGACY = "project_document_generator";
const UNREAD_LEGACY = "document_generator";
const MAIN = "proposal_client_main";
const ORG = "org-1";
const PROJECT = "proj-1";

type Scope = "SYSTEM" | "ORG" | "USER";

const context = (role: string | null = null) => ({
	user: { id: "user-1", role },
	session: {},
});

const callSet = (args: {
	targetKey: string;
	documentType?: string;
	scope: Scope;
	organizationId?: string | null;
	projectId?: string | null;
	isDefault?: boolean;
	role?: string | null;
}) =>
	(bindProcedures.set as (a: unknown) => Promise<unknown>)({
		input: {
			targetType: "AGENT",
			targetKey: args.targetKey,
			documentType: args.documentType ?? "PROPOSAL",
			storyKind: null,
			scope: args.scope,
			organizationId:
				args.organizationId === undefined ? ORG : args.organizationId,
			projectId: args.projectId ?? null,
			promptVersionId: "pv-1",
			isDefault: args.isDefault ?? true,
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
	projectId?: string | null;
}) =>
	(bindProcedures.setMany as (a: unknown) => Promise<unknown>)({
		input: {
			targets: args.targets,
			scope: args.scope,
			organizationId: ORG,
			projectId: args.projectId ?? null,
			promptVersionId: "pv-1",
			isDefault: true,
		},
		context: context(),
	});

const callClear = (args: { scope: Scope; projectId?: string | null }) =>
	(bindProcedures.clear as (a: unknown) => Promise<unknown>)({
		input: {
			targetType: "AGENT",
			targetKey: LEGACY,
			documentType: "PROPOSAL",
			storyKind: null,
			scope: args.scope,
			organizationId: ORG,
			projectId: args.projectId ?? null,
		},
		context: context(),
	});

async function expectSupersededRefusal(call: Promise<unknown>) {
	const refusal = await call.catch((error: unknown) => error);
	expect(refusal).toBeInstanceOf(ORPCError);
	const error = refusal as ORPCError<string, { code?: string }>;
	expect(error.code).toBe("BAD_REQUEST");
	expect(error.data?.code).toBe("PROPOSAL_ACTION_SUPERSEDED");
	expect(error.message).toContain("Client proposal (Main)");
}

describe("binding at the legacy Proposal action while the Proposal artifact is on", () => {
	beforeEach(() => {
		bindPromptVersion.mockReset();
		bindPromptVersion.mockResolvedValue({ id: "binding-1" });
		bindPromptVersionToTargets.mockReset();
		bindPromptVersionToTargets.mockResolvedValue({ bound: 2 });
		clearPromptBinding.mockReset();
		clearPromptBinding.mockResolvedValue({ cleared: true });
		isProposalArtifactEnabledForOrganization.mockReset();
		isProposalArtifactEnabledForOrganization.mockResolvedValue(true);
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
		projectFindFirst.mockResolvedValue({
			id: PROJECT,
			organizationId: ORG,
		});
		requireOrganizationAdmin.mockReset();
		requireOrganizationAdmin.mockResolvedValue(undefined);
	});

	describe("set", () => {
		it("refuses an organization default at the legacy action, before any write", async () => {
			await expectSupersededRefusal(
				callSet({ targetKey: LEGACY, scope: "ORG" }),
			);
			expect(
				isProposalArtifactEnabledForOrganization,
			).toHaveBeenCalledWith(ORG);
			expect(promptVersionFindUnique).not.toHaveBeenCalled();
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("refuses an organization default at the unread document_generator Proposal action", async () => {
			await expectSupersededRefusal(
				callSet({ targetKey: UNREAD_LEGACY, scope: "ORG" }),
			);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("refuses it even when the binding is not marked default", async () => {
			await expectSupersededRefusal(
				callSet({ targetKey: LEGACY, scope: "ORG", isDefault: false }),
			);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("refuses a project default at the legacy action, judged by the project's own organization", async () => {
			await expectSupersededRefusal(
				callSet({
					targetKey: LEGACY,
					scope: "ORG",
					projectId: PROJECT,
				}),
			);
			expect(projectFindFirst).toHaveBeenCalled();
			expect(
				isProposalArtifactEnabledForOrganization,
			).toHaveBeenCalledWith(ORG);
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("accepts a personal default at the legacy action", async () => {
			await callSet({ targetKey: LEGACY, scope: "USER" });

			expect(bindPromptVersion).toHaveBeenCalledWith(
				expect.objectContaining({
					targetKey: LEGACY,
					scope: "USER",
					userId: "user-1",
				}),
			);
		});

		it("accepts the system default at the legacy action from a platform admin", async () => {
			await callSet({
				targetKey: LEGACY,
				scope: "SYSTEM",
				organizationId: null,
				role: "admin",
			});

			expect(bindPromptVersion).toHaveBeenCalledWith(
				expect.objectContaining({ targetKey: LEGACY, scope: "SYSTEM" }),
			);
		});

		it.each([
			[MAIN, "PROPOSAL"],
			[LEGACY, "PRD"],
		])(
			"accepts an organization default at %s/%s without reading the gate",
			async (targetKey, documentType) => {
				await callSet({ targetKey, documentType, scope: "ORG" });

				expect(
					isProposalArtifactEnabledForOrganization,
				).not.toHaveBeenCalled();
				expect(bindPromptVersion).toHaveBeenCalledWith(
					expect.objectContaining({
						targetKey,
						documentType,
						scope: "ORG",
						organizationId: ORG,
					}),
				);
			},
		);

		it("accepts an organization or project default at the legacy action while the gate is off", async () => {
			isProposalArtifactEnabledForOrganization.mockResolvedValue(false);

			await callSet({ targetKey: LEGACY, scope: "ORG" });
			await callSet({
				targetKey: LEGACY,
				scope: "ORG",
				projectId: PROJECT,
			});

			expect(
				isProposalArtifactEnabledForOrganization,
			).toHaveBeenCalledWith(ORG);
			expect(bindPromptVersion).toHaveBeenCalledTimes(2);
			expect(bindPromptVersion).toHaveBeenLastCalledWith(
				expect.objectContaining({
					targetKey: LEGACY,
					scope: "ORG",
					organizationId: ORG,
					projectId: PROJECT,
				}),
			);
		});

		it("gives a caller who is not an org admin that refusal and reads nothing about the gate", async () => {
			requireOrganizationAdmin.mockRejectedValue(
				new ORPCError("FORBIDDEN", { message: "Not an admin" }),
			);

			const refusal = await callSet({
				targetKey: LEGACY,
				scope: "ORG",
			}).catch((error: unknown) => error);

			expect((refusal as ORPCError<string, unknown>).code).toBe(
				"FORBIDDEN",
			);
			expect(
				isProposalArtifactEnabledForOrganization,
			).not.toHaveBeenCalled();
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});

		it("gives a project of another organization the project refusal and reads nothing about the gate", async () => {
			projectFindFirst.mockResolvedValue({
				id: PROJECT,
				organizationId: "org-2",
			});

			await expect(
				callSet({
					targetKey: LEGACY,
					scope: "ORG",
					projectId: PROJECT,
				}),
			).rejects.toThrow(/does not belong to this organization/i);
			expect(
				isProposalArtifactEnabledForOrganization,
			).not.toHaveBeenCalled();
			expect(bindPromptVersion).not.toHaveBeenCalled();
		});
	});

	describe("setMany", () => {
		it("refuses the whole request when the legacy action is among organization targets", async () => {
			await expectSupersededRefusal(
				callSetMany({
					targets: [
						target(MAIN),
						target(LEGACY),
						target(LEGACY, "PRD"),
					],
					scope: "ORG",
				}),
			);
			expect(bindPromptVersionToTargets).not.toHaveBeenCalled();
		});

		it("refuses the whole request at the project tier", async () => {
			await expectSupersededRefusal(
				callSetMany({
					targets: [target(LEGACY, "PRD"), target(UNREAD_LEGACY)],
					scope: "ORG",
					projectId: PROJECT,
				}),
			);
			expect(bindPromptVersionToTargets).not.toHaveBeenCalled();
		});

		it("binds organization targets that do not include a superseded action, without reading the gate", async () => {
			await callSetMany({
				targets: [target(MAIN), target(LEGACY, "PRD")],
				scope: "ORG",
			});

			expect(
				isProposalArtifactEnabledForOrganization,
			).not.toHaveBeenCalled();
			expect(bindPromptVersionToTargets).toHaveBeenCalledWith(
				expect.objectContaining({ scope: "ORG", organizationId: ORG }),
			);
		});

		it("binds personal targets that include the legacy action", async () => {
			await callSetMany({
				targets: [target(LEGACY), target(LEGACY, "PRD")],
				scope: "USER",
			});

			expect(
				isProposalArtifactEnabledForOrganization,
			).not.toHaveBeenCalled();
			expect(bindPromptVersionToTargets).toHaveBeenCalledWith(
				expect.objectContaining({ scope: "USER", userId: "user-1" }),
			);
		});

		it("binds the legacy action among organization targets while the gate is off", async () => {
			isProposalArtifactEnabledForOrganization.mockResolvedValue(false);

			await callSetMany({
				targets: [target(MAIN), target(LEGACY)],
				scope: "ORG",
			});

			expect(
				isProposalArtifactEnabledForOrganization,
			).toHaveBeenCalledWith(ORG);
			expect(bindPromptVersionToTargets).toHaveBeenCalledWith(
				expect.objectContaining({ scope: "ORG", organizationId: ORG }),
			);
		});
	});

	describe("clear", () => {
		it.each([
			["the organization", null],
			["a project", PROJECT],
		])(
			"still clears %s default at the legacy action, so nothing is stranded",
			async (_tier, projectId) => {
				await callClear({ scope: "ORG", projectId });

				expect(clearPromptBinding).toHaveBeenCalledWith(
					expect.objectContaining({
						targetKey: LEGACY,
						documentType: "PROPOSAL",
						scope: "ORG",
						organizationId: ORG,
						projectId,
					}),
				);
				expect(
					isProposalArtifactEnabledForOrganization,
				).not.toHaveBeenCalled();
			},
		);
	});
});
