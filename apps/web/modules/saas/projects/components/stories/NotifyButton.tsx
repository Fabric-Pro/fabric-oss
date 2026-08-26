"use client";

import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { UserPlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { NotifyMembersDialog } from "./NotifyMembersDialog";

interface NotifyButtonProps {
	storyId: string;
	projectId: string;
	organizationId: string | null;
}

/**
 * Action-bar button that opens the "Notify project members" dialog. Sits next
 * to `CopyLinkButton` in the feature editor header and mirrors its icon-only
 * a11y shape (aria-label + tooltip).
 */
export function NotifyButton({
	storyId,
	projectId,
	organizationId,
}: NotifyButtonProps) {
	const [open, setOpen] = useState(false);
	const t = useTranslations("projects.stories.workspace");

	return (
		<>
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={() => setOpen(true)}
							aria-label={t("notifyAction")}
							className="shrink-0 size-8 text-muted-foreground hover:text-foreground"
						>
							<UserPlusIcon
								className="size-4"
								aria-hidden="true"
							/>
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">
						<p>{t("notifyAction")}</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
			<NotifyMembersDialog
				projectId={projectId}
				storyId={storyId}
				organizationId={organizationId}
				open={open}
				onOpenChange={setOpen}
			/>
		</>
	);
}
