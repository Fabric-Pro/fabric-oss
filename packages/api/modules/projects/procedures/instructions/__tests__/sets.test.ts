/**
 * Tests for the Coding Instructions set procedures (spec 2026-11-11): the
 * hosting organization is resolved server-side, refusals keep their code,
 * and every change records its audit action with names and counts only.
 * The queries themselves are covered against Postgres in
 * `@repo/database` (`instruction-sets.integration.test.ts`).
 */

import { ORPCError } from "@orpc/client";
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
		handlers: [] as Array<(...a: unknown[]) => unknown>,
		InstructionSetError,
		listInstructionSets: vi.fn(),
		createInstructionSet: vi.fn(),
		updateInstructionSet: vi.fn(),
		deleteInstructionSet: vi.fn(),
		requireHostingOrganizationId: vi.fn(),
		recordAuditFromRequest: vi.fn(),
		listProjectCodeRepositories: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	InstructionSetError: m.InstructionSetError,
	listInstructionSets: (...a: unknown[]) => m.listInstructionSets(...a),
	createInstructionSet: (...a: unknown[]) => m.createInstructionSet(...a),
	updateInstructionSet: (...a: unknown[]) => m.updateInstructionSet(...a),
	deleteInstructionSet: (...a: unknown[]) => m.deleteInstructionSet(...a),
}));
vi.mock("../../../lib/code-repositories", () => ({
	listProjectCodeRepositories: (...a: unknown[]) =>
		m.listProjectCodeRepositories(...a),
}));
vi.mock("../hosting-organization", () => ({
	requireHostingOrganizationId: (...a: unknown[]) =>
		m.requireHostingOrganizationId(...a),
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => m.recordAuditFromRequest(...a),
}));
vi.mock("../../../../../orpc/middleware/project-visibility", () => ({
	projectNotFoundUnlessVisible: {},
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder = () => {
		const b = {
			use: () => b,
			route: () => b,
			input: () => b,
			handler: (fn: (...a: unknown[]) => unknown) => {
				m.handlers.push(fn);
				return fn;
			},
		};
		return b;
	};
	return {
		get tenantProtectedProcedure() {
			return builder();
		},
		requireProjectPermission: () => ({}),
		Permissions: {
			INSTRUCTION_READ: "instruction:read",
			INSTRUCTION_UPDATE: "instruction:update",
		},
	};
});

const procedures = await import("../sets");
const [list, create, update, remove] = m.handlers as Array<
	(args: { input: unknown; context: unknown }) => Promise<unknown>
>;

const ctx = { user: { id: "user_1" } };
const at = new Date("2026-11-11T10:00:00.000Z");
const set = {
	id: "set_1",
	name: "Mobile apps",
	slug: "mobile-apps",
	isDefault: false,
	repositoryIntegrationIds: ["int_web"],
	folder: "instructions/mobile-apps/",
	excludedFolders: [],
	createdAt: at,
	updatedAt: at,
};

beforeEach(() => {
	vi.clearAllMocks();
	m.requireHostingOrganizationId.mockResolvedValue("org_host");
});

describe("Coding Instructions set procedures", () => {
	it("registers the four procedures", () => {
		expect(Object.keys(procedures).sort()).toEqual([
			"createInstructionSetProcedure",
			"deleteInstructionSetProcedure",
			"listInstructionSetsProcedure",
			"updateInstructionSetProcedure",
		]);
	});

	it("lists the project's sets and the repositories a set may cover", async () => {
		m.listInstructionSets.mockResolvedValue([set]);
		m.listProjectCodeRepositories.mockResolvedValue([
			{
				id: "int_web",
				provider: "GITHUB",
				name: "example-org/web",
				cloneUrl: "https://github.com/example-org/web.git",
				defaultBranch: "main",
				roleTag: null,
				folder: "web",
			},
		]);
		const result = await list?.({
			input: { projectId: "proj_1" },
			context: ctx,
		});
		expect(m.listInstructionSets).toHaveBeenCalledWith("proj_1");
		expect(result).toEqual({
			sets: [
				{
					...set,
					createdAt: at.toISOString(),
					updatedAt: at.toISOString(),
				},
			],
			codeRepositories: [
				{
					id: "int_web",
					name: "example-org/web",
					provider: "GITHUB",
					roleTag: null,
				},
			],
		});
	});

	it("creates in the hosting organization, never one the caller names, and audits it", async () => {
		m.createInstructionSet.mockResolvedValue(set);
		await create?.({
			input: {
				projectId: "proj_1",
				organizationId: "org_other",
				name: "Mobile apps",
				repositoryIntegrationIds: ["int_web"],
			},
			context: ctx,
		});
		expect(m.requireHostingOrganizationId).toHaveBeenCalledWith(
			"proj_1",
			"user_1",
		);
		expect(m.createInstructionSet).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_host",
			userId: "user_1",
			name: "Mobile apps",
			slug: undefined,
			repositoryIntegrationIds: ["int_web"],
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(ctx, {
			action: "project.instructions.set_created",
			category: "project",
			organizationId: "org_host",
			projectId: "proj_1",
			resource: {
				type: "project_instruction_set",
				id: "set_1",
				name: "Mobile apps",
			},
			metadata: { slug: "mobile-apps", repositoryCount: 1 },
		});
	});

	it("turns a refusal into a typed error and audits nothing", async () => {
		m.createInstructionSet.mockRejectedValue(
			new m.InstructionSetError("SLUG_TAKEN", "Taken."),
		);
		const error = await create?.({
			input: {
				projectId: "proj_1",
				name: "Web",
				repositoryIntegrationIds: [],
			},
			context: ctx,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ORPCError);
		expect(error).toMatchObject({
			code: "CONFLICT",
			data: { code: "SLUG_TAKEN" },
		});
		expect(m.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("reports a repository it may not cover with its ids", async () => {
		m.updateInstructionSet.mockRejectedValue(
			new m.InstructionSetError("REPOSITORY_NOT_FOUND", "Missing.", {
				repositoryIntegrationIds: ["int_x"],
			}),
		);
		const error = await update?.({
			input: {
				projectId: "proj_1",
				setId: "set_1",
				repositoryIntegrationIds: ["int_x"],
			},
			context: ctx,
		}).catch((e: unknown) => e);
		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			data: {
				code: "REPOSITORY_NOT_FOUND",
				repositoryIntegrationIds: ["int_x"],
			},
		});
	});

	it("audits an update with before and after counts", async () => {
		m.updateInstructionSet.mockResolvedValue({
			set: { ...set, name: "Apps", repositoryIntegrationIds: [] },
			before: set,
		});
		await update?.({
			input: { projectId: "proj_1", setId: "set_1", name: "Apps" },
			context: ctx,
		});
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.set_updated",
				metadata: {
					renamed: true,
					repositoryCount: 0,
					previousRepositoryCount: 1,
				},
			}),
		);
	});

	it("deletes and audits, and a missing set is not found", async () => {
		m.deleteInstructionSet.mockResolvedValueOnce(set);
		expect(
			await remove?.({
				input: { projectId: "proj_1", setId: "set_1" },
				context: ctx,
			}),
		).toEqual({ id: "set_1", deleted: true });
		expect(m.recordAuditFromRequest).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.instructions.set_deleted",
				metadata: { slug: "mobile-apps" },
			}),
		);

		m.deleteInstructionSet.mockRejectedValueOnce(
			new m.InstructionSetError("SET_NOT_FOUND", "Set not found."),
		);
		const error = await remove?.({
			input: { projectId: "proj_1", setId: "set_x" },
			context: ctx,
		}).catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "NOT_FOUND" });
	});
});
