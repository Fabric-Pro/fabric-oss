"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { GitPullRequestIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";

type Props = {
	projectId: string;
	storyId: string;
	testCaseId: string;
	identifier: string;
	organizationId: string | null;
	/**
	 * Short label, for the feature's own case list where the row is narrow.
	 *
	 * Measured on a real feature: that row is 363px wide, and the full label
	 * makes the button 192px — 53% of the row — which truncated the case title
	 * (174px of text into 151px of space). A bare icon avoids that but is the
	 * step nobody finds in a dense row that already carries an identifier, a
	 * title and a status. One short word keeps the control legible and leaves
	 * the title room; the accessible name and the tooltip are unchanged either
	 * way, so nothing is lost for a screen reader or on hover.
	 */
	compact?: boolean;
};

/**
 * Ask for revised steps checked against the pull request that implemented this
 * feature.
 *
 * One component for both places this is offered — the out-of-date section and
 * the feature's own case list — because the interesting part is not the button
 * but what happens after it: the proposal lands on the case and is only
 * reachable from the out-of-date section, so this invalidates that list on
 * success. A second copy of this that forgot the invalidation would write a
 * proposal nobody could accept.
 *
 * Never disabled on "does this feature have a pull request". That is a
 * server-side fact no case list carries, and a control greyed out for a reason
 * the interface cannot name is worse than one that explains itself when pressed
 * — which the procedure does, by refusing with the reason.
 */
export function ReviseFromImplementationButton({
	projectId,
	storyId,
	testCaseId,
	identifier,
	organizationId,
	compact = false,
}: Props) {
	const queryClient = useQueryClient();

	const mutation = useMutation(
		orpc.projects.testCases.drift.proposeFromImplementation.mutationOptions(
			{
				onSuccess: (result) => {
					if (!result.proposed) {
						toast.warning(
							result.rationale ||
								"The pull request shows nothing this test case could verify.",
						);
						return;
					}
					toast.success(
						result.diffTruncated
							? // Said plainly rather than footnoted: a revision that
								// read part of a change must not be taken for one
								// that saw all of it.
								`Revised steps proposed for ${identifier} from #${result.prNumber}, whose diff was too large to read in full. Review them below.`
							: `Revised steps proposed for ${identifier} from #${result.prNumber}. Review them below.`,
					);
					// The case now carries a proposal, so it belongs in the
					// out-of-date list whether or not it ever drifted.
					queryClient.invalidateQueries({
						queryKey: orpc.projects.testCases.drift.list.key(),
					});
				},
				onError: (error) => toast.error(error.message),
			},
		),
	);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					size="sm"
					variant="outline"
					disabled={mutation.isPending}
					aria-label={`Propose revised steps for ${identifier} from the pull request that implemented this feature`}
					onClick={(event) => {
						// The case list wraps each row in a link; without this the
						// click navigates away before the request is sent.
						event.preventDefault();
						event.stopPropagation();
						mutation.mutate({
							projectId,
							testCaseId,
							storyId,
							organizationId,
						});
					}}
				>
					{mutation.isPending ? (
						<Loader2Icon className="size-4 animate-spin" />
					) : (
						<GitPullRequestIcon className="size-4" />
					)}
					{compact ? "Revise" : "From implementation"}
				</Button>
			</TooltipTrigger>
			<TooltipContent>
				Draft revised steps from the diff of the pull request that
				implemented this feature. Accepting them does not mark the case
				as matching the specification — nothing checked it against one.
			</TooltipContent>
		</Tooltip>
	);
}
