"use client";

import { PauseCircleIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Where the sync pill is, while another editor in the room reviews an
 * assistant proposal (Fizzy #2946): one polite announcement that this
 * editor holds still until the proposal is answered — and who reviews it,
 * when their editor names them.
 */
export function ProposalReviewElsewhereStatus({
	reviewerName = null,
}: {
	/** The name the reviewing editor publishes, if any. */
	reviewerName?: string | null;
}) {
	const tRoom = useTranslations("projects.documentEditorRoom");
	return (
		<output
			aria-live="polite"
			className="flex items-center gap-1 text-xs text-muted-foreground"
		>
			<PauseCircleIcon className="h-3 w-3" aria-hidden />
			<span>
				{reviewerName
					? tRoom("proposalElsewhereBy", { name: reviewerName })
					: tRoom("proposalElsewhere")}
			</span>
		</output>
	);
}
