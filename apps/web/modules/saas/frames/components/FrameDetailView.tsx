"use client";

import { Skeleton } from "@ui/components/skeleton";
import { useMemo } from "react";
import {
	type FrameDetail,
	type FrameSurfaceName,
	frameDocumentOf,
	frameEmbedUrl,
} from "../lib/frame-tool-types";
import { isUnattendedFrame } from "../lib/strict-sandbox";
import { FrameVizShell } from "./FrameVizShell";

/**
 * One page an agent wrote, read through `fabric_get_frame`, in the sandboxed
 * viewer: a placeholder while it loads, a plain message when it is gone, and
 * otherwise the viewer with the tools the page declared and the organization it
 * belongs to. What a surface adds around it - a back link, "Ask Fabric Agent",
 * history - is the surface's own.
 */
export function FrameDetailView({
	detail,
	surface,
	organizationId,
	organizationSlug,
	onOpenAgent,
	canManageSharing = false,
	onSharingChanged,
}: {
	detail: { isLoading: boolean; isError: boolean; data?: FrameDetail };
	surface: FrameSurfaceName;
	organizationId: string | null;
	organizationSlug: string;
	onOpenAgent?: (prompt: string) => void;
	/** The viewer wrote the page, so the shell offers its Share control. */
	canManageSharing?: boolean;
	onSharingChanged?: () => void;
}) {
	const frame = detail.data;
	const document = useMemo(
		() => (frame ? frameDocumentOf(frame) : undefined),
		[frame],
	);

	if (detail.isLoading) {
		return (
			<Skeleton
				className="h-96 rounded-lg"
				role="status"
				aria-label={`Loading ${surface}`}
			/>
		);
	}
	if (detail.isError || !frame) {
		return (
			<p role="alert" className="text-sm text-destructive">
				This {surface} is no longer available.
			</p>
		);
	}
	return (
		<FrameVizShell
			key={`${frame.frameId}:${frame.updatedAt}`}
			surface={surface}
			frameId={frame.frameId}
			title={frame.title}
			description={frame.description}
			kind={frame.kind}
			embedUrl={frameEmbedUrl(frame.frameId, organizationSlug)}
			shareUrl={frame.shareUrl}
			frameDocument={document}
			isPublic={Boolean(frame.shareUrl)}
			isProjectFrame={Boolean(frame.projectId)}
			interactive={!isUnattendedFrame(frame)}
			organizationId={organizationId}
			runtimeTools={frame.runtimeTools}
			onOpenAgent={onOpenAgent}
			canManageSharing={canManageSharing}
			onSharingChanged={onSharingChanged}
		/>
	);
}
