"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { InboxIcon } from "lucide-react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ReviewCenterPanel } from "./ReviewCenterPanel";
import { useReviewCenterCount } from "./use-review-center";

/**
 * Review Center entry point for the roadmap toolbar.
 *
 * A labelled Sync issues button opens the unified slide-over. Its
 * count includes actionable items only (conflicts + FAILED/CONFLICT items + ADO
 * pull-drift). It hides at 0 only after its open panel closes. Self-contained: derives `projectId`
 * from the route and tenant/`basePath` from `useOrganizationContext`, so the
 * toolbar only has to render it (no extra prop threading).
 */
export function ReviewCenterInbox() {
	const t = useTranslations("projects.stories.roadmapUi");
	const params = useParams<{ id: string }>();
	const projectId = params?.id;
	const { organizationId } = useOrganizationContext();
	const [open, setOpen] = useState(false);

	const { data } = useReviewCenterCount(projectId ?? "");
	// `.total` = the all-categories actionable sum (conflicts + failures + pull
	// drift), preserving the badge's pre-tabs semantics after the count endpoint
	// split into per-category fields.
	const count = data?.total ?? 0;
	if (!projectId || (count === 0 && !open)) {
		return null;
	}

	const label = t("syncIssues", { count });

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setOpen(true)}
						aria-label={label}
					>
						<span className="tabular-nums">{label}</span>
						<InboxIcon className="size-3.5" aria-hidden />
					</Button>
				</TooltipTrigger>
				<TooltipContent>{label}</TooltipContent>
			</Tooltip>

			<ReviewCenterPanel
				projectId={projectId}
				organizationId={organizationId}
				open={open}
				onOpenChange={setOpen}
			/>
		</>
	);
}
