"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FrameDocumentView } from "./FrameRenderer";
import { FrameVizShell } from "./FrameVizShell";

export function FrameViewer({
	frameId,
	organizationId,
}: {
	frameId: string;
	organizationId?: string | null;
}) {
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
	const frameUrl = `/app/frames/${frame.id}`;
	const shareUrl = frame.shareToken
		? `${window.location.origin}/share/frame/${frame.shareToken}`
		: undefined;
	const embedUrl = `${frameUrl}/embed`;

	return (
		<div className="mx-auto max-w-7xl p-6">
			<FrameVizShell
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
			/>
		</div>
	);
}
