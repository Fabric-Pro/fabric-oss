"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	BadgeCheckIcon,
	DownloadIcon,
	Loader2Icon,
	PencilIcon,
	SparklesIcon,
	Trash2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
	Avatar,
	DecisionDateTime,
	DecisionTagPills,
	DomainTag,
} from "./DecisionAtoms";
import { DecisionComments } from "./DecisionComments";
import type { EditableDecision } from "./DecisionFormDialog";
import {
	DecisionStatusBadge,
	DecisionStatusSelect,
} from "./DecisionStatusSelect";
import { DecisionVersionHistory } from "./DecisionVersionHistory";
import {
	decisionFilename,
	decisionToMarkdown,
	downloadMarkdown,
} from "./decisionMarkdown";
import {
	allRelationships,
	type RelationshipIndex,
	type RelRef,
} from "./relationships";

type Props = {
	projectId: string;
	decisionId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	canEdit: boolean;
	canDelete: boolean;
	onEdit: (decision: EditableDecision) => void;
	onChanged: () => void;
	relationshipIndex?: RelationshipIndex;
	onOpenDecision?: (id: string) => void;
};

function Section({ label, value }: { label: string; value?: string | null }) {
	if (!value || !value.trim()) {
		return null;
	}
	return (
		<div>
			<p className="app-editorial-label">{label}</p>
			<p className="mt-1 whitespace-pre-wrap break-words text-foreground/90 text-sm">
				{value}
			</p>
		</div>
	);
}

function RelRow({
	kind,
	target,
	onOpen,
}: {
	kind: string;
	target: RelRef;
	onOpen?: (id: string) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onOpen?.(target.id)}
			disabled={!onOpen}
			className="flex w-full items-center gap-2 rounded-md border bg-card px-3 py-2 text-left transition-colors hover:bg-accent disabled:cursor-default disabled:hover:bg-card"
		>
			<span className="shrink-0 text-muted-foreground text-xs">
				{kind}
			</span>
			<span className="shrink-0 font-mono text-xs">
				{target.identifier}
			</span>
			<span className="min-w-0 flex-1 truncate text-sm">
				{target.title}
			</span>
			<DecisionStatusBadge status={target.status} />
		</button>
	);
}

export function DecisionDetailSheet({
	projectId,
	decisionId,
	open,
	onOpenChange,
	canEdit,
	canDelete,
	onEdit,
	onChanged,
	relationshipIndex,
	onOpenDecision,
}: Props) {
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const tTooltips = useTranslations("tooltips.decisions");

	const enabled = open && Boolean(decisionId);
	const { data, isLoading } = useQuery({
		...orpc.projects.architectureDecisions.get.queryOptions({
			input: {
				projectId,
				id: decisionId ?? "",
				organizationId: organizationId ?? null,
			},
		}),
		enabled,
	});
	const decision = data?.decision;
	const endorsementCopy = decision?.vouchedByName
		? tTooltips("endorsedBy", { name: decision.vouchedByName })
		: tTooltips("humanEndorsed");

	const rels =
		decision && relationshipIndex
			? allRelationships(decision, relationshipIndex)
			: null;
	const hasRels = Boolean(
		rels &&
			(rels.supersedes.length > 0 ||
				rels.supersededBy ||
				rels.related.length > 0),
	);

	const deleteMutation = useMutation(
		orpc.projects.architectureDecisions.delete.mutationOptions({
			onSuccess: () => {
				toast.success("Decision deleted");
				onOpenChange(false);
				onChanged();
			},
			onError: (error) =>
				toast.error(`Failed to delete: ${error.message}`),
		}),
	);

	const vouchMutation = useMutation(
		orpc.projects.architectureDecisions.vouch.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.projects.architectureDecisions.get.queryKey({
						input: {
							projectId,
							id: decisionId ?? "",
							organizationId: organizationId ?? null,
						},
					}),
				});
				onChanged();
			},
			onError: (error) =>
				toast.error(`Failed to endorse: ${error.message}`),
		}),
	);

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
			>
				{isLoading || !decision ? (
					<>
						<SheetHeader className="sr-only">
							<SheetTitle>Architecture decision</SheetTitle>
						</SheetHeader>
						<div className="flex flex-1 items-center justify-center text-muted-foreground">
							<Loader2Icon className="size-5 animate-spin" />
						</div>
					</>
				) : (
					<>
						<SheetHeader className="space-y-2 border-b p-6">
							<div className="flex items-start justify-between gap-3">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-mono text-muted-foreground text-xs">
										{decision.identifier}
									</span>
									<DecisionStatusSelect
										projectId={projectId}
										decisionId={decision.id}
										value={decision.status}
										canEdit={canEdit}
										organizationId={organizationId}
										onChanged={onChanged}
									/>
									<DomainTag domain={decision.domain} />
									<DecisionTagPills
										decisionType={decision.decisionType}
										duration={decision.duration}
										priorityFlagged={
											decision.priorityFlagged
										}
									/>
									{decision.owner && (
										<span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/60 py-0.5 pr-2.5 pl-0.5 text-[11px]">
											<Avatar
												name={decision.owner.name}
												image={decision.owner.image}
											/>
											<span className="text-muted-foreground">
												Owner
											</span>
											<span className="font-medium text-foreground">
												{decision.owner.name}
											</span>
										</span>
									)}
									{/* The chip is not focusable, so the tooltip is a
										pointer affordance; the `sr-only` child carries
										the same copy for assistive tech and leaves the
										visible "Endorsed" in the accessible name. */}
									{decision.vouchedAt && (
										<Tooltip>
											<TooltipTrigger asChild>
												<span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
													<BadgeCheckIcon className="size-3" />
													Endorsed
													<span className="sr-only">
														{endorsementCopy}
													</span>
												</span>
											</TooltipTrigger>
											<TooltipContent>
												{endorsementCopy}
											</TooltipContent>
										</Tooltip>
									)}
								</div>
								<DecisionVersionHistory
									projectId={projectId}
									decisionId={decision.id}
									currentVersion={decision.currentVersion}
									canEdit={canEdit}
									organizationId={organizationId}
									onReverted={onChanged}
								/>
							</div>
							<SheetTitle className="break-words font-serif text-2xl font-normal leading-tight">
								{decision.title}
							</SheetTitle>
							<SheetDescription className="flex items-center gap-1.5 text-xs">
								<DecisionDateTime
									value={decision.decisionDate}
								/>
								{decision.sourceKind === "meeting_decision" && (
									<span className="inline-flex items-center gap-1 text-primary">
										<SparklesIcon className="size-3" />
										captured from a meeting
									</span>
								)}
							</SheetDescription>
						</SheetHeader>

						<div className="flex-1 space-y-6 overflow-y-auto p-6">
							<Section
								label="Context / problem"
								value={decision.contextProblem}
							/>
							<Section
								label="Decision drivers"
								value={decision.decisionDrivers}
							/>
							<Section
								label="Decision"
								value={decision.decision}
							/>
							<Section
								label="Rationale"
								value={decision.rationale}
							/>
							<Section
								label="Alternatives considered"
								value={decision.alternativesConsidered}
							/>
							<Section
								label="Consequences"
								value={decision.consequences}
							/>

							{(decision.participants.length > 0 ||
								decision.participantsText) && (
								<div>
									<p className="app-editorial-label">
										Participants
									</p>
									<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
										{decision.participants.map((p) => (
											<span
												key={p.id}
												className="flex items-center gap-1.5 text-sm"
											>
												<Avatar
													name={p.name}
													image={p.image}
												/>
												{p.name}
											</span>
										))}
										{decision.participantsText && (
											<span className="text-muted-foreground text-sm">
												{decision.participantsText}
											</span>
										)}
									</div>
								</div>
							)}

							{hasRels && rels ? (
								<div>
									<p className="app-editorial-label mb-2">
										Relationships
									</p>
									<div className="space-y-1.5">
										{rels.supersedes.map((r) => (
											<RelRow
												key={r.id}
												kind="Supersedes"
												target={r}
												onOpen={onOpenDecision}
											/>
										))}
										{rels.supersededBy && (
											<RelRow
												kind="Superseded by"
												target={rels.supersededBy}
												onOpen={onOpenDecision}
											/>
										)}
										{rels.related.map((r) => (
											<RelRow
												key={r.id}
												kind="Related to"
												target={r}
												onOpen={onOpenDecision}
											/>
										))}
									</div>
								</div>
							) : (
								decision.supersededBy && (
									<div>
										<p className="app-editorial-label">
											Superseded by
										</p>
										<p className="mt-1 text-foreground/90 text-sm">
											{decision.supersededBy.identifier} ·{" "}
											{decision.supersededBy.title}
										</p>
									</div>
								)
							)}

							<div className="border-t pt-6">
								<p className="app-editorial-label mb-3">
									Discussion
								</p>
								{decisionId && (
									<DecisionComments
										projectId={projectId}
										architectureDecisionId={decisionId}
									/>
								)}
							</div>
						</div>

						<div className="flex items-center justify-between gap-2 border-t p-4">
							{canDelete ? (
								<Button
									variant="ghost"
									size="sm"
									className="text-destructive hover:text-destructive"
									disabled={deleteMutation.isPending}
									onClick={() => {
										if (
											window.confirm(
												"Delete this architecture decision? This can't be undone.",
											)
										) {
											deleteMutation.mutate({
												projectId,
												id: decision.id,
												organizationId,
											});
										}
									}}
								>
									<Trash2Icon className="mr-2 size-4" />
									Delete
								</Button>
							) : (
								<span />
							)}
							<div className="flex items-center gap-2">
								<Button
									variant="outline"
									size="sm"
									title="Export this decision as Markdown"
									onClick={() =>
										downloadMarkdown(
											decisionFilename(
												decision.identifier,
												decision.title,
											),
											decisionToMarkdown({
												identifier: decision.identifier,
												title: decision.title,
												status: decision.status,
												domain: decision.domain,
												decisionDate:
													decision.decisionDate,
												contextProblem:
													decision.contextProblem,
												decisionDrivers:
													decision.decisionDrivers,
												decision: decision.decision,
												rationale: decision.rationale,
												alternativesConsidered:
													decision.alternativesConsidered,
												consequences:
													decision.consequences,
												participantNames:
													decision.participantNames,
												participantsText:
													decision.participantsText,
												vouchedByName:
													decision.vouchedByName,
												vouchedAt: decision.vouchedAt,
											}),
										)
									}
								>
									<DownloadIcon className="mr-2 size-4" />
									Export
								</Button>
								{canEdit && (
									<Button
										variant="outline"
										size="sm"
										disabled={vouchMutation.isPending}
										title={
											decision.vouchedAt
												? "Remove endorsement"
												: "Endorse — mark as settled for the AI"
										}
										onClick={() =>
											vouchMutation.mutate({
												projectId,
												id: decision.id,
												vouched: !decision.vouchedAt,
												organizationId:
													organizationId ?? null,
											})
										}
									>
										<BadgeCheckIcon
											className={
												decision.vouchedAt
													? "mr-2 size-4 text-emerald-600 dark:text-emerald-400"
													: "mr-2 size-4"
											}
										/>
										{decision.vouchedAt
											? "Endorsed"
											: "Endorse"}
									</Button>
								)}
								{canEdit && (
									<Button
										size="sm"
										onClick={() =>
											onEdit({
												id: decision.id,
												title: decision.title,
												decision: decision.decision,
												contextProblem:
													decision.contextProblem,
												rationale: decision.rationale,
												decisionDrivers:
													decision.decisionDrivers,
												alternativesConsidered:
													decision.alternativesConsidered,
												consequences:
													decision.consequences,
												status: decision.status,
												domain: decision.domain,
												decisionDate:
													decision.decisionDate,
												participantUserIds:
													decision.participantUserIds,
												participantsText:
													decision.participantsText,
												supersededById:
													decision.supersededById,
												relatedDecisionIds:
													decision.relatedDecisionIds,
												supersedesIds:
													rels?.supersedes.map(
														(r) => r.id,
													) ?? [],
												decisionTypeId:
													decision.decisionTypeId,
												ownerUserId:
													decision.ownerUserId,
												duration: decision.duration,
												priorityFlagged:
													decision.priorityFlagged,
											})
										}
									>
										<PencilIcon className="mr-2 size-4" />
										Edit
									</Button>
								)}
							</div>
						</div>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}
