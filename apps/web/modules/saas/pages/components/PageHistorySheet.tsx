"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { FrameRevisionDialog } from "@saas/frames/components/FrameRevisionDialog";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@ui/components/dialog";
import { useTranslations } from "next-intl";

/** Pages and standalone Frames use the same reviewed-revision history controls. */
export function PageHistorySheet({
	frameId,
	organizationId,
	open,
	onOpenChange,
	onRestored,
}: {
	frameId: string;
	organizationId?: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRestored: () => void;
}) {
	const { user } = useSession();
	const t = useTranslations("frameRevisions");
	const frame = useQuery({
		queryKey: ["frame", frameId, organizationId, user?.id],
		queryFn: () => orpcClient.frames.get({ id: frameId, organizationId }),
		enabled: open && Boolean(organizationId) && Boolean(user?.id),
		retry: false,
	});
	if (!open) {
		return null;
	}
	if (
		frame.data &&
		organizationId &&
		user?.id &&
		frame.data.userId === user.id
	) {
		return (
			<FrameRevisionDialog
				key={frameId}
				frame={frame.data}
				organizationId={organizationId}
				userId={user.id}
				initialTab="history"
				onClose={() => onOpenChange(false)}
				onSaved={async () => {
					await frame.refetch();
					onRestored();
				}}
			/>
		);
	}
	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogTitle>{t("history")}</DialogTitle>
				{frame.isPending ? (
					<output>{t("loading")}</output>
				) : (
					<div role="alert">
						<p>{t("historyError")}</p>
						<Button
							variant="outline"
							onClick={() => frame.refetch()}
						>
							{t("retry")}
						</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
