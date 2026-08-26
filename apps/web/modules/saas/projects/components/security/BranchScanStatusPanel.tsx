"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader } from "@ui/components/card";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import { Loader2Icon, PlayIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type BranchScanStatus,
	type BranchScanStatusValue,
	branchStatusIndicator,
} from "./lib";
import { ScanBranchTag } from "./ScanBranchTag";

type Props = {
	projectId: string;
	/**
	 * `string` for org context, `null` for personal context, `undefined` to let
	 * the server resolve the active org — mirrors the page's resolved value.
	 */
	organizationId?: string | null;
};

/** A branch is "unscanned" (worth bulk-selecting) when it's never been scanned
 *  or has drifted since the last scan. SCANNED needs nothing; SCANNING is live. */
function isSelectable(status: BranchScanStatusValue): boolean {
	return status === "NOT_SCANNED" || status === "STALE";
}

/** Short hover hint per state — supplements the always-visible status label. */
const BRANCH_STATUS_HINT: Record<BranchScanStatusValue, string> = {
	SCANNED: "Up to date with the latest commit on this branch.",
	STALE: "New commits since the last scan — re-scan to refresh.",
	NOT_SCANNED: "This branch hasn't been scanned yet.",
	SCANNING: "A scan is running on this branch.",
};

function toDate(value: Date | string | null | undefined): Date | null {
	if (!value) {
		return null;
	}
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

function pluralCount(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function BranchScanStatusPanel({ projectId, organizationId }: Props) {
	const headingId = useId();
	const forceFullId = useId();
	const queryClient = useQueryClient();
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [forceFull, setForceFull] = useState(false);

	const branchesQuery = useQuery(
		orpc.projects.scan.branches.queryOptions({
			input: { projectId, organizationId },
			// Poll while any branch is mid-scan; stop once they all settle
			// (mirrors the page's latest-scan poll).
			refetchInterval: (query) =>
				query.state.data?.branches.some((b) => b.status === "SCANNING")
					? 3000
					: false,
		}),
	);

	const branches = branchesQuery.data?.branches ?? [];

	const selectableNames = useMemo(
		() => branches.filter((b) => isSelectable(b.status)).map((b) => b.name),
		[branches],
	);

	const triggerMutation = useMutation(
		orpc.projects.scan.trigger.mutationOptions({
			onSuccess: (result) => {
				const count = result.started.length;
				if (count === 0) {
					toast("No scans started", {
						description:
							"The selected branches are already scanning.",
					});
				} else {
					toast.info(
						count > 1 ? `${count} scans started` : "Scan started",
						{ description: "Branch coverage updates as they run." },
					);
				}
				setSelected(new Set());
				// Reflect the new PENDING/RUNNING rows without a full reload.
				queryClient.invalidateQueries({
					queryKey: orpc.projects.scan.branches.key(),
				});
			},
			onError: (error) => {
				toast.error(`Couldn't start scan: ${error.message}`);
			},
		}),
	);

	const runScan = (target: { branch: string } | { branches: string[] }) => {
		triggerMutation.mutate({
			projectId,
			organizationId,
			...target,
			mode: forceFull ? "FULL" : "INCREMENTAL",
		});
	};

	const toggleOne = (name: string, on: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (on) {
				next.add(name);
			} else {
				next.delete(name);
			}
			return next;
		});
	};

	const allSelectableSelected =
		selectableNames.length > 0 &&
		selectableNames.every((n) => selected.has(n));
	const headerChecked: boolean | "indeterminate" = allSelectableSelected
		? true
		: selected.size > 0
			? "indeterminate"
			: false;

	if (branchesQuery.isLoading) {
		return (
			<PanelShell headingId={headingId}>
				<div
					className="h-40 animate-pulse rounded-lg border border-border bg-muted"
					aria-hidden="true"
				/>
			</PanelShell>
		);
	}

	if (branches.length === 0) {
		return (
			<PanelShell headingId={headingId}>
				<div className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
					Connect a repository to see branch coverage.
				</div>
			</PanelShell>
		);
	}

	return (
		<PanelShell headingId={headingId}>
			<Card className="bg-card">
				<CardHeader>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="flex items-center gap-2 text-sm">
							<Checkbox
								checked={headerChecked}
								onCheckedChange={(v) =>
									setSelected(
										v === true
											? new Set(selectableNames)
											: new Set(),
									)
								}
								disabled={selectableNames.length === 0}
								aria-label="Select unscanned branches"
							/>
							<span className="text-muted-foreground">
								Select unscanned
							</span>
						</div>
						<div className="flex flex-wrap items-center gap-4">
							<div className="flex items-center gap-2">
								<Switch
									id={forceFullId}
									checked={forceFull}
									onCheckedChange={setForceFull}
									aria-label="Force full re-scan"
								/>
								<Label
									htmlFor={forceFullId}
									className="text-muted-foreground text-xs"
								>
									Force full re-scan
								</Label>
							</div>
							<Button
								size="sm"
								onClick={() =>
									runScan({ branches: [...selected] })
								}
								disabled={
									selected.size === 0 ||
									triggerMutation.isPending
								}
								className="gap-2"
							>
								{triggerMutation.isPending ? (
									<Loader2Icon
										aria-hidden="true"
										className="size-4 motion-safe:animate-spin"
									/>
								) : (
									<PlayIcon
										aria-hidden="true"
										className="size-4"
									/>
								)}
								Scan selected ({selected.size})
							</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<ul className="space-y-2">
						{branches.map((branch) => (
							<BranchRow
								key={branch.name}
								branch={branch}
								selected={selected.has(branch.name)}
								onToggle={(on) => toggleOne(branch.name, on)}
								onScan={() => runScan({ branch: branch.name })}
								scanPending={triggerMutation.isPending}
							/>
						))}
					</ul>
				</CardContent>
			</Card>
		</PanelShell>
	);
}

/** Section wrapper: the editorial "Branch coverage" label plus its content. */
function PanelShell({
	headingId,
	children,
}: {
	headingId: string;
	children: React.ReactNode;
}) {
	return (
		<section aria-labelledby={headingId} className="space-y-4">
			<h2 id={headingId} className="app-editorial-label">
				Branch coverage
			</h2>
			{children}
		</section>
	);
}

function BranchRow({
	branch,
	selected,
	onToggle,
	onScan,
	scanPending,
}: {
	branch: BranchScanStatus;
	selected: boolean;
	onToggle: (on: boolean) => void;
	onScan: () => void;
	scanPending: boolean;
}) {
	const indicator = branchStatusIndicator(branch.status);
	const Icon = indicator.icon;
	const isScanning = branch.status === "SCANNING";
	const selectable = isSelectable(branch.status);

	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-border bg-background px-4 py-3">
			{selectable ? (
				<Checkbox
					checked={selected}
					onCheckedChange={(v) => onToggle(v === true)}
					aria-label={`Select ${branch.name}`}
				/>
			) : (
				<span className="size-4 shrink-0" aria-hidden="true" />
			)}

			<Tooltip>
				<TooltipTrigger asChild>
					<span
						className={cn(
							"inline-flex items-center gap-1.5",
							indicator.className,
						)}
					>
						<Icon
							aria-hidden="true"
							className={cn(
								"size-4",
								isScanning && "motion-safe:animate-spin",
							)}
						/>
						<span className="font-medium text-xs">
							{indicator.label}
						</span>
					</span>
				</TooltipTrigger>
				<TooltipContent>
					{BRANCH_STATUS_HINT[branch.status]}
				</TooltipContent>
			</Tooltip>

			<ScanBranchTag branch={branch.name} />

			{branch.isDefault ? (
				<Badge variant="outline" className="font-normal text-xs">
					Default
				</Badge>
			) : branch.isPinned ? (
				<Badge variant="outline" className="font-normal text-xs">
					Pinned
				</Badge>
			) : null}

			<div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
				<BranchMeta branch={branch} />
				<Button
					variant="outline"
					size="sm"
					onClick={onScan}
					disabled={isScanning || scanPending}
					aria-label={`Scan ${branch.name}`}
					className="gap-1.5"
				>
					{isScanning ? (
						<Loader2Icon
							aria-hidden="true"
							className="size-3.5 motion-safe:animate-spin"
						/>
					) : (
						<PlayIcon aria-hidden="true" className="size-3.5" />
					)}
					Scan
				</Button>
			</div>
		</li>
	);
}

/**
 * The right-aligned per-branch meta: when it was last scanned, plus the
 * diff-scope the last scan covered ("N changed files · M commits") when the
 * checkpoint recorded it. Nothing renders for a never-scanned branch.
 */
function BranchMeta({ branch }: { branch: BranchScanStatus }) {
	const scannedAt = toDate(branch.lastScannedAt);
	const files = branch.changedFileCount;
	const commits = branch.changedCommitCount;
	const hasScope = files != null && commits != null;

	if (!scannedAt && !hasScope) {
		return null;
	}

	return (
		<div className="flex flex-col items-end text-right">
			{scannedAt ? (
				<time
					dateTime={scannedAt.toISOString()}
					title={scannedAt.toLocaleString()}
					className="text-muted-foreground text-xs"
				>
					{formatDistanceToNow(scannedAt, { addSuffix: true })}
				</time>
			) : null}
			{files != null && commits != null ? (
				<span className="text-muted-foreground/80 text-xs">
					{pluralCount(files, "changed file")} ·{" "}
					{pluralCount(commits, "commit")}
				</span>
			) : null}
		</div>
	);
}
