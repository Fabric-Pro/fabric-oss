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
import { useState } from "react";
import { ReviewCenterPanel } from "./ReviewCenterPanel";
import { useReviewCenterCount } from "./use-review-center";

/**
 * Review Center entry point for the roadmap toolbar.
 *
 * A dedicated inbox icon + count badge that opens the unified slide-over. The
 * badge count is ACTIONABLE items only (conflicts + FAILED/CONFLICT items + ADO
 * pull-drift) and renders nothing when 0. Self-contained: derives `projectId`
 * from the route and tenant/`basePath` from `useOrganizationContext`, so the
 * toolbar only has to render it (no extra prop threading).
 */
export function ReviewCenterInbox() {
	const params = useParams<{ id: string }>();
	const projectId = params?.id;
	const { organizationId } = useOrganizationContext();
	const [open, setOpen] = useState(false);

	const { data } = useReviewCenterCount(projectId ?? "");
	// `.total` = the all-categories actionable sum (conflicts + failures + pull
	// drift), preserving the badge's pre-tabs semantics after the count endpoint
	// split into per-category fields.
	const count = data?.total ?? 0;

	if (!projectId || count === 0) {
		return null;
	}

	const label = `${count} ${count === 1 ? "item" : "items"} to review`;

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="relative h-8 gap-1.5 text-highlight"
						onClick={() => setOpen(true)}
						aria-label={`Review Center: ${label}`}
					>
						<span className="relative flex size-2">
							<span className="absolute inline-flex size-full rounded-full bg-highlight opacity-75 motion-safe:animate-ping" />
							<span className="relative inline-flex size-2 rounded-full bg-highlight" />
						</span>
						<span className="text-xs font-medium tabular-nums">
							{count}
						</span>
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
