"use client";

import { Button } from "@ui/components/button";
import { HistoryIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Says that the newest edit passed its checks but was not published because
 * the version it was made from has been replaced since (`supersededEdit`).
 *
 * `role="status"`, not `alert`: nothing was lost and there is nothing to do
 * urgently. It appears on a poll, with no interaction of the viewer's own to
 * announce it.
 */
export function InstructionsSupersededNotice({
	superseded,
	publishedVersion,
	onOpenHistory,
}: {
	superseded: { version: number; baseVersion: number };
	publishedVersion: number;
	onOpenHistory: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.publishedView");
	return (
		<div
			role="status"
			className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-4"
		>
			<p className="text-muted-foreground text-sm">
				{t("supersededBody", {
					version: superseded.version,
					baseVersion: superseded.baseVersion,
					publishedVersion,
				})}
			</p>
			<div>
				<Button variant="outline" onClick={onOpenHistory}>
					<HistoryIcon className="size-4" aria-hidden="true" />
					{t("supersededHistoryButton")}
				</Button>
			</div>
		</div>
	);
}
