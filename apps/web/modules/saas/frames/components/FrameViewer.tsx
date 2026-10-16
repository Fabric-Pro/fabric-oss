"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useOpenFrameAgent } from "../hooks/use-open-frame-agent";
import { agentContextOfFrame, frameEmbedUrl } from "../lib/frame-tool-types";
import { isUnattendedFrame } from "../lib/strict-sandbox";
import type { FrameDocumentView } from "./FrameRenderer";
import { FrameVizShell } from "./FrameVizShell";

export function FrameViewer({
	frameId,
	organizationId,
}: {
	frameId: string;
	organizationId?: string | null;
}) {
	const { organizationSlug } = useParams<{ organizationSlug: string }>();
	const queryClient = useQueryClient();
	const frameQuery = useQuery({
		queryKey: ["frame", frameId, organizationId ?? null],
		queryFn: () =>
			orpcClient.frames.get({
				id: frameId,
				organizationId: organizationId ?? null,
			}),
	});

	const publishMutation = useMutation({
		mutationFn: () =>
			orpcClient.frames.publish({
				id: frameId,
				organizationId: organizationId ?? null,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["frame", frameId, organizationId ?? null],
			});
		},
	});

	const revokeMutation = useMutation({
		mutationFn: () =>
			orpcClient.frames.revokeShare({
				id: frameId,
				organizationId: organizationId ?? null,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["frame", frameId, organizationId ?? null],
			});
		},
	});

	const openAgent = useOpenFrameAgent(
		agentContextOfFrame({
			frameId,
			surface: frameQuery.data?.surface,
			projectId: frameQuery.data?.projectId,
		}),
	);

	if (frameQuery.isLoading) {
		return (
			<div className="p-6 text-sm text-muted-foreground">
				Loading frame…
			</div>
		);
	}

	if (!frameQuery.data) {
		return (
			<div className="p-6 text-sm text-destructive">Frame not found.</div>
		);
	}

	const frame = frameQuery.data;
	const frameDoc = frame.document as FrameDocumentView;
	const frameUrl = `/app/${organizationSlug}/frames/${frame.id}`;
	const shareUrl = frame.shareToken
		? `${window.location.origin}/share/frame/${frame.shareToken}`
		: undefined;
	const embedUrl = frameEmbedUrl(frame.id, organizationSlug);

	return (
		<div className="mx-auto max-w-7xl p-6">
			<FrameVizShell
				runtimeTools={frame.runtimeTools}
				onOpenAgent={openAgent}
				title={frame.title}
				description={frame.description ?? undefined}
				kind={frame.kind}
				contentType={frame.contentType}
				frameDocument={frameDoc}
				embedUrl={embedUrl}
				frameUrl={frameUrl}
				shareUrl={shareUrl}
				isPublic={frame.isPublic}
				onPublish={() => publishMutation.mutate()}
				onRevokeShare={() => revokeMutation.mutate()}
				publishPending={publishMutation.isPending}
				revokePending={revokeMutation.isPending}
				isProjectFrame={Boolean(frame.projectId)}
				interactive={!isUnattendedFrame(frame)}
				organizationId={organizationId ?? null}
			/>
		</div>
	);
}
