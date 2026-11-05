import { asSchema } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { agentPreviewStartSchema } from "../../lib/agent-preview-contracts";
import type { AgentToolSource } from "../shared/agent-tool-runtime";

const m = vi.hoisted(() => ({
	access: vi.fn(),
	findMany: vi.fn(),
	catalog: vi.fn(),
	skill: vi.fn(),
	document: vi.fn(),
	turn: vi.fn(),
	execute: vi.fn(),
	buildContext: vi.fn(),
	caught: undefined as unknown,
	visible: [] as string[],
	tools: {} as Record<string, unknown>,
	sources: {} as Record<string, { configId: string; originalName: string }>,
	controller: new AbortController(),
	info: {
		workflowType: "agentDraftPreviewWorkflow",
		workflowExecution: {
			workflowId: "example-preview-workflow",
			runId: "example-run",
		},
	},
}));
vi.mock("@repo/ai", async () => {
	const { asSchema, jsonSchema } = await import("ai");
	return { asSchema, jsonSchema };
});
vi.mock("@repo/database", () => ({
	db: { workspaceDocument: { findMany: m.findMany } },
	getSkillById: m.skill,
	readWorkspaceDocumentContent: m.document,
}));
vi.mock("@repo/database/prisma/queries/workspaces/document-content", () => ({
	getWorkspaceDocumentCatalog: m.catalog,
	readWorkspaceDocumentContent: m.document,
}));
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			info: m.info,
			cancellationSignal: m.controller.signal,
		}),
	},
	heartbeat: vi.fn(),
}));
vi.mock("../../lib/agent-preview-access", () => ({
	assertAgentPreviewAccess: m.access,
	previewRequestHash: () => "a".repeat(64),
	previewWorkflowId: () => "example-preview-workflow",
}));
vi.mock("../agent-execution-core", () => ({
	buildAgentExecutionContext: m.buildContext,
}));
vi.mock("../agent-execution-core/agent-executor", () => ({
	executeAgentTurn: m.turn,
}));

import {
	executeAgentPreviewModelStep,
	executeAgentPreviewReadStep,
	type PreparedAgentPreview,
	prepareAgentPreview,
} from "../agent-preview";
import { prepareAgentTools } from "../shared/agent-tool-runtime";

const base = {
	actor: { userId: "example-user", organizationId: "example-org" },
	request: agentPreviewStartSchema.parse({
		draft: {
			instructions: "Only use selected documents.",
			projectId: "example-project",
			capabilityIds: ["project-context"],
		},
		userMessage: "Summarize delivery",
		idempotencyKey: "7683115d-b780-4dba-8cff-7ef1c90894fe",
	}),
	draftHash: "a".repeat(64),
};
const prepared: PreparedAgentPreview = {
	documents: [],
	sources: [],
	turn: {
		systemPrompt: "Frozen instructions",
		userMessage: "Task",
		userId: base.actor.userId,
		organizationId: base.actor.organizationId,
		projectId: "example-project",
		mcpConfigIds: [],
		workspaceIds: [],
		integrationConfigurations: [],
	},
};
const decision = {
	id: "example-call",
	name: "fabric_get_project_document",
	args: { documentId: "example-document" },
	source: {
		configId: "builtin",
		originalName: "fabric_get_project_document",
	},
};
const read = () => executeAgentPreviewReadStep({ base, prepared, decision });
beforeEach(() => {
	vi.resetAllMocks();
	m.controller = new AbortController();
	m.caught = undefined;
	m.visible = [];
	m.buildContext.mockImplementation(
		(
			_template: unknown,
			instance: {
				customInstructions: { role: string; expectedOutput?: string };
			},
		) => ({
			systemPrompt: [
				instance.customInstructions.role,
				instance.customInstructions.expectedOutput,
			]
				.filter(Boolean)
				.join("\n\n"),
		}),
	);
	m.info.workflowType = "agentDraftPreviewWorkflow";
	m.info.workflowExecution.workflowId = "example-preview-workflow";
	m.access.mockResolvedValue(undefined);
	m.execute.mockResolvedValue({
		id: "example-document",
		title: "Delivery notes",
		revision: "b".repeat(64),
		text: "Verified delivery",
	});
	m.document.mockResolvedValue({
		id: "example-workspace-document",
		filename: "Delivery brief",
		revision: "c".repeat(64),
		text: "Selected workspace content",
		nextOffset: null,
	});
	m.findMany.mockResolvedValue([
		{
			id: "example-workspace-document",
			originalFilename: "Delivery brief",
			status: "READY",
		},
	]);
	m.catalog.mockResolvedValue({ documents: [], hasMore: false });
	m.skill.mockResolvedValue({
		id: "example-skill",
		name: "Delivery reporting",
		content: "Cite your sources",
		files: [],
	});
	m.tools = {
		fabric_get_project_document: {
			inputSchema: z.strictObject({ documentId: z.string() }),
			execute: m.execute,
		},
		fabric_create_project_document: {
			inputSchema: z.strictObject({}),
			execute: vi.fn(),
		},
		external_read: { inputSchema: z.strictObject({}), execute: vi.fn() },
	};
	m.sources = {
		fabric_get_project_document: {
			configId: "builtin",
			originalName: "fabric_get_project_document",
		},
		fabric_create_project_document: {
			configId: "builtin",
			originalName: "fabric_create_project_document",
		},
		external_read: {
			configId: "external",
			originalName: "fabric_get_project_document",
		},
	};
	m.turn.mockImplementation(async () => {
		try {
			const response = await prepareAgentTools(
				m.tools,
				m.sources as Record<string, AgentToolSource>,
			);
			m.visible = Object.keys(m.tools);
			return {
				success: true,
				response: response ?? "Preview answer",
				modelStep: {
					messages: [
						{ role: "assistant", content: "Preview answer" },
					],
					toolCalls: [],
				},
			};
		} catch (error) {
			m.caught = error;
			return { success: false, response: "", toolCalls: [] };
		}
	});
});
describe("read-only draft preview activities", () => {
	it("rejects unknown raw model arguments before a permissive Zod schema can strip them", async () => {
		const permissive = z.object({ documentId: z.string() });
		const raw = {
			documentId: "example-document",
			unexpected: "must not be silently removed",
		};
		expect(permissive.parse(raw)).toEqual({
			documentId: "example-document",
		});
		m.tools.fabric_get_project_document = {
			inputSchema: permissive,
			execute: m.execute,
		};
		await executeAgentPreviewModelStep({
			base,
			prepared,
			continuationMessages: [],
		});
		const exposed = m.tools.fabric_get_project_document as {
			inputSchema: Parameters<typeof asSchema>[0];
		};
		const modelSchema = asSchema(exposed.inputSchema);
		if (!modelSchema.validate) {
			throw new Error(
				"Preview model tool requires a raw input validator",
			);
		}
		expect(await modelSchema.validate(raw)).toMatchObject({
			success: false,
		});
		expect(
			await modelSchema.validate({ documentId: "example-document" }),
		).toMatchObject({
			success: true,
			value: { documentId: "example-document" },
		});
		expect(m.execute).not.toHaveBeenCalled();
	});
	it("includes expected output in the same instruction builder used by saved agents", async () => {
		const expectedOutput =
			"Return a cited delivery brief with risks and next steps.";
		const result = await prepareAgentPreview({
			...base,
			request: {
				...base.request,
				draft: { ...base.request.draft, expectedOutput },
			},
		});
		expect(m.buildContext).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				customInstructions: expect.objectContaining({
					role: base.request.draft.instructions,
					expectedOutput,
				}),
			}),
			expect.anything(),
			base.actor.userId,
			base.actor.organizationId,
		);
		expect(result.turn.systemPrompt).toContain(expectedOutput);
	});
	it("lets the model see only exact first-party project reads without executing callbacks", async () => {
		await expect(
			executeAgentPreviewModelStep({
				base,
				prepared,
				continuationMessages: [],
			}),
		).resolves.toMatchObject({ success: true });
		expect(m.visible).toEqual(["fabric_get_project_document"]);
		expect(m.execute).not.toHaveBeenCalled();
		expect(m.access).toHaveBeenCalledTimes(2);
		expect(m.turn.mock.calls[0][0]).toHaveProperty(
			"durableStep.continuationMessages",
			[],
		);
	});
	it("does not expose project read tools without an attached project", async () => {
		const noProject = {
			...base,
			request: {
				...base.request,
				draft: {
					...base.request.draft,
					projectId: undefined,
					capabilityIds: [],
				},
			},
		};
		await executeAgentPreviewModelStep({
			base: noProject,
			prepared,
			continuationMessages: [],
		});
		expect(m.visible).toEqual([]);
		expect(m.execute).not.toHaveBeenCalled();
	});
	it("executes one verified read with repeat authority checks and returns source provenance", async () => {
		const result = await read();
		expect(result).toMatchObject({
			call: { id: decision.id, name: decision.name, status: "success" },
			source: {
				id: "example-document",
				title: "Delivery notes",
				kind: "project_source",
				revision: "b".repeat(64),
			},
		});
		expect(m.execute).toHaveBeenCalledOnce();
		expect(m.execute).toHaveBeenCalledWith(
			decision.args,
			expect.objectContaining({
				toolCallId: decision.id,
				abortSignal: m.controller.signal,
			}),
		);
		expect(m.access.mock.calls.length).toBeGreaterThanOrEqual(3);
	});
	it.each([
		{ configId: "external", originalName: "fabric_get_project_document" },
		{ configId: "builtin", originalName: "fabric_create_project_document" },
	])("refuses changed or external source identity %j", async (source) => {
		await expect(
			executeAgentPreviewReadStep({
				base,
				prepared,
				decision: { ...decision, source },
			}),
		).rejects.toThrow();
		expect(m.execute).not.toHaveBeenCalled();
	});
	it("refuses a tool that advertises delegation even with an allowed first-party name", async () => {
		m.tools.fabric_get_project_document = {
			inputSchema: z.strictObject({ documentId: z.string() }),
			execute: m.execute,
			approvalBoundary: "delegation",
		};
		await expect(read()).rejects.toThrow();
		expect(m.execute).not.toHaveBeenCalled();
	});
	it.each([
		{ documentId: 17 },
		{ documentId: "example-document", unexpected: true },
	])(
		"refuses invalid/expanded arguments before dispatch %j",
		async (args) => {
			await expect(
				executeAgentPreviewReadStep({
					base,
					prepared,
					decision: { ...decision, args },
				}),
			).rejects.toThrow();
			expect(m.execute).not.toHaveBeenCalled();
		},
	);
	it("refuses revoked initial access before loading model tools", async () => {
		m.access.mockRejectedValue(new Error("Access revoked"));
		await expect(read()).rejects.toThrow("Access revoked");
		expect(m.turn).not.toHaveBeenCalled();
		expect(m.execute).not.toHaveBeenCalled();
	});
	it("does not return a read after access is revoked during dispatch", async () => {
		m.execute.mockImplementation(async () => {
			m.access.mockRejectedValue(new Error("Access revoked"));
			return {
				id: "example-document",
				title: "Private document",
				text: "Must not return",
			};
		});
		await expect(read()).rejects.toThrow();
	});
	it("does not turn a swallowed read failure into an empty successful read", async () => {
		m.execute.mockRejectedValue(new Error("private reader failure"));
		await expect(read()).rejects.toThrow();
	});
	it("refuses model output after current access is revoked", async () => {
		m.turn.mockImplementation(async () => {
			m.access.mockRejectedValue(new Error("Access revoked"));
			return {
				success: true,
				response: "Private answer",
				modelStep: { messages: [], toolCalls: [] },
			};
		});
		await expect(
			executeAgentPreviewModelStep({
				base,
				prepared,
				continuationMessages: [],
			}),
		).rejects.toThrow("Access revoked");
	});
	it("rejects the wrong workflow identity and actor/request hash before I/O", async () => {
		m.info.workflowType = "savedAgentWorkflow";
		await expect(read()).rejects.toMatchObject({
			type: "AGENT_PREVIEW_FORBIDDEN",
		});
		expect(m.access).not.toHaveBeenCalled();
		expect(m.turn).not.toHaveBeenCalled();
	});
	it("honors activity cancellation before dispatch", async () => {
		m.controller.abort(new Error("Preview cancelled"));
		await expect(read()).rejects.toThrow("Preview cancelled");
		expect(m.turn).not.toHaveBeenCalled();
		expect(m.execute).not.toHaveBeenCalled();
	});
	it("prepares only the explicitly selected workspace catalog and frozen skill text", async () => {
		const selected = {
			...base,
			request: {
				...base.request,
				draft: {
					...base.request.draft,
					workspaceIds: ["example-workspace"],
					workspaceDocumentFilters: [
						{
							workspaceId: "example-workspace",
							documentIds: ["example-workspace-document"],
						},
					],
					skillIds: ["example-skill"],
				},
			},
		};
		const result = await prepareAgentPreview(selected);
		expect(m.catalog).not.toHaveBeenCalled();
		expect(m.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					workspaceId: "example-workspace",
					id: { in: ["example-workspace-document"] },
				},
			}),
		);
		expect(result.documents.map((row) => row.id)).toEqual([
			"example-workspace-document",
		]);
		expect(result.turn.systemPrompt).toContain("Cite your sources");
		expect(result.turn.workspaceIds).toEqual([]);
		expect(result.sources).toMatchObject([
			{ id: "example-skill", kind: "skill" },
		]);
		expect(m.skill).toHaveBeenCalledWith("example-skill", base.actor);
	});
	it("reads only selected workspace documents with bounded revision-aware paging", async () => {
		const workspacePrepared = {
			...prepared,
			documents: [
				{
					id: "example-workspace-document",
					workspaceId: "example-workspace",
					title: "Delivery brief",
				},
			],
		};
		const workspaceDecision = {
			id: "example-workspace-call",
			name: "preview_read_workspace_document",
			args: {
				documentId: "example-workspace-document",
				offset: 12000,
				expectedRevision: "c".repeat(64),
			},
			source: {
				configId: "preview",
				originalName: "preview_read_workspace_document",
			},
		};
		const result = await executeAgentPreviewReadStep({
			base,
			prepared: workspacePrepared,
			decision: workspaceDecision,
		});
		expect(m.document).toHaveBeenCalledWith(base.actor, {
			workspaceId: "example-workspace",
			documentId: "example-workspace-document",
			offset: 12000,
			expectedRevision: "c".repeat(64),
			limit: 12000,
		});
		expect(result.source).toMatchObject({
			id: "example-workspace-document",
			kind: "workspace_document",
		});
	});
	it("refuses unselected workspace document IDs without a reader call", async () => {
		const workspacePrepared = {
			...prepared,
			documents: [
				{
					id: "example-workspace-document",
					workspaceId: "example-workspace",
					title: "Delivery brief",
				},
			],
		};
		await expect(
			executeAgentPreviewReadStep({
				base,
				prepared: workspacePrepared,
				decision: {
					id: "example-workspace-call",
					name: "preview_read_workspace_document",
					args: { documentId: "example-unselected-document" },
					source: {
						configId: "preview",
						originalName: "preview_read_workspace_document",
					},
				},
			}),
		).rejects.toThrow();
		expect(m.document).not.toHaveBeenCalled();
	});
	it("refuses processing documents before any model activity", async () => {
		m.findMany.mockResolvedValue([
			{
				id: "example-workspace-document",
				originalFilename: "Delivery brief",
				status: "PROCESSING",
			},
		]);
		const selected = {
			...base,
			request: {
				...base.request,
				draft: {
					...base.request.draft,
					workspaceIds: ["example-workspace"],
					workspaceDocumentFilters: [
						{
							workspaceId: "example-workspace",
							documentIds: ["example-workspace-document"],
						},
					],
				},
			},
		};
		await expect(prepareAgentPreview(selected)).rejects.toMatchObject({
			type: "AGENT_PREVIEW_NOT_READY",
		});
		expect(m.turn).not.toHaveBeenCalled();
	});
	it("refuses excessive workspace catalogs and model continuation payloads", async () => {
		m.catalog.mockResolvedValue({ documents: [], hasMore: true });
		const selected = {
			...base,
			request: {
				...base.request,
				draft: {
					...base.request.draft,
					workspaceIds: ["example-workspace"],
				},
			},
		};
		await expect(prepareAgentPreview(selected)).rejects.toMatchObject({
			type: "AGENT_PREVIEW_TOO_LARGE",
		});
		await expect(
			executeAgentPreviewModelStep({
				base,
				prepared,
				continuationMessages: [
					{ role: "user", content: "x".repeat(132000) },
				],
			}),
		).rejects.toMatchObject({ type: "AGENT_PREVIEW_TOO_LARGE" });
		expect(m.turn).not.toHaveBeenCalled();
	});
});

it("refuses duplicate model tool-call IDs before any read", async () => {
	m.turn.mockResolvedValue({
		success: true,
		response: "",
		modelStep: { messages: [], toolCalls: [decision, { ...decision }] },
	});
	await expect(
		executeAgentPreviewModelStep({
			base,
			prepared,
			continuationMessages: [],
		}),
	).rejects.toMatchObject({ type: "AGENT_PREVIEW_MODEL_INVALID_DECISION" });
	expect(m.execute).not.toHaveBeenCalled();
});
it("records a safe reason for a source read that returns an error", async () => {
	m.execute.mockResolvedValue({ error: "private source details" });
	const result = await read();
	expect(result.call.status).toBe("error");
	expect(result.call.message).toContain("current access");
	expect(result.call.message).not.toContain("private");
});
