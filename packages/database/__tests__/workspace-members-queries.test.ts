import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
	const group = () => ({
		findFirst: vi.fn(),
		findMany: vi.fn(),
		create: vi.fn(),
		delete: vi.fn(),
		deleteMany: vi.fn(),
	});
	return {
		workspace: { findFirst: vi.fn(), findUnique: vi.fn() },
		member: { findFirst: vi.fn(), findMany: vi.fn() },
		user: { findMany: vi.fn() },
		workspaceAdministrator: group(),
		workspaceContributor: group(),
		workspaceStakeholder: group(),
		workspaceAgent: group(),
		$transaction: vi.fn(),
	};
});
vi.mock("../prisma/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../prisma/client")>()),
	db,
}));

import {
	addWorkspaceAgent,
	addWorkspaceMember,
	changeWorkspaceMemberGroup,
	getUserWorkspaceGroup,
	getWorkspaceMembers,
	hasAgentWorkspaceAccess,
	removeWorkspaceAgent,
	removeWorkspaceMember,
	searchUsersForWorkspace,
} from "../prisma/queries/workspaces/members";

const workspaceId = "example-workspace";
const organizationId = "example-org";
const actor = "example-admin";
const userId = "example-user";
const agentId = "example-agent";
const owner = "example-owner";
const addedAt = new Date("2026-01-10T00:00:00Z");
const row = {
	id: "example-membership",
	workspaceId,
	userId,
	addedBy: actor,
	addedAt,
};
const agentRow = {
	id: "example-agent-membership",
	workspaceId,
	agentId,
	addedBy: actor,
	addedAt,
};
const person = {
	id: userId,
	name: "Example User",
	email: "user@example.com",
	image: null,
};
const adder = { id: actor, name: "Example Admin" };
const groups = [
	{ name: "administrators", table: db.workspaceAdministrator },
	{ name: "contributors", table: db.workspaceContributor },
	{ name: "stakeholders", table: db.workspaceStakeholder },
] as const;

beforeEach(() => {
	vi.resetAllMocks();
	db.workspace.findFirst.mockImplementation(async ({ select }) =>
		select.organizationId
			? { userId: owner, organizationId }
			: { userId: owner },
	);
	db.member.findFirst.mockImplementation(async ({ where }) =>
		where.organizationId === organizationId && where.userId === actor
			? { id: "example-org-membership" }
			: null,
	);
	for (const { table } of groups) {
		table.findFirst.mockResolvedValue(null);
		table.findMany.mockResolvedValue([]);
		table.deleteMany.mockResolvedValue({ count: 0 });
	}
	db.workspaceAdministrator.findFirst.mockImplementation(async ({ where }) =>
		where.userId === actor ? { id: "example-admin-membership" } : null,
	);
	db.workspaceAgent.findFirst.mockResolvedValue(null);
	db.workspaceAgent.findMany.mockResolvedValue([]);
	db.$transaction.mockImplementation(async (callback) => callback(db));
});

it.each([true, false])(
	"agent access requires a matching workspace and agent (found: %s)",
	async (found) => {
		db.workspaceAgent.findFirst.mockResolvedValue(
			found ? { id: agentRow.id } : null,
		);
		await expect(
			hasAgentWorkspaceAccess(workspaceId, agentId),
		).resolves.toBe(found);
		expect(db.workspaceAgent.findFirst).toHaveBeenCalledWith({
			where: { workspaceId, agentId },
			select: { id: true },
		});
	},
);

it("returns owner without reading group tables", async () => {
	await expect(getUserWorkspaceGroup(workspaceId, owner)).resolves.toBe(
		"owner",
	);
	for (const { table } of groups) {
		expect(table.findFirst).not.toHaveBeenCalled();
	}
});

it("returns null for a user in no group", async () => {
	await expect(
		getUserWorkspaceGroup(workspaceId, userId),
	).resolves.toBeNull();
	for (const { table } of groups) {
		expect(table.findFirst).toHaveBeenCalledWith({
			where: { workspaceId, userId },
			select: { id: true },
		});
	}
});

describe.each(groups)("$name", ({ name, table }) => {
	it("resolves a membership in this group", async () => {
		table.findFirst.mockResolvedValueOnce({ id: row.id });
		await expect(getUserWorkspaceGroup(workspaceId, userId)).resolves.toBe(
			name,
		);
	});

	it("adds a user to this group", async () => {
		table.create.mockResolvedValue(row);
		await expect(
			addWorkspaceMember(workspaceId, userId, name, actor),
		).resolves.toEqual(row);
		expect(table.create).toHaveBeenCalledWith({
			data: { workspaceId, userId, addedBy: actor },
		});
	});

	it("deletes this group's membership row", async () => {
		table.findFirst.mockImplementation(async ({ where, select }) =>
			where.userId === actor
				? { id: "example-admin-membership" }
				: select
					? { id: row.id }
					: row,
		);
		table.delete.mockResolvedValue(row);
		await expect(
			removeWorkspaceMember(workspaceId, userId, actor),
		).resolves.toEqual(row);
		expect(table.delete).toHaveBeenCalledWith({ where: { id: row.id } });
	});

	it("moves membership into this group in a transaction", async () => {
		table.create.mockResolvedValue(row);
		await expect(
			changeWorkspaceMemberGroup(workspaceId, userId, name, actor),
		).resolves.toEqual(row);
		expect(db.$transaction).toHaveBeenCalledOnce();
		for (const { table: oldTable } of groups) {
			expect(oldTable.deleteMany).toHaveBeenCalledWith({
				where: { workspaceId, userId },
			});
		}
		expect(table.create).toHaveBeenCalledWith({
			data: { workspaceId, userId, addedBy: actor },
		});
	});
});

it.each([
	{
		run: () =>
			addWorkspaceMember(workspaceId, userId, "contributors", actor),
		message: "Only administrators can add members",
	},
	{
		run: () => addWorkspaceAgent(workspaceId, agentId, actor),
		message: "Only administrators can add agents to workspaces",
	},
	{
		run: () => removeWorkspaceMember(workspaceId, userId, actor),
		message: "Only administrators can remove members",
	},
	{
		run: () => removeWorkspaceAgent(workspaceId, agentId, actor),
		message: "Only administrators can remove agents",
	},
	{
		run: () =>
			changeWorkspaceMemberGroup(
				workspaceId,
				userId,
				"contributors",
				actor,
			),
		message: "Only administrators can change member groups",
	},
])(
	"rejects unauthorized mutations with '$message'",
	async ({ run, message }) => {
		db.workspaceAdministrator.findFirst.mockResolvedValue(null);
		db.workspaceContributor.findFirst.mockResolvedValue({
			id: "example-contributor",
		});
		await expect(run()).rejects.toThrow(message);
		expect(db.member.findFirst).toHaveBeenCalledWith({
			where: { organizationId, userId: actor },
			select: { id: true },
		});
		for (const table of [
			...groups.map(({ table }) => table),
			db.workspaceAgent,
		]) {
			expect(table.create).not.toHaveBeenCalled();
			expect(table.delete).not.toHaveBeenCalled();
		}
		expect(db.$transaction).not.toHaveBeenCalled();
	},
);

it("does not accept administrator standing from outside the workspace organization", async () => {
	db.member.findFirst.mockResolvedValue(null);
	await expect(
		addWorkspaceAgent(workspaceId, agentId, actor),
	).rejects.toThrow("Only administrators");
	expect(db.member.findFirst).toHaveBeenCalledWith({
		where: { organizationId, userId: actor },
		select: { id: true },
	});
	expect(db.workspaceAdministrator.findFirst).not.toHaveBeenCalled();
	expect(db.workspaceAgent.create).not.toHaveBeenCalled();
});

it("refuses duplicate memberships across groups", async () => {
	db.workspaceStakeholder.findFirst.mockResolvedValue({ id: row.id });
	await expect(
		addWorkspaceMember(workspaceId, userId, "contributors", actor),
	).rejects.toThrow("already in the stakeholders group");
	expect(db.workspaceContributor.create).not.toHaveBeenCalled();
});

it("refuses to delete a missing membership", async () => {
	await expect(
		removeWorkspaceMember(workspaceId, userId, actor),
	).rejects.toThrow("User is not a member");
	for (const { table } of groups) {
		expect(table.delete).not.toHaveBeenCalled();
	}
});

it("protects the workspace owner from removal and group changes", async () => {
	await expect(
		removeWorkspaceMember(workspaceId, owner, actor),
	).rejects.toThrow("Cannot remove the workspace owner");
	await expect(
		changeWorkspaceMemberGroup(workspaceId, owner, "contributors", actor),
	).rejects.toThrow("Cannot change the owner's group");
	expect(db.$transaction).not.toHaveBeenCalled();
	for (const { table } of groups) {
		expect(table.delete).not.toHaveBeenCalled();
	}
});

it("adds an agent once and rejects a duplicate", async () => {
	db.workspaceAgent.findFirst
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(agentRow);
	db.workspaceAgent.create.mockResolvedValue(agentRow);
	await expect(
		addWorkspaceAgent(workspaceId, agentId, actor),
	).resolves.toEqual(agentRow);
	await expect(
		addWorkspaceAgent(workspaceId, agentId, actor),
	).rejects.toThrow("Agent is already in the workspace");
	expect(db.workspaceAgent.findFirst).toHaveBeenCalledWith({
		where: { workspaceId, agentId },
	});
	expect(db.workspaceAgent.create).toHaveBeenCalledExactlyOnceWith({
		data: { workspaceId, agentId, addedBy: actor },
	});
});

it("removes only the requested workspace-agent association", async () => {
	db.workspaceAgent.delete.mockResolvedValue(agentRow);
	await expect(
		removeWorkspaceAgent(workspaceId, agentId, actor),
	).resolves.toEqual(agentRow);
	expect(db.workspaceAgent.delete).toHaveBeenCalledWith({
		where: { workspaceId_agentId: { workspaceId, agentId } },
	});
});

it("lists the owner and selected membership details in their groups", async () => {
	const ownerUser = { ...person, id: owner };
	db.workspace.findUnique.mockResolvedValue({
		userId: owner,
		user: ownerUser,
	});
	const membership = {
		id: row.id,
		userId,
		addedBy: actor,
		addedAt,
		user: person,
	};
	for (const { table } of groups) {
		table.findMany.mockResolvedValue([{ ...membership, adder }]);
	}
	const agent = { id: agentId, name: "Example Agent", description: null };
	const selectedAgent = {
		id: agentRow.id,
		agentId,
		addedBy: actor,
		addedAt,
		agent,
	};
	db.workspaceAgent.findMany.mockResolvedValue([{ ...selectedAgent, adder }]);
	expect(await getWorkspaceMembers(workspaceId)).toEqual({
		owner: { userId: owner, user: ownerUser, isOwner: true },
		administrators: [
			{ ...membership, group: "administrators", addedByUser: adder },
		],
		contributors: [
			{ ...membership, group: "contributors", addedByUser: adder },
		],
		stakeholders: [
			{ ...membership, group: "stakeholders", addedByUser: adder },
		],
		agents: [{ ...selectedAgent, addedByUser: adder }],
	});
	for (const table of [
		...groups.map(({ table }) => table),
		db.workspaceAgent,
	]) {
		expect(table.findMany.mock.calls[0]?.[0].where).toEqual({
			workspaceId,
		});
	}
});

it("returns no owner or members when the workspace is missing", async () => {
	db.workspace.findUnique.mockResolvedValue(null);
	expect(await getWorkspaceMembers(workspaceId)).toEqual({
		owner: null,
		administrators: [],
		contributors: [],
		stakeholders: [],
		agents: [],
	});
	expect(await searchUsersForWorkspace(workspaceId, "example")).toEqual([]);
	expect(db.member.findMany).not.toHaveBeenCalled();
	expect(db.user.findMany).not.toHaveBeenCalled();
});

it("searches eligible users only within the workspace organization", async () => {
	const org = organizationId;
	db.workspace.findUnique.mockResolvedValue({
		userId: owner,
		organizationId: org,
	});
	for (const { name, table } of groups) {
		table.findMany.mockResolvedValue([{ userId: name }]);
	}
	db.member.findMany.mockResolvedValue([{ user: person }]);
	db.user.findMany.mockResolvedValue([person]);
	const excluded = { notIn: [owner, ...groups.map(({ name }) => name)] };
	const match = {
		OR: [
			{ name: { contains: "example", mode: "insensitive" } },
			{ email: { contains: "example", mode: "insensitive" } },
		],
	};
	expect(await searchUsersForWorkspace(workspaceId, "example", 3)).toEqual([
		person,
	]);
	expect(db.member.findMany.mock.calls[0]?.[0].where).toEqual({
		organizationId: org,
		userId: excluded,
		user: match,
	});
	expect(db.member.findMany.mock.calls[0]?.[0].take).toBe(3);
	expect(db.user.findMany).not.toHaveBeenCalled();
});
