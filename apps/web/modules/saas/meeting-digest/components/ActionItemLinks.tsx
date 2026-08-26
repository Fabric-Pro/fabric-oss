"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { buildStoryDetailsRoute } from "@saas/projects/lib/stories/routes";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { XIcon } from "lucide-react";
import Link from "next/link";
import type { ActionItemLinkView } from "../lib/types";

/**
 * The work items one action item points at (#1902 FR2/FR3/FR9).
 *
 * Renders NOTHING when there are no links — no empty state, no "no matches
 * found" line. An action item that matched nothing is the common case and must
 * not read as a failure (FR8/AC2).
 *
 * AUTO links are labelled as suggestions with their confidence in the tooltip,
 * per `fabric/standards/ai/ai-copy-tone.md`: the match is advisory and the user
 * is the one who decides. CREATED links are stated as fact, because the user
 * themselves asked for that ticket.
 */
export function ActionItemLinks({
	projectId,
	links,
	onRemove,
	removingLinkIds,
}: {
	projectId: string;
	links: ActionItemLinkView[];
	onRemove: (linkId: string) => void;
	removingLinkIds: Set<string>;
}) {
	const { basePath } = useOrganizationContext();

	if (links.length === 0) {
		return null;
	}

	return (
		<ul className="mt-1 flex flex-wrap items-center gap-1.5">
			{links.map((link) => {
				const label = `${link.identifier ?? "—"} ${link.title}`;
				const removing = removingLinkIds.has(link.id);
				return (
					<li key={link.id}>
						<span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 bg-muted/30 py-0.5 pr-0.5 pl-2 text-xs">
							<Tooltip>
								<TooltipTrigger asChild>
									<Link
										href={buildStoryDetailsRoute(
											basePath,
											projectId,
											link.storyId,
										)}
										className="min-w-0 max-w-[18rem] truncate underline-offset-2 hover:underline"
									>
										<span className="font-mono">
											{link.identifier ?? "—"}
										</span>{" "}
										<span className="text-muted-foreground">
											{link.title}
										</span>
									</Link>
								</TooltipTrigger>
								<TooltipContent className="max-w-xs">
									{link.origin === "AUTO" ? (
										<>
											<p>
												Suggested from this meeting
												{typeof link.confidence ===
												"number"
													? ` · ${Math.round(link.confidence * 100)}% confidence`
													: ""}
											</p>
											{link.reasoning ? (
												<p className="text-muted-foreground">
													{link.reasoning}
												</p>
											) : null}
										</>
									) : link.origin === "CREATED" ? (
										<p>Created from this action item</p>
									) : (
										<p>Linked by a team member</p>
									)}
								</TooltipContent>
							</Tooltip>
							<button
								type="button"
								onClick={() => onRemove(link.id)}
								disabled={removing}
								aria-label={`Remove link to ${label}`}
								className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
							>
								<XIcon className="size-3" aria-hidden="true" />
							</button>
						</span>
					</li>
				);
			})}
		</ul>
	);
}
