import {
	SKILL_AUTHORING_MAX_BYTES,
	SKILL_IMPORT_MAX_REQUEST_BYTES,
	skillAssistSchema,
	skillFileReadSchema,
	skillImportCreateSchema,
	skillImportFileSchema,
	skillImportPreviewSchema,
} from "@repo/ai/skill-authoring-contracts";
import {
	type SkillActor,
	SkillError,
	skillArchiveSchema,
	skillCreateSchema,
	skillDeleteSchema,
	skillGetSchema,
	skillGovernanceReadSchema,
	skillGovernanceUpdateSchema,
	skillListSchema,
	skillPublishSchema,
	skillRestoreSchema,
	skillUpdateSchema,
} from "@repo/ai/skill-contracts";
import type { RecordAuditFromRequestInput } from "@repo/api/lib/audit";
import type { FabricToolDefinition } from "@repo/temporal/fabric-tool-definition";
import { z } from "zod";
import { errorResult, jsonResult } from "../tool-results";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

type Audit = (event: RecordAuditFromRequestInput) => unknown;
export function createSkillTools() {
	const definitions: FabricToolDefinition[] = [];
	const handlers = new Map<string, PlatformToolHandler>();
	function add<S extends z.ZodType<Record<string, unknown>>>(
		name: string,
		scope: string,
		write: boolean,
		description: string,
		schema: S,
		cap: number,
		command: (
			actor: SkillActor,
			input: z.output<S>,
			audit: Audit,
		) => Promise<unknown>,
	) {
		const { $schema: _, ...inputSchema } = z.toJSONSchema(schema);
		definitions.push({
			name,
			scope,
			description,
			inputSchema,
			annotations: {
				readOnlyHint: !write,
				destructiveHint: name === "fabric_delete_skill",
				idempotentHint: !write,
			},
			...(write ? { confirm: "always" as const } : {}),
		});
		handlers.set(name, async (args, session) => {
			if (
				!session.organizationId ||
				session.projectId ||
				session.pinnedProjectId ||
				session.pageProjectId ||
				session.credential === "service"
			) {
				return errorResult(
					"Skill authoring and governance require an organization connection for the current member.",
					{ code: "FORBIDDEN" },
				);
			}
			if (
				session.credential !== "session" &&
				!session.scopes.includes(scope) &&
				!session.scopes.includes("*")
			) {
				return errorResult(
					`This skill action requires explicit ${scope} scope.`,
					{ code: "INSUFFICIENT_SCOPE" },
				);
			}
			if (
				new TextEncoder().encode(JSON.stringify(args)).byteLength > cap
			) {
				return errorResult("Skill request exceeds the allowed size.", {
					code: "BAD_REQUEST",
				});
			}
			const parsed = schema.safeParse(args);
			if (!parsed.success) {
				return errorResult(
					"Use the declared skill action schema; actor, scopes and organization overrides are not accepted.",
					{ code: "BAD_REQUEST" },
				);
			}
			if (
				name === "fabric_create_skill" &&
				session.credential !== "session" &&
				(args.isPublished === true || args.isDiscoverable === true) &&
				!session.scopes.includes("skills:publish") &&
				!session.scopes.includes("*")
			) {
				return errorResult(
					"Publishing or agent discovery requires explicit skills:publish scope.",
					{ code: "INSUFFICIENT_SCOPE" },
				);
			}
			const request =
				name === "fabric_list_skills" &&
				args.tab === undefined &&
				args.isDiscoverable === undefined &&
				args.isPublished !== false
					? { ...parsed.data, isDiscoverable: true }
					: parsed.data;
			try {
				return jsonResult(
					await command(
						{
							userId: session.userId,
							organizationId: session.organizationId,
							external: session.credential !== "session",
						},
						request,
						async (event) => {
							const { recordAudit } = await import(
								"@repo/database"
							);
							return recordAudit({
								...event,
								actor: {
									type:
										session.credential === "session"
											? "user"
											: session.credential === "oauth"
												? "agent"
												: "api_key",
									userId: session.userId,
								},
								metadata: {
									...(event.metadata ?? {}),
									via: "mcp",
								},
							});
						},
					),
				);
			} catch (error) {
				return error instanceof SkillError
					? errorResult(error.message, { code: error.code })
					: errorResult(
							"The skill action could not be confirmed. Inspect current state before retrying.",
							{ code: "SERVICE_UNAVAILABLE" },
						);
			}
		});
	}
	add(
		"fabric_list_skills",
		"skills:read",
		false,
		"Discover agent-available skills by default. For explicit authorized catalog management, select a tab (organization, builtin, drafts or archived) or an isDiscoverable filter. Member availability is not a data-access grant; manual references remain subject to current read permissions.",
		skillListSchema,
		1024 * 1024,
		async (actor, input, _audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-commands")
			).listSkillsCommand(actor, input),
	);
	add(
		"fabric_get_skill",
		"skills:read",
		false,
		"Read an authorized skill and its file manifest. Does not execute files.",
		skillGetSchema,
		1024 * 1024,
		async (actor, input, _audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-commands")
			).getSkillCommand(actor, input),
	);
	add(
		"fabric_create_skill",
		"skills:write",
		true,
		"Create your own skill draft. Publication/discovery additionally requires skills:publish and current organization policy.",
		skillCreateSchema,
		1024 * 1024,
		async (actor, input, audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-commands")
			).createSkillCommand(actor, input, audit),
	);
	add(
		"fabric_update_skill",
		"skills:write",
		true,
		"Update your own skill using its expected version. Does not change publication or agent discovery.",
		skillUpdateSchema,
		1024 * 1024,
		async (actor, input, audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-commands")
			).updateSkillCommand(actor, input, audit),
	);
	add(
		"fabric_archive_skill",
		"skills:write",
		true,
		"Archive your own skill so it is not available for reuse. Does not permanently delete it.",
		skillArchiveSchema,
		1024 * 1024,
		async (actor, input, audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-commands")
			).archiveSkillCommand(actor, input, audit),
	);
	add(
		"fabric_restore_skill",
		"skills:write",
		true,
		"Restore your own archived skill as a private draft.",
		skillRestoreSchema,
		1024 * 1024,
		async (actor, input, audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-commands")
			).restoreSkillCommand(actor, input, audit),
	);
	add(
		"fabric_publish_skill",
		"skills:publish",
		true,
		"Set your own skill availability to members, agents or draft using expectedVersion and current policy.",
		skillPublishSchema,
		1024 * 1024,
		async (actor, input, audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-commands")
			).publishSkillCommand(actor, input, audit),
	);
	add(
		"fabric_delete_skill",
		"skills:write",
		true,
		"Permanently delete your own skill. Requires current delete permission; archive is the reversible alternative.",
		skillDeleteSchema,
		1024 * 1024,
		async (actor, input, audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-commands")
			).deleteSkillCommand(actor, input, audit),
	);
	add(
		"fabric_get_skill_governance",
		"governance:read",
		false,
		"Read the three organization policies for skill creation, publication and agent discovery.",
		skillGovernanceReadSchema,
		1024 * 1024,
		async (actor, input, _audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-commands")
			).getSkillGovernanceCommand(actor, input),
	);
	add(
		"fabric_update_skill_governance",
		"governance:write",
		true,
		"Change organization skill policies with expectedRevision. Current owner/administrator permission is required.",
		skillGovernanceUpdateSchema,
		1024 * 1024,
		async (actor, input, audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-commands")
			).updateSkillGovernanceCommand(actor, input, audit),
	);
	add(
		"fabric_assist_skill",
		"skills:write",
		true,
		"Ask the configured AI provider for a reviewed skill proposal. Does not save or apply it automatically.",
		skillAssistSchema,
		SKILL_AUTHORING_MAX_BYTES,
		async (actor, input, audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-authoring")
			).assistSkillCommand(actor, input, audit),
	);
	add(
		"fabric_preview_skill_import",
		"skills:write",
		false,
		"Inspect an explicit uploaded Markdown/ZIP file or public GitHub source. Never runs scripts; private repositories require file upload.",
		skillImportPreviewSchema,
		SKILL_IMPORT_MAX_REQUEST_BYTES,
		async (actor, input, audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-authoring")
			).previewSkillImportCommand(actor, input, audit),
	);
	add(
		"fabric_create_skill_import",
		"skills:write",
		true,
		"Create one inspected import candidate as a private draft using candidateKey and expectedHash. Does not publish or enable discovery.",
		skillImportCreateSchema,
		SKILL_IMPORT_MAX_REQUEST_BYTES,
		async (actor, input, audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-authoring")
			).createSkillImportCommand(actor, input, audit),
	);
	add(
		"fabric_read_skill_file",
		"skills:read",
		false,
		"Read one authorized persisted skill file with its inspected version. Text or base64 only; does not execute scripts.",
		skillFileReadSchema,
		1024 * 1024,
		async (actor, input, audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-authoring")
			).readSkillFileCommand(actor, input, audit),
	);
	add(
		"fabric_read_skill_import_file",
		"skills:write",
		false,
		"Read one file from an explicitly inspected import candidate using source hash and path. Never executes files.",
		skillImportFileSchema,
		SKILL_IMPORT_MAX_REQUEST_BYTES,
		async (actor, input, audit) =>
			(
				await import("@repo/api/modules/skills/lib/skill-authoring")
			).readSkillImportFileCommand(actor, input, audit),
	);
	return toolFamily(definitions, handlers);
}
