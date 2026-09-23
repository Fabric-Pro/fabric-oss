"use client";

/**
 * The work item page's context menu for an AI-recommended item (Fizzy #2211):
 * "Protect Work Item" keeps it out of every future batch removal.
 *
 * There is no unprotect in v1, so a protected item shows the state as a
 * disabled, checked entry instead of the action.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { MoreHorizontalIcon, ShieldCheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

interface AiRecommendedItemMenuProps {
	projectId: string;
	storyId: string;
	identifier: string;
	protectedAt: string | Date | null;
}

export function AiRecommendedItemMenu({
	projectId,
	storyId,
	identifier,
	protectedAt,
}: AiRecommendedItemMenuProps) {
	const t = useTranslations("projects.stories.aiRecommended.protect");
	const queryClient = useQueryClient();

	const protect = useMutation({
		mutationFn: () =>
			orpcClient.projects.aiRecommended.protect({ projectId, storyId }),
		onSuccess: () => {
			toast.success(t("success"), {
				description: t("successDescription"),
			});
			for (const queryKey of [
				orpc.projects.stories.get.key(),
				orpc.projects.stories.list.key(),
				orpc.projects.aiRecommended.listBatches.key(),
				orpc.projects.aiRecommended.previewBatch.key(),
				["capability-gates", projectId],
			]) {
				void queryClient.invalidateQueries({ queryKey });
			}
		},
		onError: (error) => {
			toast.error(t("error"), { description: error.message });
		},
	});

	const isProtected = protectedAt !== null || protect.isSuccess;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-8"
					aria-label={t("trigger", { identifier })}
				>
					<MoreHorizontalIcon aria-hidden className="size-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{isProtected ? (
					<DropdownMenuCheckboxItem checked disabled>
						{t("protected")}
					</DropdownMenuCheckboxItem>
				) : (
					<DropdownMenuItem
						disabled={protect.isPending}
						onSelect={() => protect.mutate()}
					>
						<ShieldCheckIcon aria-hidden className="mr-2 size-4" />
						{t("action")}
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
