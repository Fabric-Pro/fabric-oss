/**
 * Fabric MCP Gateway - Frame tools
 *
 * A Frame is a page the agent writes: HTML, a diagram, a report. Two surfaces
 * show them. A project's Artifacts tab lists the project's frames
 * (`surface: "artifact"`); an organization Workspace is a frame the people of
 * the organization open from the Workspaces page (`surface: "workspace"`). So
 * "put this in my workspace" is `fabric_update_frame` on that frame, and the
 * frame the user has open is the default target.
 *
 * A page on a surface runs in a locked sandbox. Its script reaches Fabric only
 * through `window.fabric`, which asks the host page to call a Fabric tool as the
 * viewer, and only the tools the page declares in `runtimeTools`. That is why
 * the names are checked here, against the tool table, when the page is saved
 * (`./runtime-tools-refusal`), and again on every call a page makes
 * (`../page-call-guard`).
 *
 * The tools' definitions are Fabric's one list
 * (`@repo/temporal/fabric-frame-tool-definitions`); this module is their
 * handlers. Access to frames is decided in the frame service; nothing here
 * widens it. What this module adds is where a new frame goes by default: the
 * project the user is looking at, never one the service has not checked.
 */

import {
	frameExportStartSchema,
	frameRevokeSharingSchema,
	frameShareSchema,
	frameSharingMutationDto,
} from "@repo/api/modules/frames/lib/frame-operation-contracts";
import { FRAME_SURFACES } from "@repo/database";
import {
	FABRIC_FRAME_TOOL_DEFINITIONS,
	FRAME_REVIEW_TOOL_NAMES,
} from "@repo/temporal/fabric-frame-tool-definitions";
import { errorResult, jsonResult } from "../tool-results";
import type { GatewaySession, ToolCallResult } from "../types";
import {
	legacyFrameIdOf,
	nonEmptyString,
	organizationSlug,
	pageUrl,
	withPageUrl,
} from "./frame-context";
import {
	type PageToolValidator,
	runtimeToolsRefusal,
} from "./runtime-tools-refusal";
import {
	type PlatformToolHandler,
	type ToolFamily,
	toolFamily,
} from "./tool-family";

/**
 * The frame service is the one dependency loaded on first use. It reaches the
 * AI SDK and the billing stack, which a gateway answering a project read or a
 * workflow list has no reason to load (nor any test of those to stub); every
 * other import of this module is static.
 */
const frameService = () => import("@repo/temporal/frame-service");

/**
 * Where a new frame goes. A project the caller names wins; otherwise the
 * project the user is looking at, which the frame service still checks like any
 * named project. A Workspace belongs to the organization, so it takes a project
 * only when one is named.
 */
function placementProjectId(
	args: Record<string, unknown>,
	session: GatewaySession,
): string | undefined {
	const named = nonEmptyString(args.projectId);
	if (named || args.surface === "workspace") {
		return named;
	}
	return session.actingContext?.projectId ?? session.projectId ?? undefined;
}

/**
 * A new page goes where the chat was opened from: the Workspaces page makes a
 * Workspace and a project's Artifacts tab an artifact, when the caller names no
 * surface. A chat opened anywhere else leaves it to the caller.
 */
function withDefaultSurface(
	args: Record<string, unknown>,
	session: GatewaySession,
): Record<string, unknown> {
	const surface = session.actingContext?.surface;
	return args.surface === undefined && surface ? { ...args, surface } : args;
}

/** The frame an update or read means when it names none: the open Workspace. */
function withDefaultFrameId(
	args: Record<string, unknown>,
	session: GatewaySession,
): Record<string, unknown> {
	return { ...args, frameId: legacyFrameIdOf(args, session) };
}

/**
 * What a create answers: where the page is, never its content. The agent has
 * just written the content and the database holds it; echoing it back costs
 * the model its tokens, and a long page overruns the Orchestrator's cap on a
 * tool result, which replaces the whole answer and strands the chat without
 * the frame id.
 */
function withoutContent<T extends { content: string }>(
	frame: T,
): Omit<T, "content"> {
	const { content: _content, ...rest } = frame;
	return rest;
}

function handleCreateFrame(
	pageMayDeclare: PageToolValidator,
): PlatformToolHandler {
	return async (requestedArgs, session) => {
		const refusal = await runtimeToolsRefusal(
			requestedArgs,
			pageMayDeclare,
			session,
		);
		if (refusal) {
			return refusal;
		}
		const args = withDefaultSurface(requestedArgs, session);
		const { createFirstClassFrame } = await frameService();
		const result = await createFirstClassFrame({
			args,
			userId: session.userId,
			organizationId: session.organizationId || undefined,
			projectId: placementProjectId(args, session),
			runtimeTools: args.runtimeTools,
			shareScope:
				args.sharedWithOrganization === false ? "PRIVATE" : undefined,
			conversationId: session.actingContext?.conversationId,
			// The generation's usage rows go to the same chat. The worker sends
			// only a route-verified conversation here, and the acting grant
			// binds it (checkActingGrant).
			usageConversationId: session.actingContext?.conversationId,
			sourceRunType: "MCP_GATEWAY",
			sourceRunId: session.sessionId,
		});
		return "error" in result
			? errorResult(String(result.error || "Unknown frame error"))
			: jsonResult(await withPageUrl(withoutContent(result), session));
	};
}

async function handleCreateSlideshow(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { createFirstClassFrame } = await frameService();
	const result = await createFirstClassFrame({
		args: { ...args, kind: "slideshow" },
		userId: session.userId,
		organizationId: session.organizationId || undefined,
		conversationId: session.actingContext?.conversationId,
		usageConversationId: session.actingContext?.conversationId,
		sourceRunType: "MCP_GATEWAY",
		sourceRunId: session.sessionId,
	});
	return "error" in result
		? errorResult(String(result.error || "Unknown frame error"))
		: jsonResult(withoutContent(result));
}

function handleUpdateFrame(
	pageMayDeclare: PageToolValidator,
): PlatformToolHandler {
	return async (args, session) => {
		if (
			typeof args.expectedUpdatedAt !== "string" ||
			!Number.isFinite(Date.parse(args.expectedUpdatedAt))
		) {
			return errorResult(
				"Read the frame and provide its expectedUpdatedAt revision before editing.",
			);
		}
		const refusal = await runtimeToolsRefusal(
			args,
			pageMayDeclare,
			session,
		);
		if (refusal) {
			return refusal;
		}
		const { updateFirstClassFrame } = await frameService();
		const result = await updateFirstClassFrame({
			args: withDefaultFrameId(args, session),
			userId: session.userId,
			organizationId: session.organizationId || undefined,
			runtimeTools: args.runtimeTools,
		});
		return "error" in result
			? errorResult(String(result.error || "Unknown frame error"))
			: jsonResult(await withPageUrl(result, session));
	};
}

async function handleEditFrameBlock(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { editFirstClassFrameBlock } = await frameService();
	const result = await editFirstClassFrameBlock({
		args: withDefaultFrameId(args, session),
		userId: session.userId,
		organizationId: session.organizationId || undefined,
	});
	return "error" in result
		? errorResult(String(result.error || "Unknown frame error"))
		: jsonResult(result);
}

async function handleGetFrame(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const { getFirstClassFrame } = await frameService();
	const result = await getFirstClassFrame({
		args: withDefaultFrameId(args, session),
		userId: session.userId,
		userEmail: session.email,
		organizationId: session.organizationId || undefined,
		...(session.pageProjectId !== undefined
			? { projectRestrictionId: session.pageProjectId }
			: {}),
	});
	return "error" in result
		? errorResult(String(result.error || "Unknown frame error"))
		: jsonResult(await withPageUrl(result, session));
}

async function handleListFrames(
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const conversationId = nonEmptyString(args.conversationId);
	if (
		args.conversationId !== undefined &&
		(!conversationId || conversationId.length > 200)
	) {
		return errorResult("Provide a valid conversation ID.");
	}
	const limit = args.limit;
	const offset = args.offset === undefined ? 0 : args.offset;
	if (
		(limit !== undefined &&
			(typeof limit !== "number" ||
				!Number.isInteger(limit) ||
				limit < 1 ||
				limit > 200)) ||
		typeof offset !== "number" ||
		!Number.isInteger(offset) ||
		offset < 0
	) {
		return errorResult(
			"Provide an integer limit from 1 to 200 and a non-negative offset.",
		);
	}
	const surface = FRAME_SURFACES.find((value) => value === args.surface);
	if (args.surface !== undefined && !surface) {
		return errorResult(
			`surface must be one of: ${FRAME_SURFACES.join(", ")}.`,
		);
	}
	const projectId =
		nonEmptyString(args.projectId) ??
		(surface === "artifact"
			? (session.actingContext?.projectId ??
				session.projectId ??
				undefined)
			: undefined);
	const { listFirstClassFrames } = await frameService();
	const { frames } = await listFirstClassFrames({
		userId: session.userId,
		organizationId: session.organizationId || undefined,
		surface,
		projectId,
		conversationId,
		limit,
		offset,
		...(session.pageProjectId !== undefined
			? { projectRestrictionId: session.pageProjectId }
			: {}),
	});
	const slug = await organizationSlug(session.organizationId);
	return jsonResult({
		frames: frames.map((frame) => {
			const url = pageUrl(slug, frame);
			return url ? { ...frame, pageUrl: url } : frame;
		}),
	});
}

type FrameOperation =
	| "startExport"
	| "getExport"
	| "cancelExport"
	| "downloadExport"
	| "sharing"
	| "share"
	| "revoke";
function frameOperation(action: FrameOperation): PlatformToolHandler {
	return async (args, session) => {
		const writes =
			action === "startExport" ||
			action === "cancelExport" ||
			action === "share" ||
			action === "revoke";
		const scope = writes ? "frames:write" : "frames:read";
		if (
			!session.organizationId ||
			session.projectId ||
			session.pinnedProjectId ||
			session.pageProjectId
		) {
			return errorResult("An organization connection is required.", {
				code: "FORBIDDEN",
			});
		}
		if (
			session.credential !== "session" &&
			!session.scopes.includes(scope) &&
			!session.scopes.includes("*")
		) {
			return errorResult(`This operation requires ${scope} scope.`, {
				code: "INSUFFICIENT_SCOPE",
			});
		}
		const frameId = nonEmptyString(args.frameId);
		if (!frameId) {
			return errorResult("Provide a frameId.", { code: "BAD_REQUEST" });
		}
		const actor = {
			userId: session.userId,
			organizationId: session.organizationId,
			userEmail: session.email,
		};
		if (
			[
				"startExport",
				"getExport",
				"cancelExport",
				"downloadExport",
			].includes(action)
		) {
			const service = await import(
				"@repo/api/modules/frames/lib/frame-export-service"
			);
			try {
				if (action === "startExport") {
					const { frameId: _, ...raw } = args;
					const input = frameExportStartSchema.safeParse(raw);
					if (!input.success) {
						return errorResult(
							"Provide the reviewed revision, UUID requestId and valid orientation.",
							{ code: "BAD_REQUEST" },
						);
					}
					return jsonResult(
						await service.startFrameExport(actor, {
							frameId,
							...input.data,
						}),
					);
				}
				const exportId = nonEmptyString(args.exportId);
				if (!exportId) {
					return errorResult(
						"Provide the exportId from the start result.",
						{ code: "BAD_REQUEST" },
					);
				}
				const input = { frameId, exportId };
				return jsonResult(
					await (action === "getExport"
						? service.getFrameExport(actor, input)
						: action === "cancelExport"
							? service.cancelFrameExport(actor, input)
							: service.downloadFrameExport(actor, input)),
				);
			} catch (error) {
				return error instanceof service.FrameExportError
					? errorResult(error.message, { code: error.code })
					: errorResult(
							"The export action could not finish. Inspect its state before retrying.",
							{ code: "UNAVAILABLE" },
						);
			}
		}
		const db = await import("@repo/database");
		try {
			const permitted =
				action === "revoke"
					? await db.canDeleteOrganizationFrames(
							actor.userId,
							actor.organizationId,
						)
					: writes
						? await db.canUpdateOrganizationFrames(
								actor.userId,
								actor.organizationId,
							)
						: await db.canReadOrganizationFrames(
								actor.userId,
								actor.organizationId,
							);
			if (!permitted) {
				return errorResult(
					"No permission to inspect or change sharing.",
					{ code: "FORBIDDEN" },
				);
			}
			const frame = await db.getFrameById({ id: frameId, ...actor });
			if (!frame) {
				return errorResult("Frame not found.", { code: "NOT_FOUND" });
			}
			if (action === "sharing") {
				const grants = await db.listSharingGrants(frameId);
				return jsonResult({
					scope: frame.shareScope,
					hasPublicLink: Boolean(frame.isPublic && frame.shareToken),
					updatedAt: frame.updatedAt.toISOString(),
					grants: grants.map((g) => ({
						id: g.id,
						email: g.email,
						invitedAt: g.invitedAt.toISOString(),
					})),
				});
			}
			const { frameId: _, ...raw } = args;
			if (action === "share") {
				const input = frameShareSchema.safeParse(raw);
				if (!input.success) {
					return errorResult(
						"Provide the reviewed revision, sharing scope and valid recipients.",
						{ code: "BAD_REQUEST" },
					);
				}
				const result = await db.shareFrame({
					frameId,
					...actor,
					...input.data,
					expectedUpdatedAt: new Date(input.data.expectedUpdatedAt),
				});
				return result.ok
					? jsonResult(frameSharingMutationDto(result))
					: errorResult(result.message, { code: result.reason });
			}
			const input = frameRevokeSharingSchema.safeParse(raw);
			if (!input.success) {
				return errorResult(
					"Provide a reviewed revision and valid revoke mode.",
					{ code: "BAD_REQUEST" },
				);
			}
			const result = await db.revokeFrameSharing({
				frameId,
				...actor,
				...input.data,
				expectedUpdatedAt: new Date(input.data.expectedUpdatedAt),
			});
			return result.ok
				? jsonResult(frameSharingMutationDto(result))
				: errorResult(result.message, { code: result.reason });
		} catch (error) {
			return error instanceof db.FrameUpdateConflictError
				? errorResult(error.message, { code: "CONFLICT" })
				: errorResult(
						"The sharing action could not finish. Inspect its state before retrying.",
						{ code: "UNAVAILABLE" },
					);
		}
	};
}

function brandingOperation(
	action: "get" | "apply" | "report",
): PlatformToolHandler {
	return async (args, session) => {
		const scope =
			action === "report"
				? "reports:read"
				: action === "apply"
					? "frames:write"
					: "frames:read";
		if (!session.organizationId) {
			return errorResult("An organization is required.", {
				code: "FORBIDDEN",
			});
		}
		if (
			session.credential !== "session" &&
			!session.scopes.includes(scope) &&
			!session.scopes.includes("*")
		) {
			return errorResult(`This operation requires ${scope} scope.`, {
				code: "INSUFFICIENT_SCOPE",
			});
		}
		const db = await import("@repo/database");
		const actor = {
			userId: session.userId,
			organizationId: session.organizationId,
		};
		const permitted = await (action === "report"
			? db.canReadOrganizationReports
			: action === "apply"
				? db.canUpdateOrganizationFrames
				: db.canReadOrganizationFrames)(
			actor.userId,
			actor.organizationId,
		);
		if (!permitted) {
			return errorResult(
				"Your current role does not permit this operation.",
				{ code: "FORBIDDEN" },
			);
		}
		try {
			const bound =
				session.pinnedProjectId ||
				session.projectId ||
				session.pageProjectId;
			if (action === "report") {
				const projectId = nonEmptyString(args.projectId);
				if (bound && projectId !== bound) {
					return errorResult(
						"This connection is restricted to its project.",
						{ code: "FORBIDDEN" },
					);
				}
				return jsonResult(
					await db.getArtifactBrandingChoices({
						...actor,
						projectId,
					}),
				);
			}
			const id = nonEmptyString(args.frameId);
			if (!id) {
				return errorResult("Provide a frameId.", {
					code: "BAD_REQUEST",
				});
			}
			const current = await db.getFrameBranding({
				...actor,
				id,
				userEmail: session.email,
			});
			if (!current || (bound && current.projectId !== bound)) {
				return errorResult("Frame not found.", { code: "NOT_FOUND" });
			}
			if (action === "get") {
				return jsonResult(current);
			}
			const { frameBrandingApplySchema } = await import(
				"@repo/api/modules/frames/lib/frame-branding-contract"
			);
			const { frameId: _, ...raw } = args;
			const parsed = frameBrandingApplySchema.safeParse(raw);
			if (!parsed.success) {
				return errorResult(
					"Provide the reviewed Frame revision and brand version.",
					{ code: "BAD_REQUEST" },
				);
			}
			const frame = await db.applyFrameBranding({
				...actor,
				id,
				...parsed.data,
				expectedUpdatedAt: new Date(parsed.data.expectedUpdatedAt),
			});
			return frame
				? jsonResult({
						...frame,
						shareToken: null,
						createdAt: frame.createdAt.toISOString(),
						updatedAt: frame.updatedAt.toISOString(),
					})
				: errorResult("Frame not found.", { code: "NOT_FOUND" });
		} catch (error) {
			if (
				error instanceof db.FrameUpdateConflictError ||
				error instanceof db.ArtifactBrandingError
			) {
				return errorResult(error.message, {
					code:
						error instanceof db.ArtifactBrandingError &&
						error.code === "NOT_FOUND"
							? "NOT_FOUND"
							: "CONFLICT",
				});
			}
			throw error;
		}
	};
}

function reportInstanceBrandingOperation(write: boolean): PlatformToolHandler {
	return async (args, session) => {
		const scope = write ? "reports:write" : "reports:read";
		if (!session.organizationId) {
			return errorResult("An organization is required.", {
				code: "FORBIDDEN",
			});
		}
		if (
			session.credential !== "session" &&
			!session.scopes.includes(scope) &&
			!session.scopes.includes("*")
		) {
			return errorResult(`This operation requires ${scope} scope.`, {
				code: "INSUFFICIENT_SCOPE",
			});
		}
		const id = nonEmptyString(args.instanceId);
		if (!id) {
			return errorResult("Provide an instanceId.", {
				code: "BAD_REQUEST",
			});
		}
		const db = await import("@repo/database");
		const actor = {
			organizationId: session.organizationId,
			userId: session.userId,
			boundProjectId:
				session.pinnedProjectId ||
				session.projectId ||
				session.pageProjectId,
		};
		try {
			if (!write) {
				return jsonResult(
					await db.getReportInstanceBranding(actor, id),
				);
			}
			const { instanceId: _, ...raw } = args;
			const parsed = db.reportInstanceBrandingUpdateSchema.safeParse(raw);
			if (!parsed.success) {
				return errorResult(
					"Provide the reviewed report revision and saved brand selection.",
					{ code: "BAD_REQUEST" },
				);
			}
			return jsonResult(
				await db.applyReportInstanceBranding(actor, id, parsed.data),
			);
		} catch (error) {
			return error instanceof db.ReportBrandingCommandError
				? errorResult(error.message, { code: error.code })
				: errorResult(
						"The report branding could not be saved. Inspect current settings before retrying.",
						{ code: "UNAVAILABLE" },
					);
		}
	};
}

function reviewedFrameOperation(operation: string): PlatformToolHandler {
	return async (args, session) => {
		const write = ![
			"validate_frame_document",
			"list_frame_templates",
			"get_frame_template",
			"list_frame_changes",
			"get_frame_change",
			"get_frame_review",
		].includes(operation);
		const scope = write ? "frames:write" : "frames:read";
		if (
			!session.organizationId ||
			session.projectId ||
			(session.pinnedProjectId &&
				(session.credential !== "service" ||
					!FRAME_REVIEW_TOOL_NAMES.has(`fabric_${operation}`))) ||
			session.pageProjectId
		) {
			return errorResult(
				"Use an organization connection for page authoring and review.",
				{ code: "FORBIDDEN" },
			);
		}
		if (
			session.credential !== "session" &&
			!session.scopes.includes(scope) &&
			!session.scopes.includes("*")
		) {
			return errorResult(`This operation requires ${scope} scope.`, {
				code: "INSUFFICIENT_SCOPE",
			});
		}
		const database = await import("@repo/database");
		const actor = {
			userId: session.userId,
			organizationId: session.organizationId,
			boundProjectId: session.pinnedProjectId ?? undefined,
			auditActorType:
				session.credential === "service"
					? ("agent" as const)
					: session.credential === "session"
						? ("user" as const)
						: ("api_key" as const),
			transport: "mcp" as const,
		};
		try {
			let result: unknown;
			const { frameId, ...input } = args;
			const operations = {
				propose_frame_change: database.proposeFrameChange,
				list_frame_changes: database.listFrameChanges,
				get_frame_change: database.getFrameChange,
				apply_frame_change: database.applyFrameChange,
				dismiss_frame_change: database.dismissFrameChange,
				get_frame_review: database.getFrameReviewState,
				approve_frame_revision: database.approveFrameRevision,
			};
			if (operation in operations) {
				if (typeof frameId !== "string" || !frameId) {
					return errorResult("Provide a frameId.", {
						code: "BAD_REQUEST",
					});
				}
				result = await operations[operation as keyof typeof operations](
					actor,
					frameId,
					input,
				);
			} else {
				const authoring = await import(
					"@repo/api/modules/frames/lib/frame-authoring-commands"
				);
				switch (operation) {
					case "create_frame_draft":
						result = await authoring.createAuthoredFrame(actor, {
							...args,
							projectId: placementProjectId(args, session),
							conversationId:
								session.actingContext?.conversationId ??
								args.conversationId,
						});
						break;
					case "validate_frame_document":
						result = await authoring.validateAuthoredFrame(
							actor,
							args.document,
						);
						break;
					case "list_frame_templates":
						result = await authoring.listAuthoredFrameTemplates(
							actor,
							args,
						);
						break;
					case "get_frame_template":
						result = await authoring.getAuthoredFrameTemplate(
							actor,
							String(args.templateId ?? ""),
						);
						break;
					case "create_frame_template":
						result = await authoring.createAuthoredFrameTemplate(
							actor,
							args,
						);
						break;
					case "create_frame_from_template":
						result =
							await authoring.createAuthoredFrameFromTemplate(
								actor,
								{
									...args,
									projectId: placementProjectId(
										args,
										session,
									),
									conversationId:
										session.actingContext?.conversationId ??
										args.conversationId,
								},
							);
						break;
					default:
						return errorResult("Unsupported page operation.", {
							code: "BAD_REQUEST",
						});
				}
			}
			if (
				operation === "propose_frame_change" &&
				result &&
				typeof result === "object" &&
				"id" in result
			) {
				const {
					base: _base,
					proposed: document,
					...summary
				} = result as import("@repo/utils/frame-review-contracts").FrameChangeProposalView;
				const slug = await organizationSlug(session.organizationId);
				result = { ...summary, title: document.title };
				if (slug) {
					result = {
						...summary,
						title: document.title,
						reviewUrl: `/app/${encodeURIComponent(slug)}/frames/${encodeURIComponent(String(frameId))}?review=${encodeURIComponent(String(summary.id))}`,
					};
				}
			}

			if (
				["create_frame_draft", "create_frame_from_template"].includes(
					operation,
				) &&
				result &&
				typeof result === "object" &&
				"id" in result
			) {
				const created = result as {
					id: string;
					title: string;
					kind: string;
					updatedAt: Date | string;
				};
				result = await withPageUrl(
					{
						frameId: created.id,
						title: created.title,
						kind: created.kind,
						updatedAt: created.updatedAt,
						isPublic: false,
					},
					session,
				);
			}
			return jsonResult(result);
		} catch (error) {
			if (error instanceof database.FrameReviewError) {
				return errorResult(error.message, { code: error.code });
			}
			if (
				error &&
				typeof error === "object" &&
				"name" in error &&
				error.name === "ZodError"
			) {
				return errorResult(
					"Provide valid content and reviewed identifiers.",
					{ code: "BAD_REQUEST" },
				);
			}
			return errorResult(
				"The page operation could not be completed. Inspect the saved state before retrying.",
				{ code: "UNAVAILABLE" },
			);
		}
	};
}

/**
 * The frame tools, registered like every other family. `pageMayDeclare` is the
 * table owner's answer to "may a page declare this tool": it knows the whole
 * platform table, which this module is part of and cannot import back.
 */
export function createFrameTools(
	pageMayDeclare: PageToolValidator,
): ToolFamily {
	return toolFamily(
		FABRIC_FRAME_TOOL_DEFINITIONS,
		new Map<string, PlatformToolHandler>([
			[
				"fabric_create_frame_draft",
				reviewedFrameOperation("create_frame_draft"),
			],
			[
				"fabric_validate_frame_document",
				reviewedFrameOperation("validate_frame_document"),
			],
			[
				"fabric_list_frame_templates",
				reviewedFrameOperation("list_frame_templates"),
			],
			[
				"fabric_get_frame_template",
				reviewedFrameOperation("get_frame_template"),
			],
			[
				"fabric_create_frame_template",
				reviewedFrameOperation("create_frame_template"),
			],
			[
				"fabric_create_frame_from_template",
				reviewedFrameOperation("create_frame_from_template"),
			],
			[
				"fabric_propose_frame_change",
				reviewedFrameOperation("propose_frame_change"),
			],
			[
				"fabric_list_frame_changes",
				reviewedFrameOperation("list_frame_changes"),
			],
			[
				"fabric_get_frame_change",
				reviewedFrameOperation("get_frame_change"),
			],
			[
				"fabric_apply_frame_change",
				reviewedFrameOperation("apply_frame_change"),
			],
			[
				"fabric_dismiss_frame_change",
				reviewedFrameOperation("dismiss_frame_change"),
			],
			[
				"fabric_get_frame_review",
				reviewedFrameOperation("get_frame_review"),
			],
			[
				"fabric_approve_frame_revision",
				reviewedFrameOperation("approve_frame_revision"),
			],

			["fabric_create_frame", handleCreateFrame(pageMayDeclare)],
			["fabric_get_frame_branding", brandingOperation("get")],
			["fabric_apply_frame_branding", brandingOperation("apply")],
			["fabric_get_report_branding", brandingOperation("report")],
			[
				"fabric_get_report_instance_branding",
				reportInstanceBrandingOperation(false),
			],
			[
				"fabric_apply_report_branding",
				reportInstanceBrandingOperation(true),
			],
			["fabric_update_frame", handleUpdateFrame(pageMayDeclare)],
			["fabric_edit_frame_block", handleEditFrameBlock],
			["fabric_get_frame", handleGetFrame],
			["fabric_list_frames", handleListFrames],
			["fabric_share_frame", frameOperation("share")],
			["fabric_get_frame_sharing", frameOperation("sharing")],
			["fabric_revoke_frame_sharing", frameOperation("revoke")],
			["fabric_start_frame_export", frameOperation("startExport")],
			["fabric_get_frame_export", frameOperation("getExport")],
			["fabric_cancel_frame_export", frameOperation("cancelExport")],
			["fabric_download_frame_export", frameOperation("downloadExport")],
			["fabric_create_slideshow", handleCreateSlideshow],
		]),
	);
}
