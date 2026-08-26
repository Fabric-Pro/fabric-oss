"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { cn } from "@ui/lib";
import { Columns2Icon, HistoryIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { type DecisionStatus, formatDecisionDateTime } from "./constants";
import { DecisionStatusBadge } from "./DecisionStatusSelect";

interface VersionRow {
	id: string;
	version: number;
	status: DecisionStatus;
	title: string;
	contextProblem: string;
	decision: string;
	rationale: string;
	decisionDrivers: string | null;
	alternativesConsidered: string | null;
	consequences: string | null;
	participantsText: string | null;
	editedByName: string;
	createdAt: string | Date;
}

type Props = {
	projectId: string;
	decisionId: string;
	currentVersion: number;
	canEdit: boolean;
	organizationId?: string | null;
	onReverted?: () => void;
};

function VSection({ label, value }: { label: string; value?: string | null }) {
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

const COMPARE_FIELDS: { label: string; key: keyof VersionRow }[] = [
	{ label: "Title", key: "title" },
	{ label: "Context / problem", key: "contextProblem" },
	{ label: "Decision drivers", key: "decisionDrivers" },
	{ label: "Decision", key: "decision" },
	{ label: "Rationale", key: "rationale" },
	{ label: "Alternatives considered", key: "alternativesConsidered" },
	{ label: "Consequences", key: "consequences" },
	{ label: "Participants", key: "participantsText" },
];

/**
 * One side of the version comparison. Sections whose text differs from
 * `compareTo` (the current version) are flagged so changes are easy to spot.
 */
function VersionPane({
	v,
	heading,
	compareTo,
	className,
}: {
	v: VersionRow;
	heading: string;
	compareTo?: VersionRow | null;
	className?: string;
}) {
	return (
		<div className={cn("space-y-4", className)}>
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-muted-foreground text-xs">
					{heading}
				</span>
				<DecisionStatusBadge status={v.status} />
				<span className="text-muted-foreground text-xs">
					{v.editedByName} · {formatDecisionDateTime(v.createdAt)}
				</span>
			</div>
			{COMPARE_FIELDS.map((f) => {
				const value = (v[f.key] as string | null) ?? "";
				if (!value.trim()) {
					return null;
				}
				const changed =
					Boolean(compareTo) &&
					((compareTo?.[f.key] as string | null) ?? "") !== value;
				return (
					<div
						key={f.key}
						className={cn(
							changed && "border-highlight border-l-2 pl-3",
						)}
					>
						<p
							className={cn(
								"app-editorial-label",
								changed && "text-highlight",
							)}
						>
							{f.label}
							{changed && " · changed"}
						</p>
						<p className="mt-1 whitespace-pre-wrap break-words text-foreground/90 text-sm">
							{value}
						</p>
					</div>
				);
			})}
		</div>
	);
}

/** Top-right version-history dropdown: last 5 + show more, view a version, revert. */
export function DecisionVersionHistory({
	projectId,
	decisionId,
	currentVersion,
	canEdit,
	organizationId,
	onReverted,
}: Props) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const [viewing, setViewing] = useState<VersionRow | null>(null);
	const [comparing, setComparing] = useState(false);

	const { data } = useQuery({
		...orpc.projects.architectureDecisions.versions.list.queryOptions({
			input: {
				projectId,
				architectureDecisionId: decisionId,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: open,
	});
	const versions = (data?.versions ?? []) as VersionRow[];
	const shown = showAll ? versions : versions.slice(0, 5);
	const current = versions.find((v) => v.version === currentVersion) ?? null;
	const isViewingCurrent = viewing?.version === currentVersion;
	const canCompare = Boolean(current) && !isViewingCurrent;

	const revertMutation = useMutation(
		orpc.projects.architectureDecisions.versions.revert.mutationOptions({
			onSuccess: () => {
				toast.success("Reverted — saved as a new version");
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.architectureDecisions.versions.list.queryKey(
							{
								input: {
									projectId,
									architectureDecisionId: decisionId,
									organizationId: organizationId ?? null,
								},
							},
						),
				});
				setViewing(null);
				setComparing(false);
				setOpen(false);
				onReverted?.();
			},
			onError: (error) => toast.error(`Revert failed: ${error.message}`),
		}),
	);

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						className="gap-1.5"
						aria-label="Version history"
					>
						<HistoryIcon className="size-3.5" />v{currentVersion}
					</Button>
				</PopoverTrigger>
				<PopoverContent align="end" className="w-80 p-0">
					<div className="border-b px-3 py-2.5">
						<p className="font-medium text-sm">Version history</p>
					</div>
					<ul className="max-h-72 overflow-y-auto p-1">
						{shown.map((v) => (
							<li key={v.id}>
								<button
									type="button"
									onClick={() => setViewing(v)}
									className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent"
								>
									<span className="flex items-center gap-2">
										<span className="font-mono text-muted-foreground text-xs">
											v{v.version}
											{v.version === currentVersion &&
												" · current"}
										</span>
										<DecisionStatusBadge
											status={v.status}
										/>
									</span>
									<span className="truncate text-muted-foreground text-xs">
										{v.editedByName} ·{" "}
										{formatDecisionDateTime(v.createdAt)}
									</span>
								</button>
							</li>
						))}
						{versions.length === 0 && (
							<li className="px-2 py-3 text-muted-foreground text-sm">
								No history yet.
							</li>
						)}
					</ul>
					{versions.length > 5 && !showAll && (
						<button
							type="button"
							onClick={() => setShowAll(true)}
							className="w-full border-t p-2 text-center text-primary text-xs transition-colors hover:bg-accent"
						>
							Show more ({versions.length - 5} older)
						</button>
					)}
				</PopoverContent>
			</Popover>

			<Dialog
				open={Boolean(viewing)}
				onOpenChange={(o) => {
					if (!o) {
						setViewing(null);
						setComparing(false);
					}
				}}
			>
				<DialogContent
					className={cn(
						"max-h-[85vh] overflow-y-auto",
						comparing && canCompare ? "max-w-4xl" : "max-w-2xl",
					)}
				>
					{viewing && (
						<>
							<DialogHeader>
								<div className="flex items-center gap-2">
									<span className="font-mono text-muted-foreground text-xs">
										v{viewing.version}
										{isViewingCurrent && " · current"}
									</span>
									<DecisionStatusBadge
										status={viewing.status}
									/>
								</div>
								<DialogTitle className="break-words font-serif text-xl font-normal">
									{comparing && canCompare
										? `Comparing v${viewing.version} with current (v${currentVersion})`
										: viewing.title}
								</DialogTitle>
								<DialogDescription>
									{comparing && canCompare
										? "Side-by-side — sections that differ from the current version are marked."
										: `${viewing.editedByName} · ${formatDecisionDateTime(viewing.createdAt)}`}
								</DialogDescription>
							</DialogHeader>
							{comparing && current && !isViewingCurrent ? (
								<div className="grid gap-4 sm:grid-cols-2 sm:divide-x">
									<VersionPane
										v={viewing}
										heading={`v${viewing.version}`}
										compareTo={current}
										className="sm:pr-4"
									/>
									<VersionPane
										v={current}
										heading={`v${current.version} · current`}
										className="sm:pl-4"
									/>
								</div>
							) : (
								<div className="space-y-4">
									<VSection
										label="Context / problem"
										value={viewing.contextProblem}
									/>
									<VSection
										label="Decision drivers"
										value={viewing.decisionDrivers}
									/>
									<VSection
										label="Decision"
										value={viewing.decision}
									/>
									<VSection
										label="Rationale"
										value={viewing.rationale}
									/>
									<VSection
										label="Alternatives considered"
										value={viewing.alternativesConsidered}
									/>
									<VSection
										label="Consequences"
										value={viewing.consequences}
									/>
									{viewing.participantsText && (
										<VSection
											label="Participants"
											value={viewing.participantsText}
										/>
									)}
								</div>
							)}
							<DialogFooter>
								{canCompare && (
									<Button
										variant="outline"
										className="sm:mr-auto"
										onClick={() => setComparing((c) => !c)}
									>
										<Columns2Icon className="mr-2 size-4" />
										{comparing
											? "Hide comparison"
											: "Compare with current"}
									</Button>
								)}
								<Button
									variant="outline"
									onClick={() => {
										setViewing(null);
										setComparing(false);
									}}
								>
									Close
								</Button>
								{canEdit && !isViewingCurrent && (
									<Button
										disabled={revertMutation.isPending}
										onClick={() =>
											revertMutation.mutate({
												projectId,
												id: decisionId,
												version: viewing.version,
												organizationId:
													organizationId ?? null,
											})
										}
									>
										<RotateCcwIcon className="mr-2 size-4" />
										Revert to this version
									</Button>
								)}
							</DialogFooter>
						</>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
