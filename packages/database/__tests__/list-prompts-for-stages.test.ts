import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: {
		promptBinding: {
			findMany: (args: unknown) => findMany(args),
		},
	},
}));

import { listPromptsForStages } from "../prisma/queries/prompts";

const STAGES = ["PLACEHOLDER", "ACTIVE_ANALYSIS", "SANITY_CHECK", "DRAFT"];

function makeBinding(opts: {
	id: string;
	documentType: string;
	scope: "USER" | "ORG" | "SYSTEM";
	promptId: string;
	versionId?: string;
	isDefault?: boolean;
}) {
	return {
		id: opts.id,
		targetType: "AGENT",
		targetKey: "project_document_generator",
		documentType: opts.documentType,
		scope: opts.scope,
		isDefault: opts.isDefault ?? true,
		promptVersion: {
			id: opts.versionId ?? `ver-${opts.id}`,
			version: 1,
			promptId: opts.promptId,
			prompt: {
				id: opts.promptId,
				key: `key-${opts.promptId}`,
				name: `Prompt ${opts.promptId}`,
				description: null,
				scope: opts.scope,
				category: null,
				tags: [],
				format: "MARKDOWN",
				forkedFrom: null,
				_count: { versions: 1 },
				versions: [
					{
						id: opts.versionId ?? `ver-${opts.id}`,
						version: 1,
						content: "",
					},
				],
			},
		},
	};
}

describe("listPromptsForStages", () => {
	beforeEach(() => {
		findMany.mockReset();
	});

	it("returns one entry per requested stage in input order, with empty bindings for unbound stages", async () => {
		findMany.mockResolvedValue([
			makeBinding({
				id: "b1",
				documentType: "PLACEHOLDER",
				scope: "SYSTEM",
				promptId: "p1",
			}),
			makeBinding({
				id: "b2",
				documentType: "DRAFT",
				scope: "SYSTEM",
				promptId: "p2",
			}),
		]);

		const result = await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: STAGES,
			userId: "u1",
			organizationId: null,
		});

		expect(result.map((r) => r.documentType)).toEqual(STAGES);
		expect(result[0].bindings).toHaveLength(1);
		expect(result[0].bindings[0].prompt.id).toBe("p1");
		expect(result[1].bindings).toEqual([]);
		expect(result[2].bindings).toEqual([]);
		expect(result[3].bindings).toHaveLength(1);
		expect(result[3].bindings[0].prompt.id).toBe("p2");
	});

	it("returns ALL visible bindings for a stage in personal context (USER + SYSTEM, no collapse)", async () => {
		findMany.mockResolvedValue([
			makeBinding({
				id: "sys",
				documentType: "DRAFT",
				scope: "SYSTEM",
				promptId: "p-sys",
			}),
			makeBinding({
				id: "user",
				documentType: "DRAFT",
				scope: "USER",
				promptId: "p-user",
			}),
		]);

		const result = await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["DRAFT"],
			userId: "u1",
			organizationId: null,
		});

		expect(result).toHaveLength(1);
		expect(result[0].bindings).toHaveLength(2);
		const promptIds = result[0].bindings.map((b) => b.prompt.id).sort();
		expect(promptIds).toEqual(["p-sys", "p-user"]);
	});

	it("returns ALL visible bindings for a stage in org context (ORG + SYSTEM, no collapse)", async () => {
		findMany.mockResolvedValue([
			makeBinding({
				id: "sys",
				documentType: "DRAFT",
				scope: "SYSTEM",
				promptId: "p-sys",
			}),
			makeBinding({
				id: "org",
				documentType: "DRAFT",
				scope: "ORG",
				promptId: "p-org",
			}),
		]);

		const result = await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["DRAFT"],
			userId: "u1",
			organizationId: "org1",
		});

		expect(result).toHaveLength(1);
		expect(result[0].bindings).toHaveLength(2);
		const promptIds = result[0].bindings.map((b) => b.prompt.id).sort();
		expect(promptIds).toEqual(["p-org", "p-sys"]);
	});

	it("includes both default and non-default bindings (no isDefault filter)", async () => {
		findMany.mockResolvedValue([
			makeBinding({
				id: "sys",
				documentType: "DRAFT",
				scope: "SYSTEM",
				promptId: "p-sys",
				isDefault: true,
			}),
			makeBinding({
				id: "user-nondefault",
				documentType: "DRAFT",
				scope: "USER",
				promptId: "p-user",
				isDefault: false,
			}),
		]);

		const result = await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["DRAFT"],
			userId: "u1",
			organizationId: null,
		});

		// Both bindings should be present
		expect(result[0].bindings).toHaveLength(2);
		// Verify the where clause does NOT include isDefault
		const callArgs = findMany.mock.calls[0][0] as {
			where: { isDefault?: boolean };
		};
		expect(callArgs.where.isDefault).toBeUndefined();
	});

	it("only requests SYSTEM bindings when no userId and no organizationId provided", async () => {
		findMany.mockResolvedValue([]);

		await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: STAGES,
			userId: undefined,
			organizationId: undefined,
		});

		const callArgs = findMany.mock.calls[0][0] as {
			where: { OR: Array<{ scope: string }> };
		};
		expect(callArgs.where.OR).toEqual([{ scope: "SYSTEM" }]);
	});

	it("includes SYSTEM + ORG + the caller's own USER conditions in org context", async () => {
		// Inverted deliberately with FR3 of Fizzy #2068: a personal default now
		// overrides the organization's for whoever set it, so the stage panel
		// must show it or it would advertise a tier the runtime will not use.
		findMany.mockResolvedValue([]);

		await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: STAGES,
			userId: "u1",
			organizationId: "org1",
		});

		const callArgs = findMany.mock.calls[0][0] as {
			where: {
				OR: Array<Record<string, unknown>>;
				targetType: string;
				targetKey: string;
				documentType: { in: string[] };
			};
		};
		expect(callArgs.where.targetType).toBe("AGENT");
		expect(callArgs.where.targetKey).toBe("project_document_generator");
		expect(callArgs.where.documentType).toEqual({ in: STAGES });
		expect(callArgs.where.OR).toEqual([
			{ scope: "SYSTEM" },
			{ scope: "ORG", organizationId: "org1" },
			{ scope: "USER", userId: "u1" },
		]);
		// Scoped to the caller: one person's override is never another's.
		expect(callArgs.where.OR).not.toContainEqual({ scope: "USER" });
	});

	it("includes only SYSTEM + USER scope conditions in personal context", async () => {
		findMany.mockResolvedValue([]);

		await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: STAGES,
			userId: "u1",
			organizationId: null,
		});

		const callArgs = findMany.mock.calls[0][0] as {
			where: { OR: Array<Record<string, unknown>> };
		};
		expect(callArgs.where.OR).toEqual([
			{ scope: "SYSTEM" },
			{ scope: "USER", userId: "u1" },
		]);
	});

	it("returns only SYSTEM bindings when scope is 'SYSTEM'", async () => {
		findMany.mockResolvedValue([
			makeBinding({
				id: "sys",
				documentType: "DRAFT",
				scope: "SYSTEM",
				promptId: "p-sys",
			}),
		]);

		await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["DRAFT"],
			userId: "u1",
			organizationId: "org1",
			scope: "SYSTEM",
		});

		const callArgs = findMany.mock.calls[0][0] as {
			where: { OR: Array<Record<string, unknown>> };
		};
		expect(callArgs.where.OR).toEqual([{ scope: "SYSTEM" }]);
	});

	it("returns only ORG bindings when scope is 'ORG' and organizationId is provided", async () => {
		findMany.mockResolvedValue([]);

		await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["DRAFT"],
			userId: "u1",
			organizationId: "org1",
			scope: "ORG",
		});

		const callArgs = findMany.mock.calls[0][0] as {
			where: { OR: Array<Record<string, unknown>> };
		};
		expect(callArgs.where.OR).toEqual([
			{ scope: "ORG", organizationId: "org1" },
		]);
	});

	it("returns all stages empty when scope is 'ORG' but no organizationId", async () => {
		const result = await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["PLACEHOLDER", "DRAFT"],
			userId: "u1",
			organizationId: null,
			scope: "ORG",
		});

		expect(findMany).not.toHaveBeenCalled();
		expect(result).toEqual([
			{ documentType: "PLACEHOLDER", bindings: [] },
			{ documentType: "DRAFT", bindings: [] },
		]);
	});

	it("returns only USER bindings when scope is 'USER' and userId is provided", async () => {
		findMany.mockResolvedValue([]);

		await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["DRAFT"],
			userId: "u1",
			organizationId: null,
			scope: "USER",
		});

		const callArgs = findMany.mock.calls[0][0] as {
			where: { OR: Array<Record<string, unknown>> };
		};
		expect(callArgs.where.OR).toEqual([{ scope: "USER", userId: "u1" }]);
	});

	it("returns all stages empty when scope is 'USER' but no userId", async () => {
		const result = await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["PLACEHOLDER", "DRAFT"],
			userId: undefined,
			organizationId: null,
			scope: "USER",
		});

		expect(findMany).not.toHaveBeenCalled();
		expect(result).toEqual([
			{ documentType: "PLACEHOLDER", bindings: [] },
			{ documentType: "DRAFT", bindings: [] },
		]);
	});

	it("queries the caller's personal stage bindings even in org context", async () => {
		// Also inverted with FR3: USER is reachable in either context now, so
		// asking for that scope explicitly must return it rather than empty.
		findMany.mockResolvedValue([]);

		await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["PLACEHOLDER", "DRAFT"],
			userId: "u1",
			organizationId: "org1",
			scope: "USER",
		});

		expect(findMany).toHaveBeenCalledTimes(1);
		const callArgs = findMany.mock.calls[0][0] as {
			where: { OR: Array<Record<string, unknown>> };
		};
		expect(callArgs.where.OR).toEqual([{ scope: "USER", userId: "u1" }]);
	});

	it("returns empty for a USER-scope request with no caller", async () => {
		const result = await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["PLACEHOLDER"],
			organizationId: "org1",
			scope: "USER",
		});

		expect(findMany).not.toHaveBeenCalled();
		expect(result).toEqual([{ documentType: "PLACEHOLDER", bindings: [] }]);
	});

	it("sorts personal-context bindings within a stage by scope (USER, SYSTEM) then by isDefault desc", async () => {
		findMany.mockResolvedValue([
			// Returned in arbitrary order
			makeBinding({
				id: "sys-default",
				documentType: "DRAFT",
				scope: "SYSTEM",
				promptId: "p-sys-default",
				isDefault: true,
			}),
			makeBinding({
				id: "user-nondefault",
				documentType: "DRAFT",
				scope: "USER",
				promptId: "p-user-nondefault",
				isDefault: false,
			}),
			makeBinding({
				id: "user-default",
				documentType: "DRAFT",
				scope: "USER",
				promptId: "p-user-default",
				isDefault: true,
			}),
		]);

		const result = await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["DRAFT"],
			userId: "u1",
			organizationId: null,
		});

		// Order: USER(default), USER(non-default), SYSTEM(default)
		expect(result[0].bindings.map((b) => b.prompt.id)).toEqual([
			"p-user-default",
			"p-user-nondefault",
			"p-sys-default",
		]);
	});

	it("sorts org-context bindings within a stage by scope (ORG, SYSTEM) then by isDefault desc", async () => {
		findMany.mockResolvedValue([
			makeBinding({
				id: "sys-default",
				documentType: "DRAFT",
				scope: "SYSTEM",
				promptId: "p-sys-default",
				isDefault: true,
			}),
			makeBinding({
				id: "org-nondefault",
				documentType: "DRAFT",
				scope: "ORG",
				promptId: "p-org-nondefault",
				isDefault: false,
			}),
			makeBinding({
				id: "org-default",
				documentType: "DRAFT",
				scope: "ORG",
				promptId: "p-org-default",
				isDefault: true,
			}),
		]);

		const result = await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["DRAFT"],
			userId: "u1",
			organizationId: "org1",
		});

		expect(result[0].bindings.map((b) => b.prompt.id)).toEqual([
			"p-org-default",
			"p-org-nondefault",
			"p-sys-default",
		]);
	});

	it("returns binding metadata (id, scope, versionId, isDefault) alongside the prompt for each entry", async () => {
		findMany.mockResolvedValue([
			makeBinding({
				id: "b-x",
				documentType: "DRAFT",
				scope: "ORG",
				promptId: "p-x",
				versionId: "ver-x",
				isDefault: false,
			}),
		]);

		const result = await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["DRAFT"],
			userId: "u1",
			organizationId: "org1",
		});

		expect(result[0].bindings).toHaveLength(1);
		expect(result[0].bindings[0].binding).toEqual({
			id: "b-x",
			scope: "ORG",
			versionId: "ver-x",
			isDefault: false,
		});
		expect(result[0].bindings[0].prompt.id).toBe("p-x");
	});

	it("returns the bound version (not the latest) in prompt.versions", async () => {
		const boundVersion = {
			id: "ver-old",
			version: 2,
			content: "bound version content",
			promptId: "p-multi",
		};
		const latestVersion = {
			id: "ver-latest",
			version: 7,
			content: "latest version content",
		};
		findMany.mockResolvedValue([
			{
				id: "b-multi",
				targetType: "AGENT",
				targetKey: "project_document_generator",
				documentType: "DRAFT",
				scope: "SYSTEM",
				isDefault: true,
				promptVersion: {
					...boundVersion,
					prompt: {
						id: "p-multi",
						key: "key-p-multi",
						name: "Prompt p-multi",
						description: null,
						scope: "SYSTEM",
						category: null,
						tags: [],
						format: "MARKDOWN",
						forkedFrom: null,
						_count: { versions: 7 },
						versions: [latestVersion],
					},
				},
			},
		]);

		const result = await listPromptsForStages({
			agentName: "project_document_generator",
			documentTypes: ["DRAFT"],
			userId: "u1",
			organizationId: null,
		});

		expect(result[0].bindings).toHaveLength(1);
		expect(result[0].bindings[0].binding.versionId).toBe("ver-old");
		expect(result[0].bindings[0].prompt.versions).toEqual([
			expect.objectContaining({
				id: "ver-old",
				content: "bound version content",
			}),
		]);
	});
});
