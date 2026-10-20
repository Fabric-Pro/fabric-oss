"use client";

import {
	findPromptAgentTarget,
	listPromptActions,
	promptActionId,
	promptDocumentTypeLabel,
} from "@repo/utils/prompt-action-catalog";
import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { describeGenerationRefusal } from "@saas/projects/components/proposal-artifact/generation-feedback";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@ui/components/tabs";
import { AlertTriangleIcon, SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useOfferedPromptActions } from "../hooks/use-offered-prompt-actions";
import { ActionMultiSelect } from "./ActionMultiSelect";

/**
 * The admin's queue of proposed defaults.
 *
 * FR18's requirement is the grouping: two people proposing different prompts
 * for the SAME action is the case worth designing for, and a flat list dated
 * newest-first is precisely how an admin approves one without noticing the
 * other. So nominations are grouped by the action they compete over, and a
 * group with more than one entry says so before the reviewer reads any of them.
 *
 * Approving one closes the others in that group; that happens server-side, and
 * the copy here says it will so the reviewer is not surprised by it.
 *
 * With the Proposal artifact on, an organization default at a legacy Proposal
 * action is refused (Fizzy #2946), so the organization queue never approves
 * one: such an action is dropped from what an approval sends, and a
 * nomination naming nothing else can be declined, not approved. The System
 * queue is not shaped by the gate — a System default still serves every
 * organization that has it off.
 */

type NominationTarget = {
	targetKey: string;
	documentType: string;
	storyKind: "FEATURE" | "BUG" | null;
};

type Nomination = {
	id: string;
	targets: NominationTarget[];
	changeSummary: string | null;
	summaryDegraded: boolean;
	createdAt: string;
	nominatedBy: { id: string; name: string | null } | null;
	promptVersion: {
		id: string;
		version: number;
		prompt: { id: string; name: string };
	} | null;
};

const ALL_ACTIONS = listPromptActions();
const ALL_ACTION_IDS: ReadonlySet<string> = new Set(
	ALL_ACTIONS.map((a) => a.id),
);

/** Every action this nomination was proposed for. */
function proposedActionIds(nomination: Nomination): string[] {
	return (nomination.targets ?? []).map((t) =>
		promptActionId(t.targetKey, t.documentType, t.storyKind ?? null),
	);
}

function actionLabel(target: NominationTarget): string {
	const agent = findPromptAgentTarget(target.targetKey);
	const doc = promptDocumentTypeLabel(target.documentType);
	const kind = target.storyKind
		? ` (${target.storyKind === "BUG" ? "Bug" : "Feature"})`
		: "";
	return agent ? `${agent.label} — ${doc}${kind}` : `${doc}${kind}`;
}

export function NominationQueue() {
	const { organizationId, isOrgContext, basePath } = useOrganizationContext();
	const { user } = useSession();
	const queryClient = useQueryClient();
	const router = useRouter();
	const tFeedback = useTranslations(
		"projects.proposalArtifact.generationFeedback",
	);
	const tSuperseded = useTranslations(
		"projects.proposalArtifact.supersededAction",
	);
	const offered = useOfferedPromptActions();
	const [pendingId, setPendingId] = useState<string | null>(null);
	// FR23, per nomination id: the COMPLETE set of action ids the reviewer has
	// settled on. A missing entry means they have not touched it.
	//
	// Complete rather than "the extras beside this row's action", because one
	// nomination is rendered under every action it covers and each row fixes a
	// different action. A group-relative array read against another row's
	// baseline silently changes meaning — and the damage is invisible, since
	// approving a subset is a legitimate outcome.
	const [editedActions, setEditedActions] = useState<
		Record<string, string[]>
	>({});

	// A platform admin reviews the universal queue as well. Both live here
	// rather than on separate pages: they are the same review, and an admin who
	// has to remember a second URL is an admin with an unread queue. The API
	// refuses either scope to anyone without the matching authority, so this
	// only decides what is worth offering.
	const canReviewSystem = user?.role === "admin";
	const [targetScope, setTargetScope] = useState<"SYSTEM" | "ORG">(
		isOrgContext ? "ORG" : "SYSTEM",
	);
	const showScopeTabs = isOrgContext && canReviewSystem;

	const queryKey = ["prompt-nominations", targetScope, organizationId];

	// Only the organization queue is shaped by the gate; see the header.
	const gateShapesQueue = targetScope === "ORG";
	const isSupersededId = (id: string) =>
		gateShapesQueue && ALL_ACTION_IDS.has(id) && !offered.actionIds.has(id);
	const reviewableActions = gateShapesQueue ? offered.actions : ALL_ACTIONS;

	const {
		data,
		isPending: isLoading,
		error,
	} = useQuery({
		queryKey,
		queryFn: async () =>
			(await orpcClient.prompts.nominations.listPending({
				targetScope,
				organizationId: organizationId ?? null,
			})) as Nomination[],
	});

	const nominations = useMemo(() => data ?? [], [data]);

	/**
	 * One group per action, and a nomination naming several actions appears in
	 * each of them — it competes in every one. Keyed by the same action id the
	 * catalog uses so the two views agree on what "the same action" means.
	 */
	const groups = useMemo(() => {
		const byAction = new Map<
			string,
			{ label: string; nominations: Nomination[] }
		>();
		for (const nomination of nominations) {
			for (const target of nomination.targets ?? []) {
				const id = promptActionId(
					target.targetKey,
					target.documentType,
					target.storyKind,
				);
				const existing = byAction.get(id);
				if (existing) {
					existing.nominations.push(nomination);
				} else {
					byAction.set(id, {
						label: actionLabel(target),
						nominations: [nomination],
					});
				}
			}
		}
		return [...byAction.entries()]
			.map(([id, group]) => ({ id, ...group }))
			.sort((a, b) => a.label.localeCompare(b.label));
	}, [nominations]);

	const decide = useMutation({
		mutationFn: async ({
			nominationId,
			action,
			targets,
		}: {
			nominationId: string;
			action: "approve" | "decline" | "withdraw";
			targets?: NominationTarget[];
		}) => {
			const input = {
				nominationId,
				organizationId: organizationId ?? null,
			};
			if (action === "approve") {
				// FR23: approval applies to the set the REVIEWER settled on.
				// Omitted means "as proposed", which the API resolves from the
				// row — sending the unedited set back would be the same thing
				// said less reliably.
				return await orpcClient.prompts.nominations.approve(
					targets ? { ...input, targets } : input,
				);
			}
			if (action === "decline") {
				return await orpcClient.prompts.nominations.decline(input);
			}
			return await orpcClient.prompts.nominations.withdraw(input);
		},
		onSuccess: (result, { action }) => {
			const superseded =
				action === "approve" &&
				typeof result === "object" &&
				result !== null &&
				"supersededCount" in result
					? Number(result.supersededCount)
					: 0;
			toast.success(
				action === "approve"
					? superseded > 0
						? `Approved — ${superseded} competing ${
								superseded === 1 ? "proposal" : "proposals"
							} closed`
						: "Approved and set as the default"
					: action === "decline"
						? "Declined"
						: "Withdrawn",
			);
			queryClient.invalidateQueries({ queryKey });
		},
		onError: (err) => {
			const refusal = describeGenerationRefusal(err, {
				t: tFeedback,
				basePath,
			});
			if (refusal) {
				toast.error("Could not complete that", {
					description: refusal.message,
					action: {
						label: refusal.catalog.label,
						onClick: () => router.push(refusal.catalog.href),
					},
				});
				return;
			}
			toast.error("Could not complete that", {
				description: err instanceof Error ? err.message : String(err),
			});
		},
		onSettled: () => setPendingId(null),
	});

	const run = (
		nominationId: string,
		action: "approve" | "decline" | "withdraw",
		targets?: NominationTarget[],
	) => {
		setPendingId(nominationId);
		decide.mutate({ nominationId, action, targets });
	};

	/** Every action this nomination currently covers, edited or as proposed. */
	const coveredActionIds = (nomination: Nomination): string[] =>
		editedActions[nomination.id] ?? proposedActionIds(nomination);

	/**
	 * FR23: the actions an approval will apply to, once the reviewer has edited
	 * them. Absent from the map means untouched, which is not the same as "the
	 * proposed set" — an untouched nomination sends no targets at all and lets
	 * the API read its own row, so the two can never disagree.
	 *
	 * `primaryActionId` is the action whose row the reviewer pressed Approve
	 * from. It is always included: the multi-select shows it as fixed, so that
	 * is what the reviewer was told would happen.
	 *
	 * An action the Proposal artifact supersedes is never sent (Fizzy #2946):
	 * the server refuses an approval that names one, so a nomination holding
	 * one always sends its set explicitly, without it. An empty result means
	 * there is nothing left to approve.
	 */
	const editedTargets = (
		nomination: Nomination,
		primaryActionId: string,
	): NominationTarget[] | undefined => {
		const edited = editedActions[nomination.id];
		const proposed = proposedActionIds(nomination);
		if (!edited && !proposed.some(isSupersededId)) {
			return undefined;
		}
		return [...new Set([primaryActionId, ...(edited ?? proposed)])]
			.filter((id) => !isSupersededId(id))
			.map((id) => ALL_ACTIONS.find((a) => a.id === id))
			.filter((a): a is NonNullable<typeof a> => Boolean(a))
			.map((a) => ({
				targetKey: a.targetKey,
				documentType: a.documentType,
				storyKind: a.storyKind,
			}));
	};

	const scopeTabs = showScopeTabs && (
		<Tabs
			value={targetScope}
			onValueChange={(value) => setTargetScope(value as "SYSTEM" | "ORG")}
		>
			<TabsList>
				<TabsTrigger value="ORG">This organization</TabsTrigger>
				<TabsTrigger value="SYSTEM">System</TabsTrigger>
			</TabsList>
		</Tabs>
	);

	if (isLoading) {
		return (
			<div className="space-y-6">
				{scopeTabs}
				<div className="flex items-center justify-center py-12">
					<Spinner />
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-6">
				{scopeTabs}
				<p className="py-8 text-center text-muted-foreground text-sm">
					{error instanceof Error
						? error.message
						: "Could not load the queue."}
				</p>
			</div>
		);
	}

	if (groups.length === 0) {
		return (
			<div className="space-y-6">
				{scopeTabs}
				<div className="rounded-lg border p-6 text-center">
					<p className="font-medium text-sm">
						Nothing waiting for review
					</p>
					<p className="mx-auto mt-1 max-w-md text-muted-foreground text-sm">
						When someone proposes a prompt for{" "}
						{targetScope === "ORG"
							? "this organization"
							: "universal use"}
						, it lands here with a summary of what changed and your
						approve or decline decision.
					</p>
					<p className="mx-auto mt-3 max-w-md text-muted-foreground text-xs">
						Proposals are made from the prompt catalog — open any
						action and choose “Propose for org” — or from “Set as
						default” by someone picking a tier they cannot write
						directly.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-8">
			{scopeTabs}
			{groups.map((group) => (
				<section key={group.id} className="space-y-3">
					<div className="flex flex-wrap items-center gap-2">
						<h2 className="font-medium text-sm">{group.label}</h2>
						{group.nominations.length > 1 && (
							<Badge className="bg-highlight/10 text-highlight">
								{group.nominations.length} competing
							</Badge>
						)}
					</div>

					{isSupersededId(group.id) && (
						<p
							data-testid="nomination-superseded-note"
							className="text-muted-foreground text-xs"
						>
							{tSuperseded("actionNote")}
						</p>
					)}

					{group.nominations.length > 1 && (
						<p className="text-muted-foreground text-xs">
							Approving one of these closes the others for this
							action.
						</p>
					)}

					<ul className="divide-y rounded-lg border">
						{group.nominations.map((nomination) => {
							const isOwn =
								nomination.nominatedBy?.id === user?.id;
							const busy =
								pendingId === nomination.id && decide.isPending;
							const approvalTargets = editedTargets(
								nomination,
								group.id,
							);
							// Only actions the gate supersedes: decline, not approve.
							const nothingToApprove =
								approvalTargets !== undefined &&
								approvalTargets.length === 0;
							return (
								<li
									key={`${group.id}:${nomination.id}`}
									className="space-y-3 p-4"
								>
									<div className="flex flex-wrap items-baseline justify-between gap-2">
										<p className="font-medium text-sm">
											{nomination.promptVersion?.prompt
												.name ?? "Untitled prompt"}
											{nomination.promptVersion && (
												<span className="ml-2 font-normal text-muted-foreground text-xs">
													v
													{
														nomination.promptVersion
															.version
													}
												</span>
											)}
										</p>
										<p className="text-muted-foreground text-xs">
											Proposed by{" "}
											{nomination.nominatedBy?.name ??
												"a member"}
										</p>
									</div>

									{nomination.changeSummary && (
										<div className="rounded-md bg-muted p-3">
											<p className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-[0.14em]">
												{nomination.summaryDegraded ? (
													<AlertTriangleIcon
														aria-hidden="true"
														className="size-3"
													/>
												) : (
													<SparklesIcon
														aria-hidden="true"
														className="size-3"
													/>
												)}
												{nomination.summaryDegraded
													? "Summary unavailable"
													: "What changes"}
											</p>
											<p className="mt-1.5 text-sm">
												{nomination.changeSummary}
											</p>
										</div>
									)}

									{/* FR23: the reviewer may narrow or widen the
									    set before approving. Pre-populated from
									    the nomination, and what is ticked here
									    is exactly what approval binds. */}
									{!isOwn && (
										<ActionMultiSelect
											id={`nomination-actions-${nomination.id}-${group.id}`}
											label="Applies to"
											actions={reviewableActions}
											alwaysIncluded={
												isSupersededId(group.id)
													? undefined
													: group.id
											}
											value={coveredActionIds(
												nomination,
											).filter(
												(id) =>
													id !== group.id &&
													!isSupersededId(id),
											)}
											onChange={(next) =>
												setEditedActions((prev) => ({
													...prev,
													// Store the whole set, with
													// this row's fixed action
													// folded back in.
													[nomination.id]: [
														...new Set([
															group.id,
															...next,
														]),
													],
												}))
											}
											hint={
												editedActions[nomination.id]
													? "Approval applies to these actions only."
													: "As proposed. Edit before approving to change what it covers."
											}
										/>
									)}

									{isOwn && nomination.targets.length > 1 && (
										<p className="text-muted-foreground text-xs">
											Also proposed for:{" "}
											{nomination.targets
												.filter(
													(t) =>
														promptActionId(
															t.targetKey,
															t.documentType,
															t.storyKind,
														) !== group.id,
												)
												.map(actionLabel)
												.join(", ")}
										</p>
									)}

									{!isOwn && nothingToApprove && (
										<p
											data-testid="nomination-decline-only"
											className="text-muted-foreground text-xs"
										>
											{tSuperseded(
												"nominationDeclineOnly",
											)}
										</p>
									)}

									<div className="flex flex-wrap gap-2">
										{isOwn ? (
											<Button
												variant="outline"
												size="sm"
												disabled={busy}
												onClick={() =>
													run(
														nomination.id,
														"withdraw",
													)
												}
											>
												Withdraw
											</Button>
										) : (
											<>
												<Button
													size="sm"
													disabled={
														busy || nothingToApprove
													}
													onClick={() =>
														run(
															nomination.id,
															"approve",
															approvalTargets,
														)
													}
												>
													Approve
												</Button>
												<Button
													variant="outline"
													size="sm"
													disabled={busy}
													onClick={() =>
														run(
															nomination.id,
															"decline",
														)
													}
												>
													Decline
												</Button>
											</>
										)}
									</div>
								</li>
							);
						})}
					</ul>
				</section>
			))}
		</div>
	);
}
