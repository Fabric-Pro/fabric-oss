"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowRightLeftIcon,
	BadgeCheckIcon,
	LinkIcon,
	PinIcon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { DecisionDuration, DecisionStatus } from "./constants";
import {
	type AvatarPerson,
	AvatarStack,
	DecisionDateTime,
	DecisionTagPills,
	DomainTag,
} from "./DecisionAtoms";
import { DecisionStatusSelect } from "./DecisionStatusSelect";
import {
	primaryRelationship,
	type RelationshipIndex,
	type RelationshipKind,
} from "./relationships";

export interface TableDecision {
	id: string;
	identifier: string;
	title: string;
	status: DecisionStatus;
	domain: string | null;
	decisionDate: string | Date;
	participants: AvatarPerson[];
	pinnedAt?: string | Date | null;
	vouchedAt?: string | Date | null;
	sourceKind: string | null;
	supersededById?: string | null;
	relatedDecisionIds?: string[];
	decisionType?: { id: string; name: string } | null;
	duration?: DecisionDuration | null;
	priorityFlagged?: boolean;
}

const REL_ICON: Record<RelationshipKind, typeof LinkIcon> = {
	Supersedes: ArrowRightLeftIcon,
	"Superseded by": ArrowRightLeftIcon,
	Related: LinkIcon,
};

/**
 * Compact tabular view of the decision log — the per-user "Table" alternative to
 * the cards. Carries the same interactivity: inline status change, pin/unpin,
 * relationship traversal, and row-click to open, all with hover affordances.
 */
export function DecisionsTable({
	items,
	index,
	projectId,
	organizationId,
	canEdit,
	onOpen,
	onChanged,
}: {
	items: TableDecision[];
	index?: RelationshipIndex;
	projectId: string;
	organizationId?: string | null;
	canEdit: boolean;
	onOpen: (id: string) => void;
	onChanged: () => void;
}) {
	return (
		<div className="overflow-x-auto rounded-lg border">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b bg-muted/40 text-left text-muted-foreground text-xs uppercase tracking-wide">
						<th className="px-3 py-2 font-medium">ADR</th>
						<th className="px-3 py-2 font-medium">Decision</th>
						<th className="px-3 py-2 font-medium">Status</th>
						<th className="hidden px-3 py-2 font-medium md:table-cell">
							Participants
						</th>
						<th className="px-3 py-2 text-right font-medium">
							Date
						</th>
						<th className="w-8 px-2 py-2" aria-label="Actions" />
					</tr>
				</thead>
				<tbody>
					{items.map((d) => (
						<DecisionTableRow
							key={d.id}
							d={d}
							index={index}
							projectId={projectId}
							organizationId={organizationId}
							canEdit={canEdit}
							onOpen={onOpen}
							onChanged={onChanged}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
}

function DecisionTableRow({
	d,
	index,
	projectId,
	organizationId,
	canEdit,
	onOpen,
	onChanged,
}: {
	d: TableDecision;
	index?: RelationshipIndex;
	projectId: string;
	organizationId?: string | null;
	canEdit: boolean;
	onOpen: (id: string) => void;
	onChanged: () => void;
}) {
	const tTooltips = useTranslations("tooltips.decisions");
	const pinned = Boolean(d.pinnedAt);
	const rel = index ? primaryRelationship(d, index) : null;
	const RelIcon = rel ? REL_ICON[rel.kind] : null;

	const pinMutation = useMutation(
		orpc.projects.architectureDecisions.pin.mutationOptions({
			onSuccess: onChanged,
			onError: (e) => toast.error(`Failed to pin: ${e.message}`),
		}),
	);

	return (
		<tr
			onClick={(e) => {
				if ((e.target as HTMLElement).closest("[data-no-row-open]")) {
					return;
				}
				onOpen(d.id);
			}}
			onKeyDown={(e) => {
				if (
					e.key === "Enter" &&
					!(e.target as HTMLElement).closest("[data-no-row-open]")
				) {
					onOpen(d.id);
				}
			}}
			tabIndex={0}
			className={cn(
				"group cursor-pointer border-b border-l-2 border-l-transparent transition-colors last:border-b-0 hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none",
				pinned && "border-l-primary bg-primary/[0.04]",
			)}
		>
			<td className="px-3 py-2.5 align-top">
				<span className="font-mono text-muted-foreground text-xs">
					{d.identifier}
				</span>
			</td>
			<td className="max-w-[32rem] px-3 py-2.5 align-top">
				<div className="flex flex-wrap items-center gap-2">
					<span className="line-clamp-2 min-w-0 break-words font-medium text-foreground">
						{d.title}
					</span>
					<DomainTag domain={d.domain} />
					<DecisionTagPills
						decisionType={d.decisionType}
						duration={d.duration}
						priorityFlagged={d.priorityFlagged}
					/>
					{d.sourceKind === "meeting_decision" && (
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="inline-flex">
									<SparklesIcon
										className="size-3 text-primary"
										aria-label="From meeting"
									/>
								</span>
							</TooltipTrigger>
							<TooltipContent
								surface="popover"
								className="max-w-56"
							>
								<span className="font-medium">
									From meeting
								</span>{" "}
								— extracted from a meeting transcript. Review
								and complete the details.
							</TooltipContent>
						</Tooltip>
					)}
					{d.vouchedAt && (
						<BadgeCheckIcon
							className="size-3.5 text-emerald-600 dark:text-emerald-400"
							aria-label="Human-endorsed"
						/>
					)}
					{rel && RelIcon && (
						// The button's visible text (kind + identifier) already
						// names it, so no `aria-label` here — one would drop that
						// visible text out of the accessible name.
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										onOpen(rel.ref.id);
									}}
									className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
								>
									<RelIcon className="size-3" />
									{rel.kind}
									<span className="font-mono">
										{rel.ref.identifier}
									</span>
								</button>
							</TooltipTrigger>
							<TooltipContent>
								{tTooltips("relatedItem", {
									kind: rel.kind,
									identifier: rel.ref.identifier,
									title: rel.ref.title,
								})}
							</TooltipContent>
						</Tooltip>
					)}
				</div>
			</td>
			<td className="px-3 py-2.5 align-top" data-no-row-open>
				<span className="relative z-10 inline-flex">
					<DecisionStatusSelect
						projectId={projectId}
						decisionId={d.id}
						value={d.status}
						canEdit={canEdit}
						organizationId={organizationId}
						onChanged={onChanged}
					/>
				</span>
			</td>
			<td className="hidden px-3 py-2.5 align-top md:table-cell">
				<AvatarStack people={d.participants} max={4} />
			</td>
			<td className="whitespace-nowrap px-3 py-2.5 text-right align-top text-muted-foreground text-xs">
				<DecisionDateTime value={d.decisionDate} />
			</td>
			<td className="px-2 py-2.5 align-top" data-no-row-open>
				{canEdit && (
					<span className="relative z-10 inline-flex">
						<Button
							variant="ghost"
							size="icon"
							disabled={pinMutation.isPending}
							title={pinned ? "Unpin" : "Pin to top"}
							aria-label={
								pinned
									? "Unpin decision"
									: "Pin decision to top"
							}
							className={cn(
								"size-7 transition-opacity",
								pinned
									? "text-primary opacity-100"
									: "text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100",
							)}
							onClick={() =>
								pinMutation.mutate({
									projectId,
									id: d.id,
									pinned: !pinned,
									organizationId: organizationId ?? null,
								})
							}
						>
							<PinIcon
								className={cn(
									"size-4",
									pinned && "fill-current",
								)}
							/>
						</Button>
					</span>
				)}
			</td>
		</tr>
	);
}
