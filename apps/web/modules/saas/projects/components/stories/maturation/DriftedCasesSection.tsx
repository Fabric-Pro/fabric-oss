"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { CheckIcon, Loader2Icon, SparklesIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ReviseFromImplementationButton } from "./ReviseFromImplementationButton";

type Props = {
	projectId: string;
	storyId: string;
	organizationId: string | null;
	/** The feature has acceptance criteria to revise against. */
	hasAcceptanceCriteria: boolean;
};

/**
 * Test cases on this feature that are waiting for somebody: drafted from text
 * that has since changed, or carrying a proposal nobody has decided on.
 *
 * Renders nothing when neither applies — the common case, and a panel that is
 * always present but usually empty trains people to stop reading it.
 *
 * The second half is why a case with no spec fingerprint can appear here at all.
 * Revising against the IMPLEMENTATION can be asked of any case, including a
 * hand-authored one, and this section is the only place a proposal can be
 * accepted or rejected — so a case able to hold one has to be able to show up.
 *
 * The proposal is deliberately not applied on generation. It is stored, shown,
 * and waits: an AI may propose a change to the suite, never make one. Rejecting
 * clears the proposal but leaves a drifted case listed, because the suggestion
 * being wrong does not make the case current.
 */
export function DriftedCasesSection({
	projectId,
	storyId,
	organizationId,
	hasAcceptanceCriteria,
}: Props) {
	const queryClient = useQueryClient();
	// Which case each button is working on, so one row's spinner does not appear
	// on every row.
	const [busyId, setBusyId] = useState<string | null>(null);
	const [rationales, setRationales] = useState<Record<string, string>>({});

	const driftQuery = useQuery(
		orpc.projects.testCases.drift.list.queryOptions({
			input: { projectId, storyId, organizationId },
		}),
	);

	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.testCases.drift.list.key(),
		});

	const proposeMutation = useMutation(
		orpc.projects.testCases.drift.propose.mutationOptions({
			onSuccess: (result, variables) => {
				if (!result.proposed) {
					// The model found nothing this case can still verify. Surfaced as
					// a warning rather than silently storing an empty proposal —
					// removing coverage is a decision, not an accept.
					toast.warning(
						result.rationale ||
							"There is nothing left for this test case to verify.",
					);
					return;
				}
				setRationales((prev) => ({
					...prev,
					[variables.testCaseId]: result.rationale,
				}));
				refresh();
			},
			onError: (error) => toast.error(error.message),
			onSettled: () => setBusyId(null),
		}),
	);

	const acceptMutation = useMutation(
		orpc.projects.testCases.drift.accept.mutationOptions({
			onSuccess: (result) => {
				if (!result.applied) {
					toast.error(
						"That proposal is no longer available — reload and try again.",
					);
					return;
				}
				toast.success("Test case updated.");
				refresh();
				// The case's steps changed, so any list showing them is now stale.
				queryClient.invalidateQueries({
					queryKey: orpc.projects.testCases.list.key(),
				});
			},
			onError: (error) => toast.error(error.message),
			onSettled: () => setBusyId(null),
		}),
	);

	const rejectMutation = useMutation(
		orpc.projects.testCases.drift.reject.mutationOptions({
			onSuccess: () => refresh(),
			onError: (error) => toast.error(error.message),
			onSettled: () => setBusyId(null),
		}),
	);

	const cases = driftQuery.data?.cases ?? [];
	if (driftQuery.isLoading || cases.length === 0) {
		return null;
	}

	const driftedCount = cases.filter((c) => c.isSpecDrifted).length;
	const awaitingCount = cases.filter(
		(c) => c.hasProposal && !c.isSpecDrifted,
	).length;

	return (
		<section className="space-y-3">
			<div>
				<h3 className="editorial-label">Needs a look</h3>
				<p className="mt-1 text-muted-foreground text-sm">
					{[
						driftedCount > 0 &&
							`${driftedCount} ${driftedCount === 1 ? "test case was" : "test cases were"} drafted from an earlier version of this feature.`,
						awaitingCount > 0 &&
							`${awaitingCount} ${awaitingCount === 1 ? "case has" : "cases have"} proposed steps waiting for a decision.`,
					]
						.filter(Boolean)
						.join(" ")}{" "}
					Ask for revised steps — checked against the specification,
					or against the pull request that implemented it — then
					accept or reject them.
				</p>
			</div>

			<ul className="divide-y rounded-lg border bg-card">
				{cases.map((testCase) => {
					const busy = busyId === testCase.id;
					return (
						<li
							key={testCase.id}
							className="flex flex-wrap items-center gap-3 p-3"
						>
							<div className="min-w-0 flex-1">
								<p className="truncate font-medium text-sm">
									<span className="text-muted-foreground">
										{testCase.identifier}
									</span>{" "}
									{testCase.title}
								</p>
								{rationales[testCase.id] && (
									<p className="mt-1 text-muted-foreground text-xs">
										{rationales[testCase.id]}
									</p>
								)}
							</div>

							{testCase.hasProposal ? (
								<div className="flex items-center gap-2">
									<Button
										size="sm"
										variant="outline"
										disabled={busy}
										onClick={() => {
											setBusyId(testCase.id);
											acceptMutation.mutate({
												projectId,
												testCaseId: testCase.id,
												storyId,
												organizationId,
											});
										}}
									>
										{busy ? (
											<Loader2Icon className="size-4 animate-spin" />
										) : (
											<CheckIcon className="size-4" />
										)}
										Accept
									</Button>
									<Button
										size="sm"
										variant="ghost"
										disabled={busy}
										aria-label={`Reject the proposed steps for ${testCase.identifier}`}
										onClick={() => {
											setBusyId(testCase.id);
											rejectMutation.mutate({
												projectId,
												testCaseId: testCase.id,
												organizationId,
											});
										}}
									>
										<XIcon className="size-4" />
									</Button>
								</div>
							) : (
								<div className="flex items-center gap-2">
									{/* Offered only for a case that actually
									    drifted. A case listed here purely
									    because it carries a proposal has a
									    fingerprint matching the current text, or
									    none at all, so revising "against the
									    spec" has nothing to correct. */}
									{testCase.isSpecDrifted && (
										<Tooltip>
											<TooltipTrigger asChild>
												{/* A span, so the tooltip still opens
												    while the button is disabled —
												    otherwise the one case that explains
												    WHY it is disabled is the one nobody
												    can read. */}
												<span>
													<Button
														size="sm"
														variant="outline"
														disabled={
															busy ||
															!hasAcceptanceCriteria
														}
														onClick={() => {
															setBusyId(
																testCase.id,
															);
															proposeMutation.mutate(
																{
																	projectId,
																	testCaseId:
																		testCase.id,
																	storyId,
																	organizationId,
																},
															);
														}}
													>
														{busy ? (
															<Loader2Icon className="size-4 animate-spin" />
														) : (
															<SparklesIcon className="size-4" />
														)}
														From spec
													</Button>
												</span>
											</TooltipTrigger>
											<TooltipContent>
												{hasAcceptanceCriteria
													? "Draft revised steps from this feature's current acceptance criteria."
													: "Add acceptance criteria to this feature first — they are what the revised steps are checked against."}
											</TooltipContent>
										</Tooltip>
									)}

									<ReviseFromImplementationButton
										projectId={projectId}
										storyId={storyId}
										testCaseId={testCase.id}
										identifier={testCase.identifier}
										organizationId={organizationId}
									/>
								</div>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
