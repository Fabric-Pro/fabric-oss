import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	accessDb,
	describeProjectAccess,
	grantProjectAccess,
	guest,
	installProjectRows,
	organizationId,
	otherOrganizationId,
	type ProjectTestContext,
	projectAccessQuery,
	projectId,
	projectOwner,
	projectProcedureTestExports,
	projectWhere,
	userId,
} from "./support/project-access";

const mocks = vi.hoisted(() => ({
	prior: vi.fn(),
	decisionType: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	remove: vi.fn(),
	revert: vi.fn(),
	acknowledge: vi.fn(),
	pin: vi.fn(),
	vouch: vi.fn(),
	ensureType: vi.fn(),
	listSuperseded: vi.fn(),
	resolveIdentifiers: vi.fn(),
	isProjectMember: vi.fn(),
	notifyOwner: vi.fn(),
	removeContext: vi.fn(),
	syncContext: vi.fn(),
	emitActivity: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	return {
		db: {
			...accessDb,
			architectureDecision: { findFirst: mocks.prior },
			decisionType: { findFirst: mocks.decisionType },
		},
		grantProjectAccess,
		getOrganizationMembership: vi.fn(),
		getTenantContext: () => ({}),
		hasProjectAccess: await projectAccessQuery(),
		listArchitectureDecisions: mocks.list,
		getArchitectureDecision: mocks.get,
		createArchitectureDecision: mocks.create,
		updateArchitectureDecision: mocks.update,
		softDeleteArchitectureDecision: mocks.remove,
		revertArchitectureDecisionToVersion: mocks.revert,
		acknowledgeArchitectureDecision: mocks.acknowledge,
		setArchitectureDecisionPinned: mocks.pin,
		setArchitectureDecisionVouched: mocks.vouch,
		ensureDecisionType: mocks.ensureType,
		listSupersededIdentifiers: mocks.listSuperseded,
		resolveArchitectureDecisionIdentifiers: mocks.resolveIdentifiers,
	};
});

vi.mock("../../../../orpc/procedures", () => projectProcedureTestExports());

vi.mock("../../../../lib/realtime", () => ({
	emitActivity: mocks.emitActivity,
}));
vi.mock("../../lib/architecture-decision-context", () => ({
	buildArchitectureDecisionContextContent: () => "Example decision content",
	removeArchitectureDecisionContext: mocks.removeContext,
	resolveParticipantNames: async () => [],
	resolveParticipants: async () => [],
	syncArchitectureDecisionContext: mocks.syncContext,
}));
vi.mock("../../lib/decision-owner", () => ({
	isActiveProjectMember: mocks.isProjectMember,
	notifyDecisionOwner: mocks.notifyOwner,
}));

import {
	acknowledgeArchitectureDecisionProcedure,
	createArchitectureDecisionProcedure,
	deleteArchitectureDecisionProcedure,
	getArchitectureDecisionProcedure,
	listArchitectureDecisionsProcedure,
	pinArchitectureDecisionProcedure,
	revertArchitectureDecisionVersionProcedure,
	updateArchitectureDecisionProcedure,
	vouchArchitectureDecisionProcedure,
} from "../architecture-decisions/crud";

const id = "example-decision";
const decisionWhere = { ...projectWhere, id };
const decision = {
	...decisionWhere,
	identifier: "ADR-001",
	title: "Example decision",
	decision: "Keep decision history",
	status: "PROPOSED",
	ownerUserId: null,
	contextId: "example-context",
	participantUserIds: [],
	supersededById: null,
	relatedDecisionIds: [],
	vouchedById: null,
};
const decisionTypeId = "example-type";
const createInput = {
	...projectWhere,
	title: decision.title,
	decision: decision.decision,
	decisionTypeId,
	duration: "LONG_STANDING" as const,
};
const updateInput = { ...decisionWhere, title: "Edited decision" };
const revertInput = { ...decisionWhere, version: 2 };
const pinInput = { ...decisionWhere, pinned: true };
const vouchInput = { ...decisionWhere, vouched: true };

const requests = [
	{
		name: "list decisions",
		run: (context: ProjectTestContext) =>
			call(listArchitectureDecisionsProcedure, projectWhere, { context }),
	},
	{
		name: "get decision",
		run: (context: ProjectTestContext) =>
			call(getArchitectureDecisionProcedure, decisionWhere, { context }),
	},
	{
		name: "create decision",
		write: true,
		run: (context: ProjectTestContext) =>
			call(createArchitectureDecisionProcedure, createInput, { context }),
	},
	{
		name: "update decision",
		write: true,
		run: (context: ProjectTestContext) =>
			call(updateArchitectureDecisionProcedure, updateInput, { context }),
	},
	{
		name: "delete decision",
		write: true,
		run: (context: ProjectTestContext) =>
			call(deleteArchitectureDecisionProcedure, decisionWhere, {
				context,
			}),
	},
	{
		name: "revert decision",
		write: true,
		run: (context: ProjectTestContext) =>
			call(revertArchitectureDecisionVersionProcedure, revertInput, {
				context,
			}),
	},
	{
		name: "acknowledge owned decision",
		run: (context: ProjectTestContext) =>
			call(acknowledgeArchitectureDecisionProcedure, decisionWhere, {
				context,
			}),
	},
	{
		name: "pin decision",
		write: true,
		run: (context: ProjectTestContext) =>
			call(pinArchitectureDecisionProcedure, pinInput, { context }),
	},
	{
		name: "vouch for decision",
		write: true,
		run: (context: ProjectTestContext) =>
			call(vouchArchitectureDecisionProcedure, vouchInput, { context }),
	},
];

beforeEach(() => {
	vi.resetAllMocks();
	installProjectRows({ role: "PROJECT_ADMIN" });
	mocks.prior.mockResolvedValue(decision);
	mocks.decisionType.mockResolvedValue({ id: decisionTypeId });
	mocks.list.mockResolvedValue({ items: [decision], total: 1 });
	mocks.get.mockResolvedValue(decision);
	mocks.create.mockResolvedValue(decision);
	mocks.update.mockResolvedValue({ ...decision, title: updateInput.title });
	mocks.remove.mockResolvedValue(decision);
	mocks.revert.mockResolvedValue(decision);
	mocks.acknowledge.mockResolvedValue({ ...decision, ownerUserId: userId });
	mocks.pin.mockResolvedValue({ ...decision, pinned: true });
	mocks.vouch.mockResolvedValue({ ...decision, vouchedById: userId });
	mocks.listSuperseded.mockResolvedValue([]);
	mocks.resolveIdentifiers.mockResolvedValue([]);
});

describeProjectAccess(requests, () => {
	for (const effect of Object.values(mocks)) {
		expect(effect).not.toHaveBeenCalled();
	}
});

describe("architecture decision outcomes", () => {
	it("lists project decisions for an invited viewer", async () => {
		installProjectRows({ role: "VIEWER" });
		await expect(
			call(listArchitectureDecisionsProcedure, projectWhere, {
				context: guest(),
			}),
		).resolves.toEqual({
			items: [
				{
					...decision,
					participants: [],
					participantNames: [],
					owner: null,
				},
			],
			total: 1,
		});
		expect(mocks.list).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining(projectWhere),
		);
		expect(grantProjectAccess).toHaveBeenCalledWith(
			projectId,
			organizationId,
		);
	});

	it("returns one scoped decision to an invited viewer", async () => {
		installProjectRows({ role: "VIEWER" });
		await expect(
			call(getArchitectureDecisionProcedure, decisionWhere, {
				context: guest(),
			}),
		).resolves.toEqual({
			decision: {
				...decision,
				participants: [],
				participantNames: [],
				owner: null,
				supersededBy: null,
				vouchedByName: null,
			},
		});
		expect(mocks.get).toHaveBeenCalledExactlyOnceWith(decisionWhere);
	});

	it("creates and synchronizes the decision under the project host organization", async () => {
		await expect(
			call(createArchitectureDecisionProcedure, createInput, {
				context: guest(),
			}),
		).resolves.toEqual({ decision });
		expect(mocks.decisionType).toHaveBeenCalledExactlyOnceWith({
			where: { id: decisionTypeId, projectId },
			select: { id: true },
		});
		expect(mocks.create).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				...createInput,
				userId,
				organizationId,
				createdById: userId,
			}),
		);
		expect(mocks.syncContext).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				projectId,
				decisionId: id,
				userId,
				organizationId,
			}),
		);
	});

	it("refuses a decision type that is outside the project", async () => {
		mocks.decisionType.mockResolvedValue(null);
		await expect(
			call(createArchitectureDecisionProcedure, createInput, {
				context: guest(),
			}),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "Unknown decision type",
		});
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.syncContext).not.toHaveBeenCalled();
	});

	it("refuses a decision owner who is outside the project", async () => {
		mocks.isProjectMember.mockResolvedValue(false);
		await expect(
			call(
				createArchitectureDecisionProcedure,
				{ ...createInput, ownerUserId: "example-outsider" },
				{ context: guest() },
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "The owner must be a member of this project",
		});
		expect(mocks.isProjectMember).toHaveBeenCalledExactlyOnceWith(
			projectId,
			"example-outsider",
		);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.notifyOwner).not.toHaveBeenCalled();
	});

	it("refuses a caller-selected organization on a legitimate project", async () => {
		installProjectRows({ localMember: true });
		await expect(
			call(
				createArchitectureDecisionProcedure,
				{
					...createInput,
					organizationId: otherOrganizationId,
				},
				{ context: projectOwner() },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.decisionType).not.toHaveBeenCalled();
	});

	it("updates the scoped decision and synchronizes its new content", async () => {
		const updated = { ...decision, title: updateInput.title };
		await expect(
			call(updateArchitectureDecisionProcedure, updateInput, {
				context: guest(),
			}),
		).resolves.toEqual({ decision: updated });
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				...decisionWhere,
				editedById: userId,
				data: expect.objectContaining({ title: updateInput.title }),
			}),
		);
		expect(mocks.syncContext).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				projectId,
				decisionId: id,
				organizationId,
				sourceTitle: `${decision.identifier} ${updateInput.title}`,
			}),
		);
	});

	it("returns not found for a foreign decision within a visible project without updating context", async () => {
		mocks.prior.mockResolvedValue(null);
		mocks.update.mockResolvedValue(null);
		await expect(
			call(updateArchitectureDecisionProcedure, updateInput, {
				context: guest(),
			}),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Architecture decision not found",
		});
		expect(mocks.syncContext).not.toHaveBeenCalled();
		expect(mocks.notifyOwner).not.toHaveBeenCalled();
	});

	it("deletes the scoped decision and removes its context", async () => {
		await expect(
			call(deleteArchitectureDecisionProcedure, decisionWhere, {
				context: guest(),
			}),
		).resolves.toEqual({ success: true });
		expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(decisionWhere);
		expect(mocks.removeContext).toHaveBeenCalledExactlyOnceWith({
			projectId,
			contextId: decision.contextId,
			userId,
			organizationId,
		});
	});

	it("restores a scoped version and clears ownership if the restored owner has left", async () => {
		const restored = { ...decision, ownerUserId: "example-former-member" };
		mocks.revert.mockResolvedValue(restored);
		mocks.isProjectMember.mockResolvedValue(false);
		mocks.update.mockResolvedValue(decision);
		await expect(
			call(revertArchitectureDecisionVersionProcedure, revertInput, {
				context: guest(),
			}),
		).resolves.toEqual({ decision });
		expect(mocks.revert).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ ...revertInput, editedById: userId }),
		);
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				...decisionWhere,
				data: { ownerUserId: null },
			}),
		);
	});

	it("lets an invited viewer acknowledge a decision they own", async () => {
		installProjectRows({ role: "VIEWER" });
		await expect(
			call(acknowledgeArchitectureDecisionProcedure, decisionWhere, {
				context: guest(),
			}),
		).resolves.toEqual({
			decision: { ...decision, ownerUserId: userId },
		});
		expect(mocks.acknowledge).toHaveBeenCalledExactlyOnceWith({
			...decisionWhere,
			ownerUserId: userId,
		});
	});

	it("refuses acknowledgement when the scoped owner write finds no row", async () => {
		mocks.acknowledge.mockResolvedValue(null);
		await expect(
			call(acknowledgeArchitectureDecisionProcedure, decisionWhere, {
				context: guest(),
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Only the decision's owner can acknowledge it",
		});
		expect(mocks.emitActivity).not.toHaveBeenCalled();
	});

	it("pins the decision in the requested project", async () => {
		await expect(
			call(pinArchitectureDecisionProcedure, pinInput, {
				context: guest(),
			}),
		).resolves.toEqual({
			decision: { ...decision, pinned: true },
		});
		expect(mocks.pin).toHaveBeenCalledExactlyOnceWith(pinInput);
	});

	it("records the authenticated actor as the endorser and refreshes the decision context", async () => {
		await expect(
			call(vouchArchitectureDecisionProcedure, vouchInput, {
				context: guest(),
			}),
		).resolves.toEqual({
			decision: { ...decision, vouchedById: userId },
		});
		expect(mocks.vouch).toHaveBeenCalledExactlyOnceWith({
			...vouchInput,
			vouchedById: userId,
		});
		expect(mocks.syncContext).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				projectId,
				decisionId: id,
				userId,
				organizationId,
			}),
		);
	});
});
