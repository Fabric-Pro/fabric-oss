"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type AiReprioritizeResult,
	useAiReprioritizeStory,
} from "./useAiReprioritizeStory";

type Props = {
	projectId: string;
	organizationId: string | null;
	storyId: string;
	/** F-XXX — disambiguates the button in a list of identical sparkles. */
	identifier: string;
	/** See {@link useAiReprioritizeStory}: refresh the caller's own views. */
	onApplied?: (result: AiReprioritizeResult) => void;
	className?: string;
};

/**
 * The per-item AI sparkle: one click re-assesses THIS work item on its own
 * signals and applies the result immediately. It deliberately does NOT weigh
 * the item against the rest of the list — that is what the roadmap's list-wide
 * "Re-prioritize" button is for. The tooltip says so, so the two are never
 * confused.
 */
export function AiReprioritizeControl({
	projectId,
	organizationId,
	storyId,
	identifier,
	onApplied,
	className,
}: Props) {
	const t = useTranslations("projects.stories.priority");
	const mutation = useAiReprioritizeStory({
		projectId,
		organizationId,
		onApplied,
	});
	const pending = mutation.isPending;

	// Guard instead of `disabled`: disabling the focused element drops keyboard
	// focus to <body> the moment it fires — the same hazard the Re-prioritize
	// button documents. The pending state is carried by aria-busy, the spinner
	// and the name change instead.
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-busy={pending}
					aria-label={
						pending
							? t("aiReassessing")
							: t("aiReassessFor", { identifier })
					}
					onClick={() => {
						if (pending) {
							return;
						}
						// Always isolated — this control never considers peers.
						mutation.mutate({ storyId, withListContext: false });
					}}
					className={cn(
						"inline-flex items-center gap-1 rounded p-1 text-secondary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						pending && "opacity-60",
						className,
					)}
				>
					{pending ? (
						<Loader2Icon
							aria-hidden
							className="size-3.5 motion-safe:animate-spin"
						/>
					) : (
						<SparklesIcon aria-hidden className="size-3.5" />
					)}
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-xs">
				{t("aiReassessTooltip")}
			</TooltipContent>
		</Tooltip>
	);
}
