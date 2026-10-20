/**
 * Nominations follow the bind refusal at the legacy Proposal action
 * (Fizzy #2946).
 *
 * Approving a nomination IS binding, so while the organization's Proposal
 * artifact is on, an organization nomination at `project_document_generator`
 * or `document_generator` for PROPOSAL is refused when it is proposed and when
 * it would be approved, with the same coded BAD_REQUEST as `bindings.set`.
 * SYSTEM nominations stay open, the approval judges the reviewer's final
 * action set by the nomination row's own organization, and a pending
 * nomination at the slot can still be declined.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	approvePromptNomination,
	createPromptNomination,
	declinePromptNomination,
	getBoundPromptVersion,
	getNominationById,
	isProposalArtifactEnabledForOrganization,
	requireOrganizationAdmin,
} = vi.hoisted(() => ({
	approvePromptNomination: vi.fn(),
	createPromptNomination: vi.fn(),
	declinePromptNomination: vi.fn(),
	getBoundPromptVersion: vi.fn(),
	getNominationById: vi.fn(),
	isProposalArtifactEnabledForOrganization: vi.fn(),
	requireOrganizationAdmin: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	approvePromptNomination,
	createPromptNomination,
	declinePromptNomination,
	getBoundPromptVersion,
	getNominationById,
	isProposalArtifactEnabledForOrganization,
	listPendingNominations: vi.fn().mockResolvedValue([]),
	withdrawPromptNomination: vi.fn(),
	listPromptDefaultAudience: vi.fn().mockResolvedValue([]),
	markOwnOverrides: vi.fn().mockResolvedValue([]),
	// The reviewing tier is notified on create; not this file's subject.
	listPromptNominationReviewers: vi.fn().mockResolvedValue([]),
	// A SYSTEM version: reachable by anyone, so only the rule under test can
	// refuse.
	db: {
		promptVersion: {
			findUnique: vi.fn().mockResolvedValue({
				id: "pv-1",
				scope: "SYSTEM",
				userId: null,
				organizationId: null,
				content: "A system prompt",
				prompt: { id: "prompt-1", name: "Example prompt" },
			}),
		},
		organization: { findUnique: vi.fn().mockResolvedValue(null) },
	},
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue({ role: "member" }),
}));

vi.mock("../../../lib/notification-service", () => ({
	fanOut: {
		promptDefaultUpdated: vi.fn(),
		promptNominationPending: vi.fn(),
	},
}));

vi.mock("../lib/nomination-summary", () => ({
	summariseNominationChange: vi
		.fn()
		.mockResolvedValue({ summary: "s", degraded: false }),
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_READ: "prompt:read", PROMPT_UPDATE: "prompt:update" },
	requirePermission: () => (next: unknown) => next,
	requireInputOrgPermission: () => (next: unknown) => next,
	requireOrganizationAdmin,
	resolveOrganizationId: (
		input: string | null | undefined,
		_session: unknown,
	) => input ?? null,
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

import { summariseNominationChange } from "../lib/nomination-summary";
import { nominateProcedures } from "../procedures/nominate";

type Handler = (a: unknown) => Promise<unknown>;

const ORG = "org-a";

const LEGACY_TARGET = {
	targetKey: "project_document_generator",
	documentType: "PROPOSAL",
	storyKind: null,
};
const UNREAD_LEGACY_TARGET = {
	targetKey: "document_generator",
	documentType: "PROPOSAL",
	storyKind: null,
};
const MAIN_TARGET = {
	targetKey: "proposal_client_main",
	documentType: "PROPOSAL",
	storyKind: null,
};
const PRD_TARGET = {
	targetKey: "project_document_generator",
	documentType: "PRD",
	storyKind: null,
};

const call = (
	procedure: keyof typeof nominateProcedures,
	input: Record<string, unknown>,
	user: { id?: string; role?: string | null } = {},
) =>
	(nominateProcedures[procedure] as unknown as Handler)({
		input,
		context: {
			user: { id: user.id ?? "user-1", role: user.role ?? null },
			session: {},
		},
	});

const nomination = (overrides: Record<string, unknown> = {}) => ({
	id: "nom-1",
	status: "PENDING",
	targetScope: "ORG",
	organizationId: ORG,
	promptVersionId: "pv-1",
	nominatedById: "member-1",
	targets: [MAIN_TARGET, LEGACY_TARGET],
	...overrides,
});

async function expectSupersededRefusal(pending: Promise<unknown>) {
	const refusal = await pending.catch((error: unknown) => error);
	expect(refusal).toBeInstanceOf(ORPCError);
	const error = refusal as ORPCError<string, { code?: string }>;
	expect(error.code).toBe("BAD_REQUEST");
	expect(error.data?.code).toBe("PROPOSAL_ACTION_SUPERSEDED");
	expect(error.message).toContain("Client proposal (Main)");
}

beforeEach(() => {
	vi.mocked(summariseNominationChange).mockClear();
	approvePromptNomination.mockReset();
	approvePromptNomination.mockResolvedValue({
		approved: { id: "nom-1" },
		supersededCount: 0,
	});
	createPromptNomination.mockReset();
	createPromptNomination.mockResolvedValue({ id: "nom-1" });
	declinePromptNomination.mockReset();
	declinePromptNomination.mockResolvedValue({ id: "nom-1" });
	getBoundPromptVersion.mockReset();
	getBoundPromptVersion.mockResolvedValue(null);
	getNominationById.mockReset();
	isProposalArtifactEnabledForOrganization.mockReset();
	isProposalArtifactEnabledForOrganization.mockResolvedValue(true);
	requireOrganizationAdmin.mockReset();
	requireOrganizationAdmin.mockResolvedValue(undefined);
});

describe("nominations.create at the legacy Proposal action", () => {
	it("refuses an organization nomination holding the slot, before the summary or the write", async () => {
		await expectSupersededRefusal(
			call("create", {
				promptVersionId: "pv-1",
				targetScope: "ORG",
				organizationId: ORG,
				targets: [MAIN_TARGET, LEGACY_TARGET],
			}),
		);

		expect(isProposalArtifactEnabledForOrganization).toHaveBeenCalledWith(
			ORG,
		);
		expect(getBoundPromptVersion).not.toHaveBeenCalled();
		expect(summariseNominationChange).not.toHaveBeenCalled();
		expect(createPromptNomination).not.toHaveBeenCalled();
	});

	it("refuses one at the unread document_generator Proposal action", async () => {
		await expectSupersededRefusal(
			call("create", {
				promptVersionId: "pv-1",
				targetScope: "ORG",
				organizationId: ORG,
				targets: [UNREAD_LEGACY_TARGET],
			}),
		);
		expect(createPromptNomination).not.toHaveBeenCalled();
	});

	it("accepts a system nomination at the slot", async () => {
		await call("create", {
			promptVersionId: "pv-1",
			targetScope: "SYSTEM",
			targets: [LEGACY_TARGET],
		});

		expect(isProposalArtifactEnabledForOrganization).not.toHaveBeenCalled();
		expect(createPromptNomination).toHaveBeenCalledWith(
			expect.objectContaining({ targetScope: "SYSTEM" }),
		);
	});

	it("accepts an organization nomination without a superseded action, without reading the gate", async () => {
		await call("create", {
			promptVersionId: "pv-1",
			targetScope: "ORG",
			organizationId: ORG,
			targets: [MAIN_TARGET, PRD_TARGET],
		});

		expect(isProposalArtifactEnabledForOrganization).not.toHaveBeenCalled();
		expect(createPromptNomination).toHaveBeenCalledWith(
			expect.objectContaining({
				targetScope: "ORG",
				organizationId: ORG,
			}),
		);
	});

	it("accepts an organization nomination at the slot while the gate is off", async () => {
		isProposalArtifactEnabledForOrganization.mockResolvedValue(false);

		await call("create", {
			promptVersionId: "pv-1",
			targetScope: "ORG",
			organizationId: ORG,
			targets: [LEGACY_TARGET],
		});

		expect(isProposalArtifactEnabledForOrganization).toHaveBeenCalledWith(
			ORG,
		);
		expect(createPromptNomination).toHaveBeenCalled();
	});
});

describe("nominations.approve at the legacy Proposal action", () => {
	it("refuses an organization nomination whose stored actions hold the slot", async () => {
		getNominationById.mockResolvedValue(nomination());

		await expectSupersededRefusal(
			call("approve", { nominationId: "nom-1", organizationId: ORG }),
		);

		// The ROW's organization, never one the caller sent.
		expect(isProposalArtifactEnabledForOrganization).toHaveBeenCalledWith(
			ORG,
		);
		expect(approvePromptNomination).not.toHaveBeenCalled();
	});

	it("approves when the reviewer's own action set leaves the slot out", async () => {
		getNominationById.mockResolvedValue(nomination());

		await call("approve", {
			nominationId: "nom-1",
			organizationId: ORG,
			targets: [MAIN_TARGET],
		});

		expect(isProposalArtifactEnabledForOrganization).not.toHaveBeenCalled();
		expect(approvePromptNomination).toHaveBeenCalledWith(
			expect.objectContaining({
				targets: [{ ...MAIN_TARGET, storyKind: null }],
				targetScope: "ORG",
				organizationId: ORG,
			}),
		);
	});

	it("refuses when the reviewer's own action set adds the slot", async () => {
		getNominationById.mockResolvedValue(
			nomination({ targets: [MAIN_TARGET] }),
		);

		await expectSupersededRefusal(
			call("approve", {
				nominationId: "nom-1",
				organizationId: ORG,
				targets: [MAIN_TARGET, UNREAD_LEGACY_TARGET],
			}),
		);
		expect(approvePromptNomination).not.toHaveBeenCalled();
	});

	it("approves a system nomination at the slot", async () => {
		getNominationById.mockResolvedValue(
			nomination({ targetScope: "SYSTEM", organizationId: null }),
		);

		await call("approve", { nominationId: "nom-1" }, { role: "admin" });

		expect(isProposalArtifactEnabledForOrganization).not.toHaveBeenCalled();
		expect(approvePromptNomination).toHaveBeenCalledWith(
			expect.objectContaining({ targetScope: "SYSTEM" }),
		);
	});

	it("approves an organization nomination at the slot while the gate is off", async () => {
		isProposalArtifactEnabledForOrganization.mockResolvedValue(false);
		getNominationById.mockResolvedValue(nomination());

		await call("approve", { nominationId: "nom-1", organizationId: ORG });

		expect(approvePromptNomination).toHaveBeenCalledWith(
			expect.objectContaining({
				targetScope: "ORG",
				organizationId: ORG,
			}),
		);
	});

	it("gives a caller who is not an org admin that refusal and reads nothing about the gate", async () => {
		getNominationById.mockResolvedValue(nomination());
		requireOrganizationAdmin.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "Not an admin" }),
		);

		const refusal = await call("approve", {
			nominationId: "nom-1",
			organizationId: ORG,
		}).catch((error: unknown) => error);

		expect((refusal as ORPCError<string, unknown>).code).toBe("FORBIDDEN");
		expect(isProposalArtifactEnabledForOrganization).not.toHaveBeenCalled();
		expect(approvePromptNomination).not.toHaveBeenCalled();
	});
});

describe("nominations.decline at the legacy Proposal action", () => {
	it("still declines a pending organization nomination at the slot", async () => {
		getNominationById.mockResolvedValue(nomination());

		await call("decline", { nominationId: "nom-1", organizationId: ORG });

		expect(declinePromptNomination).toHaveBeenCalledWith({
			nominationId: "nom-1",
			reviewedById: "user-1",
		});
		expect(isProposalArtifactEnabledForOrganization).not.toHaveBeenCalled();
	});
});
