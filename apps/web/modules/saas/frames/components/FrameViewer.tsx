"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useParams, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useOpenFrameAgent } from "../hooks/use-open-frame-agent";
import { agentContextOfFrame, frameEmbedUrl } from "../lib/frame-tool-types";
import { isUnattendedFrame } from "../lib/strict-sandbox";
import { FrameReviewDialog } from "./FrameReviewDialog";
import { FrameRevisionDialog } from "./FrameRevisionDialog";
import { FrameVizShell } from "./FrameVizShell";

export function FrameViewer({
	frameId,
	organizationId,
}: {
	frameId: string;
	organizationId?: string | null;
}) {
	const search = useSearchParams();
	const [showReviews, setShowReviews] = useState(
		Boolean(search.get("review")),
	);
	const [initialProposalId, setInitialProposalId] = useState(
		search.get("review") === "1"
			? undefined
			: (search.get("review") ?? undefined),
	);

	const { organizationSlug } = useParams<{ organizationSlug: string }>();
	const { user } = useSession();
	const t = useTranslations("frameRevisions");
	const [revisionTab, setRevisionTab] = useState<"edit" | "history" | null>(
		null,
	);
	const queryClient = useQueryClient();
	const frameQuery = useQuery({
		queryKey: ["frame", frameId, organizationId ?? null, user?.id ?? null],
		enabled: Boolean(organizationId && user?.id),
		queryFn: () =>
			orpcClient.frames.get({
				id: frameId,
				organizationId: organizationId ?? null,
			}),
	});

	const openAgent = useOpenFrameAgent(
		agentContextOfFrame({
			frameId,
			surface: frameQuery.data?.surface,
			projectId: frameQuery.data?.projectId,
			updatedAt: frameQuery.data?.updatedAt,
		}),
	);

	if (!organizationId || !user?.id || frameQuery.isLoading) {
		return (
			<div className="p-6 text-sm text-muted-foreground">
				Loading frame…
			</div>
		);
	}

	if (
		frameQuery.isError ||
		!frameQuery.data ||
		frameQuery.data.id !== frameId ||
		frameQuery.data.organizationId !== organizationId
	) {
		return (
			<div className="p-6 text-sm text-destructive">Frame not found.</div>
		);
	}

	const frame = frameQuery.data;
	const frameUrl = `/app/${organizationSlug}/frames/${frame.id}`;
	const embedUrl = frameEmbedUrl(frame.id, organizationSlug);

	return (
		<div className="mx-auto w-full min-w-0 max-w-7xl p-4 sm:p-6">
			{frame.userId === user?.id && organizationId && (
				<div className="mb-3 flex flex-wrap justify-end gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							setInitialProposalId(undefined);
							setShowReviews(true);
						}}
					>
						{t("reviews")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setRevisionTab("history")}
					>
						{t("history")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setRevisionTab("edit")}
					>
						{t("edit")}
					</Button>
				</div>
			)}
			{revisionTab &&
				organizationId &&
				user?.id &&
				frame.userId === user.id && (
					<FrameRevisionDialog
						frame={frame}
						organizationId={organizationId}
						userId={user.id}
						initialTab={revisionTab}
						onClose={() => setRevisionTab(null)}
						onSaved={async () => {
							await queryClient.invalidateQueries({
								queryKey: ["frame", frameId, organizationId],
							});
							await queryClient.invalidateQueries({
								queryKey: ["frames", organizationId],
							});
						}}
					/>
				)}
			{showReviews && frame.userId === user.id && (
				<FrameReviewDialog
					viewedUpdatedAt={frame.updatedAt}
					frameId={frame.id}
					organizationId={organizationId}
					userId={user.id}
					kind={frame.kind}
					initialProposalId={initialProposalId}
					onClose={() => {
						setInitialProposalId(undefined);
						setShowReviews(false);
					}}
					onSaved={async () => {
						await queryClient.invalidateQueries({
							queryKey: ["frame", frameId, organizationId],
						});
					}}
				/>
			)}

			<FrameVizShell
				key={`${frame.id}:${frame.updatedAt}`}
				frameId={frame.id}
				updatedAt={frame.updatedAt}
				surface={frame.surface}
				runtimeTools={frame.runtimeTools}
				onOpenAgent={openAgent}
				title={frame.title}
				description={frame.description ?? undefined}
				kind={frame.kind}
				contentType={frame.contentType}
				frameDocument={frame.document}
				embedUrl={embedUrl}
				frameUrl={frameUrl}
				isPublic={frame.isPublic}
				canManageSharing={frame.userId === user?.id}
				onSharingChanged={() => {
					queryClient.invalidateQueries({
						queryKey: ["frame", frameId, organizationId ?? null],
					});
				}}
				isProjectFrame={Boolean(frame.projectId)}
				interactive={
					!frame.isPublishedSnapshot && !isUnattendedFrame(frame)
				}
				organizationId={frame.organizationId ?? null}
			/>
		</div>
	);
}
