import { createHash, randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
	db,
	memorySourceBoundary,
	recordAuditTx,
	validateMemoryFile,
} from "@repo/database";
import { z } from "zod";
import {
	auditRequestFields,
	recordAuditFromRequest,
	resolveActor,
} from "../../../../lib/audit";
import { markCuratedAuditWritten } from "../../../../orpc/middleware/audit-timing-middleware";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	type AgentDefinition,
	exportAgentDefinition,
	getAgentImplementationAvailability,
	MAX_AGENT_DEFINITION_BYTES,
	PORTABLE_SKILL_PATH,
	parseAgentDefinition,
	serializeAgentDefinition,
} from "../../lib/agent-definition";

const importInput = z.object({
	organizationId: z.string().min(1),
	document: z.string().min(1).max(MAX_AGENT_DEFINITION_BYTES),
});

const notices = [
	"Imports create a draft with no connected tools, knowledge access, triggers, deployments, API exposure, or existing approvals. Configure these in the destination organization before publishing.",
	"Model availability must be reviewed in the destination organization. Only model name, temperature, topP and maxTokens are portable in this version.",
	"Instructions and skill text are included verbatim. Review their contents before sharing or running the agent. Conversation history and learned memory are excluded.",
];

function definitionMetadata(definition: AgentDefinition) {
	return definition.apiVersion === "fabric.ai/v2"
		? {
				portableDefinitionVersion: definition.apiVersion,
				portableImplementation: definition.implementation,
				portableBindings: definition.logicalBindings,
				...(definition.expectedOutput === undefined
					? {}
					: { expectedOutput: definition.expectedOutput }),
			}
		: {
				portableDefinitionVersion: definition.apiVersion,
				portableImplementation: { kind: "native" as const },
				portableBindings: [],
			};
}
function definitionNotices(definition: AgentDefinition) {
	const availability = getAgentImplementationAvailability(
		definitionMetadata(definition),
	);
	return [
		...notices,
		...(definition.apiVersion === "fabric.ai/v2" &&
		definition.logicalBindings.length
			? [
					"Logical bindings are unresolved declarations. Destination connections, project access and operation grants must be explicitly selected and authorized before activation.",
				]
			: []),
		...(availability.reason ? [availability.reason] : []),
	];
}

function parseDocument(document: string): AgentDefinition {
	try {
		const definition = parseAgentDefinition(document);
		for (const skill of definition.skills) {
			if (!validateMemoryFile(skill.path, skill.content).valid) {
				throw new Error("Invalid skill file");
			}
		}
		return definition;
	} catch {
		// Parser errors may contain the offending text, including pasted credentials.
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Invalid agent definition. Use fabric.ai/v1 or fabric.ai/v2 JSON or YAML, unique skill paths, no YAML aliases, and a file smaller than 1 MB.",
		});
	}
}

export const previewAgentDefinitionProcedure = tenantProtectedProcedure
	.input(importInput)
	.use(
		requireInputOrgPermission(Permissions.AGENT_TEMPLATE_MANAGE, {
			requireOrganization: true,
		}),
	)
	.handler(async ({ input }) => {
		const definition = parseDocument(input.document);
		return {
			definition,
			notices: definitionNotices(definition),
			implementationAvailability: getAgentImplementationAvailability(
				definitionMetadata(definition),
			),
		};
	});

export const exportAgentDefinitionProcedure = tenantProtectedProcedure
	.input(
		z.object({
			organizationId: z.string().min(1),
			id: z.string().min(1),
			format: z.enum(["json", "yaml"]),
		}),
	)
	.use(
		requireInputOrgPermission(Permissions.AGENT_TEMPLATE_READ, {
			requireOrganization: true,
		}),
	)
	.handler(async ({ input, context }) => {
		const instance = await db.agentTemplateInstance.findFirst({
			where: { id: input.id, organizationId: input.organizationId },
			include: {
				template: true,
				integrationConfigurations: {
					where: { isEnabled: true },
					select: { integrationType: true },
				},
				mcpServerConfigurations: {
					where: { isEnabled: true },
					select: { name: true },
				},
			},
		});
		if (!instance) {
			throw new ORPCError("NOT_FOUND");
		}
		// Templates are reusable but tenant-owned instructions cannot cross a boundary.
		if (
			instance.template.scope !== "SYSTEM" &&
			instance.template.organizationId !== input.organizationId
		) {
			throw new ORPCError("NOT_FOUND");
		}
		const boundary = await memorySourceBoundary(
			{ userId: context.user.id, organizationId: input.organizationId },
			{
				agentInstanceId: instance.id,
				organizationId: input.organizationId,
				fileType: "SKILL",
			},
		);
		const memoryFiles = await db.agentMemoryFile.findMany({
			where: boundary.where,
			orderBy: { path: "asc" },
		});
		await boundary.revalidate();
		const skippedFiles = memoryFiles.filter(
			(file) =>
				file.lastModifiedBy === "agent" ||
				!PORTABLE_SKILL_PATH.test(file.path),
		);
		const portableFiles = memoryFiles.filter(
			(file) => !skippedFiles.includes(file),
		);
		let document: string;
		try {
			document = serializeAgentDefinition(
				exportAgentDefinition({
					...instance,
					memoryFiles: portableFiles,
				}),
				input.format,
			);
		} catch {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This agent contains settings or skill paths that are not supported by the portable definition format.",
			});
		}
		recordAuditFromRequest(context, {
			action: "org.agent_definition.exported",
			organizationId: input.organizationId,
			resource: { type: "agent_instance", id: instance.id },
			metadata: { format: input.format, version: instance.version },
		});
		const availability = getAgentImplementationAvailability(
			instance.customInstructions,
		);
		return {
			document,
			filename: `agent.${input.format}`,
			notices: [
				...notices,
				...(availability.reason ? [availability.reason] : []),
				...skippedFiles.map((file) => `Skipped file: ${file.path}`),
			],
		};
	});

export const importAgentDefinitionProcedure = tenantProtectedProcedure
	.input(importInput)
	.use(
		requireInputOrgPermission(Permissions.AGENT_TEMPLATE_MANAGE, {
			requireOrganization: true,
		}),
	)
	.handler(async ({ input, context }) => {
		const definition = parseDocument(input.document);
		const { model, ...modelConfig } = definition.model;
		const { template: instructions, ...customInstructions } =
			definition.instructions;
		const instance = await db.$transaction(async (tx) => {
			const template = await tx.agentTemplate.create({
				data: {
					slug: `imported-${randomUUID()}`,
					name: definition.name,
					displayName: definition.name,
					description: definition.description,
					instructions,
					category: "GENERAL",
					scope: "ORGANIZATION",
					organizationId: input.organizationId,
					userId: context.user.id,
					isPublished: false,
					isFeatured: false,
				},
			});
			const created = await tx.agentTemplateInstance.create({
				data: {
					templateId: template.id,
					name: definition.name,
					description: definition.description,
					organizationId: input.organizationId,
					userId: context.user.id,
					status: "DRAFT",
					version: 1,
					customInstructions: {
						...customInstructions,
						portableRequirements: definition.requirements,
						...definitionMetadata(definition),
					},
					modelOverride: model,
					modelConfig,
					executionMode: definition.execution.mode,
					goal: definition.execution.goal,
					maxIterations: definition.execution.maxIterations,
					successCriteria: definition.execution.successCriteria,
					toolConnections: {},
					triggers: [],
					workspaceIds: [],
					isApiExposed: false,
					memoryAutoApprove: false,
					memoryFiles: {
						create: definition.skills.map((skill) => ({
							path: skill.path,
							content: skill.content,
							contentHash: createHash("sha256")
								.update(skill.content)
								.digest("hex"),
							fileType: "SKILL",
							isEnabled: skill.enabled,
							organizationId: input.organizationId,
							userId: context.user.id,
							lastModifiedBy: "user",
						})),
					},
				},
				select: { id: true, sId: true, version: true, status: true },
			});
			await recordAuditTx(tx, {
				action: "org.agent_definition.imported",
				actor: resolveActor(context, undefined),
				...auditRequestFields(context),
				organizationId: input.organizationId,
				resource: { type: "agent_instance", id: created.id },
				metadata: {
					apiVersion: definition.apiVersion,
					skillCount: definition.skills.length,
					requirementCount: definition.requirements.length,
				},
			});
			return created;
		});
		markCuratedAuditWritten();
		return {
			instance,
			notices: definitionNotices(definition),
			implementationAvailability: getAgentImplementationAvailability(
				definitionMetadata(definition),
			),
		};
	});
