"use client";

/**
 * StageRequestsButton
 *
 * Toolbar pill showing the number of PENDING drafting-stage transition
 * requests awaiting review (plan Slice 5). Renders nothing when there are
 * none, or when the caller cannot approve (the server enforces
 * STORY_STAGE_APPROVE; this gate only avoids showing an inbox the user
 * cannot act on). Mirrors PendingProposalsButton: highlight pill, one-shot
 * entrance fade, no ambient motion.
 */

import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { ShieldCheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { usePendingStageRequests } from "./StageRequestsInbox";

/** Legacy lowercase project roles that hold STORY_STAGE_APPROVE. */
const APPROVER_ROLES = new Set(["owner", "project_admin"]);

function canReviewStageRequests(userRole: string | null | undefined): boolean {
	return !!userRole && APPROVER_ROLES.has(userRole);
}

type Props = {
	projectId: string;
	organizationId: string | null;
	/** Lowercase legacy role from `projects.get` (`project.userRole`). */
	userRole: string | null | undefined;
	onOpenInbox: () => void;
};

export function StageRequestsButton({
	projectId,
	organizationId,
	userRole,
	onOpenInbox,
}: Props) {
	const t = useTranslations("projects.stories.readiness.stageRequests");
	const tTips = useTranslations("tooltips.stories");
	const canReview = canReviewStageRequests(userRole);
	const { data } = usePendingStageRequests(
		projectId,
		organizationId,
		canReview,
	);
	const count = data?.length ?? 0;

	const [playEntrance, setPlayEntrance] = useState(false);
	const hasEntranceFiredRef = useRef(false);
	useEffect(() => {
		if (count > 0 && !hasEntranceFiredRef.current) {
			hasEntranceFiredRef.current = true;
			setPlayEntrance(true);
		}
	}, [count]);

	if (!canReview || count === 0) {
		return null;
	}

	const label = t("buttonLabel", { count });

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					onClick={onOpenInbox}
					className={[
						"gap-2 border-highlight/30 bg-highlight/15 text-highlight hover:bg-highlight/20",
						playEntrance
							? "motion-safe:animate-in motion-safe:fade-in"
							: "",
					]
						.filter(Boolean)
						.join(" ")}
					aria-label={label}
				>
					<ShieldCheckIcon className="size-4" aria-hidden="true" />
					{label}
				</Button>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs text-xs leading-5">
				<p>{t("buttonTooltip")}</p>
				<p className="mt-1">{tTips("stageRequestsConcept")}</p>
			</TooltipContent>
		</Tooltip>
	);
}
