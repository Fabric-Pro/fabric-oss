"use client";

import { buildArtifactLink } from "@saas/projects/lib/links/buildArtifactLink";
import { buildCopyLinkPayload } from "@saas/projects/lib/story-copy-link";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface CopyLinkButtonProps {
	/** `story.identifier` — e.g. `"F-001"`. Null/undefined falls back to title-only label. */
	identifier: string | null | undefined;
	/** Current (possibly unsaved) title shown in the editor. */
	title: string;
	storyId: string;
	projectId: string;
	/** Org slug from the route; `undefined` on personal-context routes. */
	organizationSlug: string | undefined;
}

export function CopyLinkButton({
	identifier,
	title,
	storyId,
	projectId,
	organizationSlug,
}: CopyLinkButtonProps) {
	const [isCopied, setIsCopied] = useState(false);
	const timerRef = useRef<NodeJS.Timeout | null>(null);
	const tWorkspace = useTranslations("projects.stories.workspace");
	const tStories = useTranslations("tooltips.stories");

	useEffect(() => {
		return () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
		};
	}, []);

	const handleClick = useCallback(async () => {
		const url = buildArtifactLink({
			kind: "story",
			id: storyId,
			projectId,
			organizationSlug,
			baseUrl: process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin,
		});
		const { htmlContent, textContent } = buildCopyLinkPayload(
			identifier,
			title,
			url,
		);

		try {
			if (
				typeof ClipboardItem !== "undefined" &&
				navigator.clipboard?.write
			) {
				await navigator.clipboard.write([
					new ClipboardItem({
						"text/html": new Blob([htmlContent], {
							type: "text/html",
						}),
						"text/plain": new Blob([textContent], {
							type: "text/plain",
						}),
					}),
				]);
			} else if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(textContent);
			} else {
				throw new Error("Clipboard API unavailable");
			}

			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
			setIsCopied(true);
			timerRef.current = setTimeout(() => setIsCopied(false), 1500);
			toast.success(tWorkspace("copyLinkSuccess"));
		} catch {
			toast.error(tWorkspace("copyLinkFailed"));
		}
	}, [identifier, title, storyId, projectId, organizationSlug, tWorkspace]);

	return (
		<>
			<span className="sr-only" aria-live="polite">
				{isCopied ? tWorkspace("copyLinkSuccess") : ""}
			</span>
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={handleClick}
							aria-label="Copy link"
							className="shrink-0 size-8 text-muted-foreground hover:text-foreground"
						>
							{isCopied ? (
								<CheckIcon
									className="size-4 text-green-500"
									aria-hidden="true"
								/>
							) : (
								<CopyIcon
									className="size-4"
									aria-hidden="true"
								/>
							)}
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">
						<p>{tStories("storyCopyLink")}</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		</>
	);
}
