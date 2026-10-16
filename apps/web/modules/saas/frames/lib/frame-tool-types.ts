import { FRAME_SURFACES } from "@repo/utils/frame-surfaces";
import { z } from "zod";
import type { FrameDocumentView } from "../components/FrameRenderer";

/**
 * What `fabric_list_frames` and `fabric_get_frame` return for a frame, as the
 * pages that read them through the tool client use it. The tools are the one
 * source of truth (see `gateway/tools/frame-tools.ts`); these are the fields
 * the surfaces read, and the schemas are what the client checks every answer
 * against before a page draws it.
 */

const FrameSurfaceSchema = z.enum(FRAME_SURFACES);

export type FrameSurfaceName = z.infer<typeof FrameSurfaceSchema>;

const FrameShareScopeSchema = z.enum([
	"PRIVATE",
	"EMAILS_ONLY",
	"WORKSPACE_AND_EMAILS",
	"PUBLIC",
	"PROJECT",
]);

export type FrameShareScopeName = z.infer<typeof FrameShareScopeSchema>;

const FrameSummarySchema = z.object({
	frameId: z.string(),
	title: z.string(),
	description: z.string().optional(),
	kind: z.enum(["frame", "slideshow"]),
	surface: FrameSurfaceSchema.optional(),
	projectId: z.string().optional(),
	shareScope: FrameShareScopeSchema.optional(),
	ownedByCaller: z.boolean().optional(),
	/** What produced the page; a page a workflow wrote is shown without scripts. */
	sourceRunType: z.string().optional(),
	updatedAt: z.string(),
});

export type FrameSummary = z.infer<typeof FrameSummarySchema>;

export const FrameListSchema = z.object({
	frames: z.array(FrameSummarySchema),
});

const FrameBlockSchema = z.object({
	id: z.string(),
	type: z.enum(["html", "json", "mermaid", "markdown"]),
	title: z.string().optional(),
	content: z.string(),
	language: z.string().optional(),
});

export const FrameDetailSchema = FrameSummarySchema.omit({
	updatedAt: true,
}).extend({
	blocks: z.array(FrameBlockSchema),
	runtimeTools: z.array(z.string()),
	shareUrl: z.string().optional(),
	updatedAt: z.string().optional(),
});

export type FrameDetail = z.infer<typeof FrameDetailSchema>;

/** What `fabric_duplicate_frame` answers: the copy's id, which is where to go next. */
export const DuplicatedFrameSchema = z.object({ frameId: z.string() });

/** Who can open a page, in a word, for a badge on its card. */
export function shareScopeLabel(scope: FrameShareScopeName): string {
	switch (scope) {
		case "PRIVATE":
			return "Private";
		case "EMAILS_ONLY":
			return "Invited";
		case "WORKSPACE_AND_EMAILS":
			return "Organization";
		case "PUBLIC":
			return "Public";
		case "PROJECT":
			return "Project";
		default: {
			const unreachable: never = scope;
			return unreachable;
		}
	}
}

/** Who can open a page, as a sentence for the page itself. */
export function shareScopeSentence(
	scope: FrameShareScopeName,
	ownedByCaller: boolean,
): string {
	switch (scope) {
		case "PRIVATE":
			return ownedByCaller
				? "Private: only you can open it. Share it to open it to your organization."
				: "Opened with you through its project.";
		case "EMAILS_ONLY":
			return "Shared with the people invited by email.";
		case "WORKSPACE_AND_EMAILS":
			return "Shared with everyone in your organization.";
		case "PUBLIC":
			return "Anyone with the link can open it.";
		case "PROJECT":
			return "Open to the members of its project.";
		default: {
			const unreachable: never = scope;
			return unreachable;
		}
	}
}

/**
 * Where Fabric Agent is opened from when a frame is on screen: its surface, its
 * project, and - for a Workspace, which is its own frame - its id.
 */
export function agentContextOfFrame(frame: {
	frameId: string;
	surface?: FrameSurfaceName | null;
	projectId?: string | null;
}) {
	return {
		surface: frame.surface ?? null,
		workspaceId: frame.surface === "workspace" ? frame.frameId : null,
		projectId: frame.projectId ?? null,
	};
}

/** The document a frame shell shows in its code view, rebuilt from a read. */
export function frameDocumentOf(frame: FrameDetail): FrameDocumentView {
	return {
		version: 1,
		kind: frame.kind,
		title: frame.title,
		...(frame.description ? { description: frame.description } : {}),
		blocks: frame.blocks,
	};
}

/** Where the embed of a frame is served, inside its organization's own routes. */
export function frameEmbedUrl(
	frameId: string,
	organizationSlug: string,
): string {
	return `/app/${organizationSlug}/frames/${frameId}/embed`;
}
