import {
	canCreateOrganizationFrames,
	canUpdateOrganizationFrames,
	createFrame,
	duplicateFrame,
	FramePlacementRefusedError,
	type FrameRecord,
	type FrameSurface,
	getAccessibleFrameById,
	getFrameById,
	listFrames,
	listProjectFrames,
	listWorkspaceFrames,
	type ProjectPlacementRefusal,
	projectPlacementRefusal,
	publicSharingRefusal,
	revertFrameToVersion,
	shareFrame,
	updateFrame,
} from "@repo/database";
import { throwIfDispatchStopped } from "@repo/utils/dispatch-guard";
import {
	FRAME_SHARE_SCOPES,
	type FrameShareScopeName,
} from "../../lib/fabric-frame-tool-definitions";
import { agentToolProjectScope } from "./agent-tool-runtime";
import {
	getNonEmptyString,
	parseFrameSourceWindow,
	parseRuntimeTools,
	validateCreateFrameArgs,
	validateUpdateFrameArgs,
	withTrustedRuntimeTools,
} from "./frame-args";
import { generateFrameBlocks } from "./frame-generation";
import { readFrameSource } from "./frame-source-read";

const NO_ORGANIZATION_CONTEXT =
	"No organization context for this frame operation.";

/**
 * Refuse a frame write the caller's organization role does not allow, or return
 * `null` to let it through.
 *
 * Frames are organization resources, and the oRPC procedures behind the UI gate
 * them on WORKSPACE_CREATE and WORKSPACE_UPDATE — permissions a viewer does not
 * hold. Nothing enforced that here, so every non-oRPC path into this service —
 * the MCP gateway, the agent executor, direct-chat built-in tools, the
 * orchestrator's MCP tool execution, and the Fabric AI handler — could create,
 * edit and publish frames that the same person could not touch through the
 * interface.
 *
 * The check lives in the service rather than in each of those five callers
 * precisely because there are five of them: gating the entry points one at a
 * time is how a surface ends up covered everywhere except the path someone
 * added last.
 *
 * A missing organization fails closed. Every session runs inside exactly one
 * organization since the personal-context removal, so an absent one is a
 * resolution bug upstream, and the safe reading of a bug is not "write anyway".
 */
async function frameWriteRefusal(
	userId: string,
	organizationId: string | undefined,
	action: "create" | "update",
): Promise<string | null> {
	if (!organizationId) {
		return NO_ORGANIZATION_CONTEXT;
	}

	const allowed =
		action === "create"
			? await canCreateOrganizationFrames(userId, organizationId)
			: await canUpdateOrganizationFrames(userId, organizationId);

	return allowed
		? null
		: `No permission to ${action} frames in this organization.`;
}

const PLACEMENT_REFUSALS: Record<ProjectPlacementRefusal, string> = {
	not_found: "Project not found.",
	not_editable: "No permission to add frames to this project.",
};

/**
 * Refuse placing a frame in a project the caller named, or return `null`.
 *
 * Naming a project is the one placement a caller controls, so it is held to the
 * project's own rules, which `@repo/database` keeps in one place: the project
 * must belong to the caller's organization and not be in the trash, and the
 * caller must be allowed to edit it. A project the caller cannot open at all is
 * reported as missing, as everywhere else.
 */
async function placementRefusal(
	userId: string,
	organizationId: string | undefined,
	projectId: string,
): Promise<string | null> {
	if (!organizationId) {
		return NO_ORGANIZATION_CONTEXT;
	}
	const refusal = await projectPlacementRefusal({
		userId,
		organizationId,
		projectId,
	});
	return refusal ? PLACEMENT_REFUSALS[refusal] : null;
}

function describeFrameSurface(frame: FrameRecord, userId: string) {
	return {
		surface: frame.surface,
		projectId: frame.projectId,
		runtimeTools: frame.runtimeTools,
		shareScope: frame.shareScope,
		ownedByCaller: frame.userId === userId,
		sourceRunType: frame.sourceRunType ?? undefined,
	};
}

export async function createFirstClassFrame(input: {
	args: Record<string, unknown> | undefined;
	userId: string;
	organizationId?: string;
	/**
	 * The project to place the frame in. Unlike the ambient project scope of a
	 * chat turn this was named by the caller, so it is checked here.
	 */
	projectId?: string;
	/** See {@link withTrustedRuntimeTools}. */
	runtimeTools?: unknown;
	/** Who may open it. A Workspace defaults to everyone in the organization. */
	shareScope?: "PRIVATE" | "WORKSPACE_AND_EMAILS";
	conversationId?: string;
	/**
	 * The chat whose usage-log rows the frame's generation calls are recorded
	 * against. Separate from `conversationId`, which a caller may fill with a
	 * run ID to bind the frame: attribution takes a real conversation only.
	 */
	usageConversationId?: string;
	sourceRunType?: string;
	sourceRunId?: string;
	authoritySessionId?: string;
	providerKeys?: string[];
}) {
	const validated = validateCreateFrameArgs(
		withTrustedRuntimeTools(input.args, input.runtimeTools),
	);
	if (!validated.ok) {
		return { error: validated.error };
	}

	const refusal = await frameWriteRefusal(
		input.userId,
		input.organizationId,
		"create",
	);
	if (refusal) {
		return { error: refusal };
	}

	// A frame is private when it is made. A public link from the start is only
	// for a caller that asked for one, and only where the organization allows
	// public links: the rule `fabric_share_frame` follows.
	if (validated.value.shareOnCreate) {
		const publicRefusal = await publicSharingRefusal(input.organizationId);
		if (publicRefusal) {
			return { error: publicRefusal };
		}
	}

	if (input.projectId) {
		const placementError = await placementRefusal(
			input.userId,
			input.organizationId,
			input.projectId,
		);
		if (placementError) {
			return { error: placementError };
		}
	}
	const projectId = input.projectId ?? agentToolProjectScope()?.projectId;
	const { surface, runtimeTools } = validated.value;
	if (surface === "artifact" && !projectId) {
		return {
			error: "An artifact belongs to a project. Pass `projectId` for the project it is for.",
		};
	}
	if (surface && !validated.value.blocks?.length) {
		return {
			error: "A page needs its content. Pass the page HTML as `blocks`.",
		};
	}

	// A caller that produced rendered content has it persisted as it is; only a
	// description with no pages is written out by the model.
	const blocks = validated.value.blocks?.length
		? validated.value.blocks
		: await generateFrameBlocks({
				userId: input.userId,
				organizationId: input.organizationId,
				...(input.usageConversationId
					? { conversationId: input.usageConversationId }
					: {}),
				spec: validated.value,
			});

	// Immediately before the write: nothing is created once the chat turn
	// this runs in has stopped or used its token allowance.
	throwIfDispatchStopped();
	const frame = await createFrame({
		userId: input.userId,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		projectId,
		title: validated.value.title,
		description: validated.value.description,
		kind: validated.value.kind,
		blocks,
		sourceRunType: input.sourceRunType,
		sourceRunId: input.sourceRunId,
		authoritySessionId: input.authoritySessionId,
		providerKeys: input.providerKeys,
		surface,
		runtimeTools,
		shareScope:
			input.shareScope ??
			(surface === "workspace"
				? "WORKSPACE_AND_EMAILS"
				: validated.value.shareOnCreate && !projectId && !surface
					? "PUBLIC"
					: undefined),
		isPublic: validated.value.shareOnCreate,
	});
	const shareToken = liveShareToken(frame);
	return {
		frameId: frame.id,
		title: frame.title,
		description: frame.description ?? undefined,
		kind: frame.kind,
		contentType: frame.contentType,
		content: frame.document.blocks[0]?.content || "",
		frameUrl: buildInternalFrameUrl(frame.id),
		embedUrl: buildInternalFrameEmbedUrl(frame.id),
		shareUrl: shareToken ? buildShareUrl(shareToken) : undefined,
		shareEmbedUrl: shareToken ? buildShareEmbedUrl(shareToken) : undefined,
		...describeFrameSurface(frame, input.userId),
		response: `Frame "${frame.title}" created successfully.`,
	};
}

export async function updateFirstClassFrame(input: {
	args: Record<string, unknown> | undefined;
	userId: string;
	organizationId?: string;
	/** See {@link withTrustedRuntimeTools}. */
	runtimeTools?: unknown;
}) {
	const validated = validateUpdateFrameArgs(
		withTrustedRuntimeTools(input.args, input.runtimeTools),
	);
	if (!validated.ok) {
		return { error: validated.error };
	}

	const refusal = await frameWriteRefusal(
		input.userId,
		input.organizationId,
		"update",
	);
	if (refusal) {
		return { error: refusal };
	}

	if (validated.value.surface === "artifact") {
		const existing = await getFrameById({
			id: validated.value.frameId,
			userId: input.userId,
			organizationId: input.organizationId,
		});
		if (!existing) {
			return { error: "Frame not found." };
		}
		if (!existing.projectId) {
			return {
				error: "An artifact belongs to a project, and this frame has none.",
			};
		}
	}

	throwIfDispatchStopped();
	const frame = await updateFrame({
		id: validated.value.frameId,
		userId: input.userId,
		organizationId: input.organizationId,
		projectId: agentToolProjectScope()?.projectId,
		title: validated.value.title,
		description: validated.value.description,
		blocks: validated.value.blocks,
		surface: validated.value.surface,
		runtimeTools: validated.value.runtimeTools,
	});
	if (!frame) {
		return { error: "Frame not found." };
	}
	const shareToken = liveShareToken(frame);
	return {
		frameId: frame.id,
		title: frame.title,
		description: frame.description ?? undefined,
		kind: frame.kind,
		contentType: frame.contentType,
		frameUrl: buildInternalFrameUrl(frame.id),
		embedUrl: buildInternalFrameEmbedUrl(frame.id),
		shareUrl: shareToken ? buildShareUrl(shareToken) : undefined,
		shareEmbedUrl: shareToken ? buildShareEmbedUrl(shareToken) : undefined,
		...describeFrameSurface(frame, input.userId),
		response: `Frame "${frame.title}" updated successfully.`,
	};
}

/** The token of a link that opens the frame now: only a public frame has one. */
function liveShareToken(frame: FrameRecord) {
	return frame.isPublic ? frame.shareToken : null;
}

/** The share link is the owner's to hand out; a reader sees it once it is public. */
function visibleShareToken(frame: FrameRecord, userId: string) {
	return frame.userId === userId || frame.isPublic ? frame.shareToken : null;
}

export async function getFirstClassFrame(input: {
	args: Record<string, unknown> | undefined;
	userId: string;
	userEmail?: string;
	organizationId?: string;
	projectRestrictionId?: string;
}) {
	const frameId = getNonEmptyString(input.args, ["frameId", "id"]);
	if (!frameId) {
		return { error: "Frame ID is required. Provide `frameId`." };
	}
	const sourceWindow = parseFrameSourceWindow(input.args);
	if (!sourceWindow.ok) {
		return { error: sourceWindow.error };
	}
	const frame = input.organizationId
		? await getAccessibleFrameById({
				id: frameId,
				userId: input.userId,
				userEmail: input.userEmail,
				organizationId: input.organizationId,
			})
		: await getFrameById({
				id: frameId,
				userId: input.userId,
			});
	if (
		!frame ||
		(input.projectRestrictionId !== undefined &&
			frame.projectId !== input.projectRestrictionId)
	) {
		return { error: "Frame not found." };
	}
	if (sourceWindow.value) {
		return readFrameSource(frame, sourceWindow.value);
	}
	const shareToken = visibleShareToken(frame, input.userId);
	return {
		frameId: frame.id,
		title: frame.title,
		description: frame.description,
		kind: frame.kind,
		contentType: frame.contentType,
		blocks: frame.document.blocks,
		frameUrl: buildInternalFrameUrl(frame.id),
		embedUrl: buildInternalFrameEmbedUrl(frame.id),
		shareUrl: shareToken ? buildShareUrl(shareToken) : undefined,
		shareEmbedUrl: shareToken ? buildShareEmbedUrl(shareToken) : undefined,
		version: frame.version,
		updatedAt: frame.updatedAt.toISOString(),
		...describeFrameSurface(frame, input.userId),
	};
}

async function readFramesForList(input: {
	userId: string;
	organizationId?: string;
	conversationId?: string;
	surface?: FrameSurface;
	projectId?: string;
}): Promise<FrameRecord[]> {
	const { organizationId } = input;
	if (input.surface || input.projectId) {
		if (!organizationId) {
			return [];
		}
		return input.surface === "workspace"
			? listWorkspaceFrames({
					userId: input.userId,
					organizationId,
					projectId: input.projectId,
				})
			: listProjectFrames({
					userId: input.userId,
					organizationId,
					projectId: input.projectId,
					surface: input.surface,
				});
	}
	return listFrames({
		userId: input.userId,
		organizationId,
		conversationId: input.conversationId,
		limit: 25,
	});
}

/**
 * The caller's frames, or - with `surface` or `projectId` - what they may see
 * on that surface: an organization's Workspaces, or the frames of the projects
 * they can open. Without either it stays the caller's own frames.
 */
export async function listFirstClassFrames(input: {
	userId: string;
	organizationId?: string;
	conversationId?: string;
	surface?: FrameSurface;
	projectId?: string;
	projectRestrictionId?: string;
}) {
	if (
		input.projectRestrictionId !== undefined &&
		input.projectId !== undefined &&
		input.projectId !== input.projectRestrictionId
	) {
		return { frames: [] };
	}
	const frames = await readFramesForList({
		...input,
		projectId: input.projectRestrictionId ?? input.projectId,
	});
	return {
		frames: frames.map((frame) => {
			const shareToken = visibleShareToken(frame, input.userId);
			return {
				frameId: frame.id,
				title: frame.title,
				description: frame.description ?? undefined,
				kind: frame.kind,
				contentType: frame.contentType,
				frameUrl: buildInternalFrameUrl(frame.id),
				embedUrl: buildInternalFrameEmbedUrl(frame.id),
				shareUrl: shareToken ? buildShareUrl(shareToken) : undefined,
				shareEmbedUrl: shareToken
					? buildShareEmbedUrl(shareToken)
					: undefined,
				updatedAt: frame.updatedAt.toISOString(),
				...describeFrameSurface(frame, input.userId),
			};
		}),
	};
}

const MAX_SHARE_EMAILS = 50;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseShareScope(
	args: Record<string, unknown> | undefined,
): { ok: true; value: FrameShareScopeName } | { ok: false; error: string } {
	const raw = args?.scope;
	if (raw === undefined || raw === null) {
		return {
			ok: false,
			error: `\`scope\` is required, and must be one of: ${FRAME_SHARE_SCOPES.join(", ")}. A frame is never made public unless you name PUBLIC.`,
		};
	}
	const scope = FRAME_SHARE_SCOPES.find((value) => value === raw);
	return scope
		? { ok: true, value: scope }
		: {
				ok: false,
				error: `\`scope\` must be one of: ${FRAME_SHARE_SCOPES.join(", ")}.`,
			};
}

function parseShareEmails(
	args: Record<string, unknown> | undefined,
): { ok: true; value: string[] } | { ok: false; error: string } {
	const raw = args?.emails;
	if (raw === undefined || raw === null) {
		return { ok: true, value: [] };
	}
	if (!Array.isArray(raw) || raw.length > MAX_SHARE_EMAILS) {
		return {
			ok: false,
			error: `\`emails\` must be a list of at most ${MAX_SHARE_EMAILS} email addresses.`,
		};
	}
	const emails = new Set<string>();
	for (const entry of raw) {
		const email =
			typeof entry === "string" ? entry.trim().toLowerCase() : "";
		if (!EMAIL_PATTERN.test(email)) {
			return {
				ok: false,
				error: "Every entry of `emails` must be an email address.",
			};
		}
		emails.add(email);
	}
	return { ok: true, value: [...emails] };
}

/**
 * Changes who can open a frame its owner made: public (a link anyone can open),
 * the organization and invited emails, invited emails only, or no one else.
 * Inviting emails is the owner's, under the same scopes the app offers, and
 * going public follows the organization's own policy for public links.
 */
export async function shareFirstClassFrame(input: {
	args: Record<string, unknown> | undefined;
	userId: string;
	organizationId?: string;
}) {
	const frameId = getNonEmptyString(input.args, ["frameId", "id"]);
	if (!frameId) {
		return { error: "Frame ID is required. Provide `frameId`." };
	}
	const scope = parseShareScope(input.args);
	if (!scope.ok) {
		return { error: scope.error };
	}
	const emails = parseShareEmails(input.args);
	if (!emails.ok) {
		return { error: emails.error };
	}

	// Sharing publishes a frame outward, so it is gated as an update rather
	// than as a read: WORKSPACE_UPDATE is what the oRPC publish path requires,
	// and making something visible is a change to it.
	const refusal = await frameWriteRefusal(
		input.userId,
		input.organizationId,
		"update",
	);
	if (refusal) {
		return { error: refusal };
	}

	const projectScope = agentToolProjectScope()?.projectId;
	const existing = await getFrameById({
		id: frameId,
		userId: input.userId,
		organizationId: input.organizationId,
	});
	if (!existing || (projectScope && existing.projectId !== projectScope)) {
		return { error: "Frame not found." };
	}

	throwIfDispatchStopped();
	const shared = await shareFrame({
		frameId,
		userId: input.userId,
		organizationId: input.organizationId,
		scope: scope.value,
		emails: emails.value,
	});
	if (!shared.ok) {
		return { error: shared.message };
	}

	return {
		frameId: existing.id,
		title: existing.title,
		description: existing.description ?? undefined,
		kind: existing.kind,
		contentType: existing.contentType,
		scope: shared.scope,
		invited: shared.invited,
		shareUrl: shared.shareToken
			? buildShareUrl(shared.shareToken)
			: undefined,
		shareEmbedUrl: shared.shareToken
			? buildShareEmbedUrl(shared.shareToken)
			: undefined,
		frameUrl: buildInternalFrameUrl(existing.id),
		embedUrl: buildInternalFrameEmbedUrl(existing.id),
		response: `Frame "${existing.title}" is now ${SCOPE_PHRASES[scope.value]}.`,
	};
}

const SCOPE_PHRASES: Record<FrameShareScopeName, string> = {
	PUBLIC: "shareable with anyone who has the link",
	WORKSPACE_AND_EMAILS: "open to the organization and the people invited",
	EMAILS_ONLY: "open to the people invited",
	PRIVATE: "private",
};

/**
 * Puts a frame back to one of its saved versions. Only its owner may; anyone
 * else forks the page and changes their copy. The content comes back; the
 * tools the page may call stay as they are now, so an old version never widens
 * what the page can do.
 */
export async function restoreFirstClassFrameVersion(input: {
	args: Record<string, unknown> | undefined;
	userId: string;
	userEmail?: string;
	organizationId?: string;
}) {
	const frameId = getNonEmptyString(input.args, ["frameId", "id"]);
	if (!frameId) {
		return { error: "Frame ID is required. Provide `frameId`." };
	}
	const version = input.args?.version;
	if (
		typeof version !== "number" ||
		!Number.isInteger(version) ||
		version < 1
	) {
		return {
			error: "`version` must be a whole number from 1. fabric_list_frame_versions lists them.",
		};
	}
	const refusal = await frameWriteRefusal(
		input.userId,
		input.organizationId,
		"update",
	);
	if (refusal || !input.organizationId) {
		return { error: refusal ?? NO_ORGANIZATION_CONTEXT };
	}

	const frame = await getAccessibleFrameById({
		id: frameId,
		userId: input.userId,
		userEmail: input.userEmail,
		organizationId: input.organizationId,
	});
	if (!frame) {
		return { error: "Frame not found." };
	}
	if (frame.userId !== input.userId) {
		return {
			error: "Only the page's owner can restore a version. Fork it with fabric_duplicate_frame to change your own copy.",
		};
	}

	throwIfDispatchStopped();
	const reverted = await revertFrameToVersion({
		frameId,
		userId: input.userId,
		organizationId: input.organizationId,
		toVersion: version,
	});
	if (!reverted.success) {
		return {
			error: reverted.error ?? "That version could not be restored.",
		};
	}

	const restored = await getAccessibleFrameById({
		id: frameId,
		userId: input.userId,
		userEmail: input.userEmail,
		organizationId: input.organizationId,
	});
	return {
		frameId,
		restoredVersion: version,
		title: restored?.title ?? frame.title,
		surface: frame.surface,
		projectId: frame.projectId,
		runtimeTools: restored?.runtimeTools ?? frame.runtimeTools,
		response: `Frame "${frame.title}" is back at version ${version}.`,
	};
}

/**
 * Forks a frame the caller can open into a copy of their own, in the same
 * place: its surface and project are kept. The copy is `duplicateFrame`, the
 * command the app's duplicate uses too, so it is private to its owner, carries
 * no page data, and has the page's tools only when the caller passes
 * `runtimeTools` (the gateway checks the names and asks first): a fork never
 * carries a power its owner did not choose. What this adds is who may fork: any
 * caller who can open the page and may create frames, into a project they may
 * add to.
 */
export async function duplicateFirstClassFrame(input: {
	args: Record<string, unknown> | undefined;
	userId: string;
	userEmail?: string;
	organizationId?: string;
	/** See {@link withTrustedRuntimeTools}. */
	runtimeTools?: unknown;
	conversationId?: string;
	sourceRunType?: string;
	sourceRunId?: string;
}) {
	const frameId = getNonEmptyString(input.args, ["frameId", "id"]);
	if (!frameId) {
		return { error: "Frame ID is required. Provide `frameId`." };
	}
	const runtimeTools = parseRuntimeTools({
		runtimeTools: input.runtimeTools,
	});
	if (!runtimeTools.ok) {
		return { error: runtimeTools.error };
	}
	const refusal = await frameWriteRefusal(
		input.userId,
		input.organizationId,
		"create",
	);
	if (refusal || !input.organizationId) {
		return { error: refusal ?? NO_ORGANIZATION_CONTEXT };
	}

	const source = await getAccessibleFrameById({
		id: frameId,
		userId: input.userId,
		userEmail: input.userEmail,
		organizationId: input.organizationId,
	});
	if (!source) {
		return { error: "Frame not found." };
	}

	throwIfDispatchStopped();
	try {
		const copy = await duplicateFrame({
			original: source,
			userId: input.userId,
			organizationId: input.organizationId,
			title: getNonEmptyString(input.args, ["title"]),
			runtimeTools: runtimeTools.value,
			conversationId: input.conversationId,
			sourceRunType: input.sourceRunType,
			sourceRunId: input.sourceRunId,
		});
		return {
			frameId: copy.id,
			duplicatedFrom: source.id,
			title: copy.title,
			kind: copy.kind,
			contentType: copy.contentType,
			frameUrl: buildInternalFrameUrl(copy.id),
			embedUrl: buildInternalFrameEmbedUrl(copy.id),
			...describeFrameSurface(copy, input.userId),
			response: `Frame "${source.title}" is now your own copy, "${copy.title}".`,
		};
	} catch (error) {
		if (error instanceof FramePlacementRefusedError) {
			return { error: PLACEMENT_REFUSALS[error.refusal] };
		}
		throw error;
	}
}

function publicBaseUrl() {
	return (
		process.env.NEXT_PUBLIC_SITE_URL ||
		process.env.APP_URL ||
		"http://localhost:3001"
	);
}

function buildShareUrl(token: string) {
	return `${publicBaseUrl()}/share/frame/${token}`;
}

function buildShareEmbedUrl(token: string) {
	return `${buildShareUrl(token)}/embed`;
}

/**
 * Where a frame is shown in the app. `/app/frames/<id>` is the app's own route
 * for a frame, and it carries the viewer on to the organization the frame is in;
 * this service knows the organization's id, which is not what a path is built
 * from.
 */
function buildInternalFrameUrl(frameId: string) {
	return `/app/frames/${frameId}`;
}

function buildInternalFrameEmbedUrl(frameId: string) {
	return `${buildInternalFrameUrl(frameId)}/embed`;
}
