"use client";

import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { PendingProposalsButton } from "./PendingProposalsButton";
import { ReviewCenterInbox } from "./pm-sync/review-center/ReviewCenterInbox";
import { RoadmapContextStrip } from "./RoadmapContextStrip";
import { RoadmapSectionSwitcher } from "./RoadmapSectionSwitcher";
import { StageRequestsButton } from "./StageRequestsButton";

/** One stable owner for all three review controls, independent of their counts. */
export function RoadmapHeader({
	children,
	projectId,
	organizationId,
	userRole,
	synced,
	unsynced,
	priorityEnabled,
	section,
	onSectionChange,
	onOpenProposalsInbox,
	onOpenStageRequests,
}: {
	children: ReactNode;
	projectId: string;
	organizationId: string | null;
	userRole: string | null | undefined;
	synced: number;
	unsynced: number;
	priorityEnabled: boolean;
	section: "items" | "priority";
	onSectionChange: (next: "items" | "priority") => void;
	onOpenProposalsInbox: () => void;
	onOpenStageRequests: () => void;
}) {
	const t = useTranslations("projects.stories.roadmapUi");
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div className="flex flex-wrap items-center gap-2">
					<h2 className="font-display text-2xl font-semibold tracking-tight">
						{t("title")}
					</h2>
					{priorityEnabled && (
						<RoadmapSectionSwitcher
							value={section}
							onChange={onSectionChange}
						/>
					)}
					<RoadmapContextStrip />
					<PageTourButton pageId="stories" />
				</div>
				<div
					data-testid="roadmap-header-actions"
					className="ml-auto flex flex-wrap items-center justify-end gap-2"
				>
					{children}
				</div>
			</div>
			<div
				data-testid="roadmap-status-row"
				className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2"
			>
				<span className="mr-auto w-full text-sm text-muted-foreground md:w-auto">
					{[
						t("linked", { count: synced }),
						t("unlinked", { count: unsynced }),
					].join(" · ")}
				</span>
				<PendingProposalsButton
					projectId={projectId}
					organizationId={organizationId}
					onOpenInbox={onOpenProposalsInbox}
				/>
				<StageRequestsButton
					projectId={projectId}
					organizationId={organizationId}
					userRole={userRole}
					onOpenInbox={onOpenStageRequests}
				/>
				<ReviewCenterInbox />
			</div>
		</div>
	);
}
