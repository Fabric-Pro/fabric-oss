/**
 * Coding Instructions sets over MCP (spec 2026-11-11 §4.4, §4.5): list,
 * create, rename / reassign and delete a project's named instruction sets,
 * each applying to the code repositories chosen for it. The same query code
 * as the API (`@repo/database` instruction-set-management), so the Portal,
 * the Fabric Agent and a coding tool can never disagree about a set.
 *
 * Gates, per call: the declared scope, then the gateway's project gate with
 * the caller's LIVE permission (the Coding Instructions tab's own rule),
 * which answers an unreachable or cross-organization project as not found.
 * Listing needs `instructions:read` and `INSTRUCTION_READ`. Changing a set is
 * project configuration: `projects:write` and `INSTRUCTION_UPDATE` — never
 * `instructions:write`, a scope a viewer may mint on the promise that it
 * only proposes changes for review.
 */

import {
	defineFabricTools,
	TOOL_ANNOTATIONS,
} from "@repo/temporal/fabric-tool-definition";
import { errorResult, jsonResult } from "./tool-results";
import {
	type PlatformToolHandler,
	type ToolFamily,
	toolFamily,
} from "./tools/tool-family";
import type { GatewaySession, ToolCallResult } from "./types";

type ProjectAccess =
	| { status: "allowed"; organizationId: string | null }
	| { status: "not-found" }
	| { status: "forbidden" };

/** The gateway's project gate, as `platform-tools.ts` implements it. */
export interface InstructionSetToolAccess {
	resolveGatewayProjectWriteAccessWithHost(
		projectId: string,
		session: GatewaySession,
		permission: "INSTRUCTION_READ" | "INSTRUCTION_UPDATE",
	): Promise<ProjectAccess>;
}

const repositoryIds = {
	type: "array",
	items: { type: "string" },
	maxItems: 200,
	description: "Ids from fabric_list_code_repositories; replaces the list.",
} as const;

const INSTRUCTION_SET_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_list_instruction_sets",
		description:
			"List the project's Coding Instructions sets: folder and repositories of each.",
		inputSchema: {
			type: "object",
			properties: { projectId: { type: "string" } },
			required: ["projectId"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "instructions:read",
	},
	{
		name: "fabric_create_instruction_set",
		description:
			"Create a Coding Instructions set for chosen code repositories.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				name: { type: "string", maxLength: 80 },
				slug: { type: "string", maxLength: 40 },
				repositoryIntegrationIds: repositoryIds,
			},
			required: ["projectId", "name"],
		},
		annotations: TOOL_ANNOTATIONS.write,
		scope: "projects:write",
	},
	{
		name: "fabric_update_instruction_set",
		description:
			"Rename a Coding Instructions set or replace its code repositories. Ask the person before removing any.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				setId: { type: "string" },
				name: { type: "string", maxLength: 80 },
				repositoryIntegrationIds: repositoryIds,
			},
			required: ["projectId", "setId"],
		},
		annotations: TOOL_ANNOTATIONS.idempotentWrite,
		scope: "projects:write",
	},
	{
		name: "fabric_delete_instruction_set",
		description:
			"Delete a Coding Instructions set (not the default); its files stay in git. Ask the person first.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				setId: { type: "string" },
			},
			required: ["projectId", "setId"],
		},
		annotations: TOOL_ANNOTATIONS.rewrite,
		scope: "projects:write",
	},
]);

function text(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

function ids(
	args: Record<string, unknown>,
	key: string,
): string[] | undefined | null {
	const value = args[key];
	if (value === undefined) {
		return undefined;
	}
	if (
		!Array.isArray(value) ||
		value.length > 200 ||
		!value.every((v) => typeof v === "string" && v !== "")
	) {
		return null;
	}
	return value as string[];
}

type Gate =
	| { ok: true; projectId: string; organizationId: string }
	| { ok: false; result: ToolCallResult };

/**
 * Each handler asks the gateway's project gate itself
 * (`access.resolveGatewayProjectWriteAccessWithHost`), so the authorization
 * coverage scan sees the gate in every handler body; this turns the answer
 * into a project and organization, or the refusal to return.
 */
function gate(
	projectId: string,
	resolved: ProjectAccess,
	permission: "INSTRUCTION_READ" | "INSTRUCTION_UPDATE",
): Gate {
	if (resolved.status === "allowed" && resolved.organizationId) {
		return { ok: true, projectId, organizationId: resolved.organizationId };
	}
	if (resolved.status === "forbidden") {
		return {
			ok: false,
			result: errorResult(
				permission === "INSTRUCTION_READ"
					? "No permission to read this project's Coding Instructions"
					: "No permission to change this project's Coding Instructions",
			),
		};
	}
	// Not found, and the fail-closed arm: Coding Instructions are an
	// organization surface (ADR-018).
	return {
		ok: false,
		result: errorResult("Project not found or access denied"),
	};
}

function setView(set: {
	id: string;
	name: string;
	slug: string;
	isDefault: boolean;
	repositoryIntegrationIds: string[];
	folder: string;
	excludedFolders: string[];
}) {
	return {
		id: set.id,
		name: set.name,
		slug: set.slug,
		isDefault: set.isDefault,
		repositoryIntegrationIds: set.repositoryIntegrationIds,
		folder: set.folder,
		excludedFolders: set.excludedFolders,
	};
}

async function refusal(error: unknown): Promise<ToolCallResult> {
	const { InstructionSetError } = await import("@repo/database");
	if (error instanceof InstructionSetError) {
		return errorResult(error.message, {
			reason: error.code,
			...error.details,
		});
	}
	throw error;
}

async function audit(
	session: GatewaySession,
	event: {
		action:
			| "project.instructions.set_created"
			| "project.instructions.set_updated"
			| "project.instructions.set_deleted";
		organizationId: string;
		projectId: string;
		set: { id: string; name: string };
		metadata: Record<string, unknown>;
	},
): Promise<void> {
	const { recordAudit } = await import("@repo/database");
	await recordAudit({
		action: event.action,
		category: "project",
		organizationId: event.organizationId,
		projectId: event.projectId,
		resource: {
			type: "project_instruction_set",
			id: event.set.id,
			name: event.set.name,
		},
		actor: {
			type:
				session.credential === "session"
					? "user"
					: session.credential === "oauth"
						? "agent"
						: "api_key",
			userId: session.userId,
		},
		metadata: { ...event.metadata, via: "mcp" },
	});
}

async function handleListInstructionSets(
	access: InstructionSetToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const projectId = text(args, "projectId");
	if (!projectId) {
		return errorResult("projectId is required");
	}
	const g = gate(
		projectId,
		await access.resolveGatewayProjectWriteAccessWithHost(
			projectId,
			session,
			"INSTRUCTION_READ",
		),
		"INSTRUCTION_READ",
	);
	if (!g.ok) {
		return g.result;
	}
	const { listInstructionSets } = await import("@repo/database");
	const sets = await listInstructionSets(g.projectId);
	return jsonResult({ sets: sets.map(setView) });
}

async function handleCreateInstructionSet(
	access: InstructionSetToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const name = text(args, "name");
	const repositoryIntegrationIds = ids(args, "repositoryIntegrationIds");
	if (!name) {
		return errorResult("name is required");
	}
	if (repositoryIntegrationIds === null) {
		return errorResult("repositoryIntegrationIds must be a list of ids");
	}
	const projectId = text(args, "projectId");
	if (!projectId) {
		return errorResult("projectId is required");
	}
	const g = gate(
		projectId,
		await access.resolveGatewayProjectWriteAccessWithHost(
			projectId,
			session,
			"INSTRUCTION_UPDATE",
		),
		"INSTRUCTION_UPDATE",
	);
	if (!g.ok) {
		return g.result;
	}
	const { createInstructionSet } = await import("@repo/database");
	try {
		const set = await createInstructionSet({
			projectId: g.projectId,
			organizationId: g.organizationId,
			userId: session.userId,
			name,
			slug: text(args, "slug"),
			repositoryIntegrationIds: repositoryIntegrationIds ?? [],
		});
		await audit(session, {
			action: "project.instructions.set_created",
			organizationId: g.organizationId,
			projectId: g.projectId,
			set,
			metadata: {
				slug: set.slug,
				repositoryCount: set.repositoryIntegrationIds.length,
			},
		});
		return jsonResult({ set: setView(set) });
	} catch (error) {
		return refusal(error);
	}
}

async function handleUpdateInstructionSet(
	access: InstructionSetToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const setId = text(args, "setId");
	const repositoryIntegrationIds = ids(args, "repositoryIntegrationIds");
	if (!setId) {
		return errorResult("setId is required");
	}
	if (repositoryIntegrationIds === null) {
		return errorResult("repositoryIntegrationIds must be a list of ids");
	}
	const projectId = text(args, "projectId");
	if (!projectId) {
		return errorResult("projectId is required");
	}
	const g = gate(
		projectId,
		await access.resolveGatewayProjectWriteAccessWithHost(
			projectId,
			session,
			"INSTRUCTION_UPDATE",
		),
		"INSTRUCTION_UPDATE",
	);
	if (!g.ok) {
		return g.result;
	}
	const { updateInstructionSet } = await import("@repo/database");
	try {
		const { set, before } = await updateInstructionSet({
			projectId: g.projectId,
			organizationId: g.organizationId,
			userId: session.userId,
			setId,
			name: text(args, "name"),
			repositoryIntegrationIds,
		});
		await audit(session, {
			action: "project.instructions.set_updated",
			organizationId: g.organizationId,
			projectId: g.projectId,
			set,
			metadata: {
				renamed: before.name !== set.name,
				repositoryCount: set.repositoryIntegrationIds.length,
				previousRepositoryCount: before.repositoryIntegrationIds.length,
			},
		});
		return jsonResult({ set: setView(set) });
	} catch (error) {
		return refusal(error);
	}
}

async function handleDeleteInstructionSet(
	access: InstructionSetToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const setId = text(args, "setId");
	if (!setId) {
		return errorResult("setId is required");
	}
	const projectId = text(args, "projectId");
	if (!projectId) {
		return errorResult("projectId is required");
	}
	const g = gate(
		projectId,
		await access.resolveGatewayProjectWriteAccessWithHost(
			projectId,
			session,
			"INSTRUCTION_UPDATE",
		),
		"INSTRUCTION_UPDATE",
	);
	if (!g.ok) {
		return g.result;
	}
	const { deleteInstructionSet } = await import("@repo/database");
	try {
		const set = await deleteInstructionSet({
			projectId: g.projectId,
			setId,
		});
		await audit(session, {
			action: "project.instructions.set_deleted",
			organizationId: g.organizationId,
			projectId: g.projectId,
			set,
			metadata: { slug: set.slug },
		});
		return jsonResult({
			deleted: { id: set.id, name: set.name },
			message:
				"The set is gone from Fabric; its files stay in the instructions repository.",
		});
	} catch (error) {
		return refusal(error);
	}
}

export function createInstructionSetTools(
	access: InstructionSetToolAccess,
): ToolFamily {
	return toolFamily(
		INSTRUCTION_SET_TOOL_DEFINITIONS,
		new Map<string, PlatformToolHandler>([
			[
				"fabric_list_instruction_sets",
				(a, s) => handleListInstructionSets(access, a, s),
			],
			[
				"fabric_create_instruction_set",
				(a, s) => handleCreateInstructionSet(access, a, s),
			],
			[
				"fabric_update_instruction_set",
				(a, s) => handleUpdateInstructionSet(access, a, s),
			],
			[
				"fabric_delete_instruction_set",
				(a, s) => handleDeleteInstructionSet(access, a, s),
			],
		]),
	);
}
