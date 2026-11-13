/**
 * The Coding Instructions set tools: the scope each declares (changing a set
 * is never reachable with the proposal-only `instructions:write`), the live
 * permission each asks the project gate for, refusals that keep their code,
 * and an audit row for every change, with names and counts only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => {
	class InstructionSetError extends Error {
		constructor(
			readonly code: string,
			message: string,
			readonly details?: Record<string, unknown>,
		) {
			super(message);
		}
	}
	return {
		InstructionSetError,
		listInstructionSets: vi.fn(),
		createInstructionSet: vi.fn(),
		updateInstructionSet: vi.fn(),
		deleteInstructionSet: vi.fn(),
		recordAudit: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	InstructionSetError: m.InstructionSetError,
	listInstructionSets: m.listInstructionSets,
	createInstructionSet: m.createInstructionSet,
	updateInstructionSet: m.updateInstructionSet,
	deleteInstructionSet: m.deleteInstructionSet,
	recordAudit: m.recordAudit,
}));

import { createInstructionSetTools } from "../instruction-set-tools";
import type { GatewaySession } from "../types";

const session = {
	userId: "user-1",
	credential: "oauth",
} as GatewaySession;

const set = {
	id: "set-1",
	name: "Mobile apps",
	slug: "mobile-apps",
	isDefault: false,
	repositoryIntegrationIds: ["int-1"],
	folder: "instructions/mobile-apps/",
	excludedFolders: [],
	createdAt: new Date("2026-11-11T10:00:00.000Z"),
	updatedAt: new Date("2026-11-11T10:00:00.000Z"),
};

function family(status: "allowed" | "not-found" | "forbidden" = "allowed") {
	const gate = vi.fn(async () =>
		status === "allowed" ? { status, organizationId: "org-1" } : { status },
	);
	return {
		gate,
		tools: createInstructionSetTools({
			resolveGatewayProjectWriteAccessWithHost: gate,
		}),
	};
}

async function call(
	tools: ReturnType<typeof family>["tools"],
	name: string,
	args: Record<string, unknown>,
) {
	const handler = tools.handlers.get(name);
	if (!handler) {
		throw new Error(`${name} not registered`);
	}
	const result = await handler(args, session);
	const text = (result.content[0] as { text: string }).text;
	return { isError: result.isError === true, text };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("Coding Instructions set tools", () => {
	it("lists under instructions:read and changes under projects:write only", () => {
		const { tools } = family();
		expect(tools.scopes).toEqual({
			fabric_list_instruction_sets: {
				scope: "instructions:read",
				kind: "read",
			},
			fabric_create_instruction_set: {
				scope: "projects:write",
				kind: "write",
			},
			fabric_update_instruction_set: {
				scope: "projects:write",
				kind: "write",
			},
			fabric_delete_instruction_set: {
				scope: "projects:write",
				kind: "write",
			},
		});
	});

	it("lists with the live read permission", async () => {
		m.listInstructionSets.mockResolvedValue([set]);
		const { tools, gate } = family();

		const out = await call(tools, "fabric_list_instruction_sets", {
			projectId: "proj-1",
		});

		expect(gate).toHaveBeenCalledWith(
			"proj-1",
			session,
			"INSTRUCTION_READ",
		);
		expect(JSON.parse(out.text)).toEqual({
			sets: [
				{
					id: "set-1",
					name: "Mobile apps",
					slug: "mobile-apps",
					isDefault: false,
					repositoryIntegrationIds: ["int-1"],
					folder: "instructions/mobile-apps/",
					excludedFolders: [],
				},
			],
		});
	});

	it("answers an unreachable project as not found and a missing right as forbidden, changing nothing", async () => {
		const hidden = family("not-found");
		const missing = await call(
			hidden.tools,
			"fabric_create_instruction_set",
			{ projectId: "proj-x", name: "Web" },
		);
		expect(missing).toMatchObject({ isError: true });
		expect(missing.text).toContain("not found");

		const viewer = family("forbidden");
		const refused = await call(
			viewer.tools,
			"fabric_delete_instruction_set",
			{ projectId: "proj-1", setId: "set-1" },
		);
		expect(refused).toMatchObject({ isError: true });
		expect(refused.text).toContain("No permission to change");
		expect(viewer.gate).toHaveBeenCalledWith(
			"proj-1",
			session,
			"INSTRUCTION_UPDATE",
		);

		expect(m.createInstructionSet).not.toHaveBeenCalled();
		expect(m.deleteInstructionSet).not.toHaveBeenCalled();
		expect(m.recordAudit).not.toHaveBeenCalled();
	});

	it("checks its arguments before asking the gate", async () => {
		const { tools, gate } = family();
		expect(
			(
				await call(tools, "fabric_create_instruction_set", {
					projectId: "p",
				})
			).isError,
		).toBe(true);
		expect(
			(
				await call(tools, "fabric_update_instruction_set", {
					projectId: "p",
					setId: "s",
					repositoryIntegrationIds: "int-1",
				})
			).isError,
		).toBe(true);
		expect(gate).not.toHaveBeenCalled();
	});

	it("creates in the gate's organization and audits it as the agent", async () => {
		m.createInstructionSet.mockResolvedValue(set);
		const { tools } = family();

		const out = await call(tools, "fabric_create_instruction_set", {
			projectId: "proj-1",
			name: "Mobile apps",
			repositoryIntegrationIds: ["int-1"],
		});

		expect(out.isError).toBe(false);
		expect(m.createInstructionSet).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			userId: "user-1",
			name: "Mobile apps",
			slug: undefined,
			repositoryIntegrationIds: ["int-1"],
		});
		expect(m.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "project.instructions.set_created",
				organizationId: "org-1",
				actor: { type: "agent", userId: "user-1" },
				metadata: {
					slug: "mobile-apps",
					repositoryCount: 1,
					via: "mcp",
				},
			}),
		);
	});

	it("returns a refusal with its code and audits nothing", async () => {
		m.updateInstructionSet.mockRejectedValue(
			new m.InstructionSetError(
				"REPOSITORY_IS_INSTRUCTIONS_SOURCE",
				"No.",
				{
					repositoryIntegrationIds: ["int-src"],
				},
			),
		);
		const { tools } = family();

		const out = await call(tools, "fabric_update_instruction_set", {
			projectId: "proj-1",
			setId: "set-1",
			repositoryIntegrationIds: ["int-src"],
		});

		expect(out.isError).toBe(true);
		expect(out.text).toContain("REPOSITORY_IS_INSTRUCTIONS_SOURCE");
		expect(out.text).toContain("int-src");
		expect(m.recordAudit).not.toHaveBeenCalled();
	});

	it("deletes and audits", async () => {
		m.deleteInstructionSet.mockResolvedValue(set);
		const { tools } = family();

		const out = await call(tools, "fabric_delete_instruction_set", {
			projectId: "proj-1",
			setId: "set-1",
		});

		expect(out.isError).toBe(false);
		expect(m.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "project.instructions.set_deleted",
				metadata: { slug: "mobile-apps", via: "mcp" },
			}),
		);
	});
});
