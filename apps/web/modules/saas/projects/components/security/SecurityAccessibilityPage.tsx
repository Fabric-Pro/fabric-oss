"use client";

import { useEffectiveOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { PageHeader } from "@saas/shared/components/PageHeader";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { DestructiveTooltip } from "@ui/components/destructive-tooltip";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangleIcon,
	ChevronDownIcon,
	HistoryIcon,
	Loader2Icon,
	PlayIcon,
	RefreshCwIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { BranchScanStatusPanel } from "./BranchScanStatusPanel";
import {
	formatElapsed,
	isCancelledScan,
	isScanActive,
	type ProjectScan,
	SCAN_STATUS_BADGE_VARIANT,
	SCAN_STATUS_LABEL,
	type ScanStatus,
} from "./lib";
import { ScanBranchTag } from "./ScanBranchTag";
import { ScanConfigCard } from "./ScanConfigCard";
import { ScanFindingsList } from "./ScanFindingsList";
import { ScanHistoryDialog } from "./ScanHistoryDialog";
import { ScanPageInfoButton } from "./ScanInfo";

type Props = {
	projectId: string;
	/**
	 * `string` for org context, `null` for personal context, `undefined` to
	 * fall back to the active-organization context (mirrors the kanban route
	 * view). Resolved to a concrete value via `useEffectiveOrganizationId`.
	 */
	organizationId?: string | null;
};

function toDate(value: Date | string | null | undefined): Date | null {
	if (!value) {
		return null;
	}
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

export function SecurityAccessibilityPage({
	projectId,
	organizationId: organizationIdProp,
}: Props) {
	const organizationId = useEffectiveOrganizationId(organizationIdProp);
	const queryClient = useQueryClient();
	const tooltips = useTranslations("tooltips.security");
	const [historyOpen, setHistoryOpen] = useState(false);
	// Re-scan with purge (G10): confirm before deleting unresolved findings.
	const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);

	const configQuery = useQuery(
		orpc.projects.scan.config.get.queryOptions({
			input: { projectId, organizationId },
		}),
	);

	// The selected scan branch drives the branch-aware results + polling
	// below: the saved config scanBranch (blank => undefined) scopes the
	// latest-scan + findings queries to that branch.
	const selectedBranch =
		configQuery.data?.config?.scanBranch?.trim() || undefined;

	const latestQuery = useQuery(
		orpc.projects.scan.latest.queryOptions({
			input: {
				projectId,
				organizationId,
				...(selectedBranch ? { branch: selectedBranch } : {}),
			},
			// Poll while a scan is in-flight; stop once it settles.
			refetchInterval: (query) => {
				const status = query.state.data?.scan?.status as
					| ScanStatus
					| undefined;
				return isScanActive(status) ? 3000 : false;
			},
		}),
	);

	const latestScan = latestQuery.data?.scan ?? null;
	const scanInFlight = isScanActive(latestScan?.status);

	const config = configQuery.data?.config;
	// The run button is enabled when ANY of the four scan engines is on — the
	// AI Security review, the AI Accessibility review, Semgrep SAST, or the
	// git-history secret scan. This previously only checked the AI reviewers, so
	// a project configured with only Semgrep / git-history enabled couldn't run
	// a scan: "Enable at least one scanner…" stayed up with the button disabled.
	const noScannerEnabled =
		!!config &&
		!config.securityEnabled &&
		!config.accessibilityEnabled &&
		!config.semgrepEnabled &&
		!config.gitHistoryEnabled;

	// Toast once per completed/failed transition (tracks the scan id + status so
	// re-renders don't re-fire and a re-run with a new id announces again).
	const announcedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!latestScan) {
			return;
		}
		const key = `${latestScan.id}:${latestScan.status}`;
		if (
			latestScan.status === "COMPLETED" ||
			latestScan.status === "FAILED"
		) {
			if (announcedRef.current === key) {
				return;
			}
			announcedRef.current = key;
			if (latestScan.status === "FAILED") {
				toast.error("Scan failed", {
					description:
						latestScan.error ?? "The scan could not be completed.",
				});
			} else {
				const total =
					latestScan.securityFindingCount +
					latestScan.accessibilityFindingCount;
				if (total === 0) {
					toast.success("Clean scan — no issues found");
				} else {
					toast.warning(
						`Scan complete — ${total} ${
							total === 1 ? "issue" : "issues"
						} found`,
					);
				}
			}
			// Findings changed when a scan settles — refresh the list views.
			queryClient.invalidateQueries({
				queryKey: orpc.projects.scan.findings.list.key(),
			});
		}
	}, [latestScan, queryClient]);

	const triggerMutation = useMutation(
		orpc.projects.scan.trigger.mutationOptions({
			onSuccess: () => {
				toast.info("Scan started", {
					description: "We'll let you know when it finishes.",
				});
				// Immediately reflect PENDING/RUNNING in the UI.
				latestQuery.refetch();
			},
			onError: (error) => {
				toast.error(`Couldn't start scan: ${error.message}`);
			},
		}),
	);

	// Cancel a running scan — stops waiting on the workflow's own (up to
	// 90-minute) execution timeout. On success the latest-scan poll refetches
	// (the row has flipped terminal), so the UI leaves "Scanning…", and findings
	// refresh (nothing was applied, but keep the views fresh).
	const cancelMutation = useMutation(
		orpc.projects.scan.cancel.mutationOptions({
			onSuccess: (result) => {
				// Pre-seed the settle-effect key so the FAILED row we just wrote
				// doesn't pop the generic "Scan failed — Cancelled by user" toast
				// for a cancel the user deliberately initiated.
				if (latestScan) {
					announcedRef.current = `${latestScan.id}:FAILED`;
				}
				toast.success(
					result.cancelled
						? "Scan cancelled"
						: "Scan already finished",
				);
				latestQuery.refetch();
				queryClient.invalidateQueries({
					queryKey: orpc.projects.scan.findings.list.key(),
				});
			},
			onError: (error) => {
				toast.error(`Couldn't cancel the scan: ${error.message}`);
			},
		}),
	);

	const handleCancelScan = () => {
		if (!latestScan) {
			return;
		}
		cancelMutation.mutate({
			projectId,
			organizationId,
			scanId: latestScan.id,
		});
	};

	const runDisabled =
		noScannerEnabled || scanInFlight || triggerMutation.isPending;

	const handleRunScan = (mode: "INCREMENTAL" | "FULL") => {
		triggerMutation.mutate({ projectId, organizationId, mode });
	};

	// Re-scan with purge (G10): delete current unresolved findings, then run a
	// FULL scan so carry-forward re-evaluates severity from scratch. Resolved /
	// dismissed findings are preserved server-side.
	const handlePurgeRescan = () => {
		setPurgeConfirmOpen(false);
		triggerMutation.mutate({
			projectId,
			organizationId,
			mode: "FULL",
			purgeUnresolved: true,
		});
	};

	const busy = scanInFlight || triggerMutation.isPending;

	// Split button (Atlas-style): primary "Scan" runs an incremental scan (only
	// items changed since the last scan); the dropdown also offers a Full scan.
	const runButton = (
		<div className="inline-flex" data-onboarding-target="security-run-scan">
			<Button
				onClick={() => handleRunScan("INCREMENTAL")}
				disabled={runDisabled}
				className="gap-2 rounded-r-none"
				aria-label="Run an incremental scan of changed items"
			>
				{busy ? (
					<Loader2Icon
						aria-hidden="true"
						className="size-4 motion-safe:animate-spin"
					/>
				) : (
					<PlayIcon aria-hidden="true" className="size-4" />
				)}
				{scanInFlight ? "Scanning…" : "Scan"}
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						disabled={runDisabled}
						className="rounded-l-none border-primary-foreground/20 border-l px-2"
						aria-label="More scan options"
					>
						<ChevronDownIcon
							aria-hidden="true"
							className="size-4"
						/>
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-72">
					<DropdownMenuItem
						onSelect={() => handleRunScan("INCREMENTAL")}
						className="flex-col items-start gap-0.5"
					>
						<span className="font-medium">Scan</span>
						<span className="text-muted-foreground text-xs">
							Only items changed since the last scan — faster.
							Unchanged findings are kept.
						</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() => handleRunScan("FULL")}
						className="flex-col items-start gap-0.5"
					>
						<span className="font-medium">Full scan</span>
						<span className="text-muted-foreground text-xs">
							Re-analyze every feature and document from scratch.
						</span>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					{/* Re-scan with purge (G10) — destructive, double-guarded
					    by a destructive tooltip AND a confirm modal. */}
					<DestructiveTooltip
						copy={
							tooltips.raw("purgeRescan") as {
								label: string;
								warning: string;
							}
						}
						side="left"
					>
						<DropdownMenuItem
							onSelect={(e) => {
								// Keep the menu's selection from closing the
								// confirm dialog we're about to open.
								e.preventDefault();
								setPurgeConfirmOpen(true);
							}}
							className="flex-col items-start gap-0.5 text-destructive focus:text-destructive"
						>
							<span className="flex items-center gap-1.5 font-medium">
								<Trash2Icon
									aria-hidden="true"
									className="size-3.5"
								/>
								Delete current findings & re-scan
							</span>
							<span className="text-muted-foreground text-xs">
								Delete the current unresolved findings, then run
								a full scan. Resolved and dismissed findings are
								kept.
							</span>
						</DropdownMenuItem>
					</DestructiveTooltip>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);

	// Scans history lives in the page header; findings history moved into the
	// RESULTS bar (rendered by ScanFindingsList) so it's discoverable from the
	// results it describes.
	const historyButtons = (
		<Button
			variant="outline"
			onClick={() => setHistoryOpen(true)}
			className="gap-2"
		>
			<HistoryIcon aria-hidden="true" className="size-4" />
			Scans history
		</Button>
	);

	// Cancel control — shown ONLY while a scan is actually in flight
	// (PENDING/RUNNING). Destructive-styled because it aborts in-progress work;
	// no findings are deleted, so it's recoverable by re-running.
	const cancelScanButton =
		scanInFlight && latestScan ? (
			<Button
				variant="destructive"
				onClick={handleCancelScan}
				disabled={cancelMutation.isPending}
				className="gap-2"
				aria-label="Cancel the running scan"
			>
				{cancelMutation.isPending ? (
					<Loader2Icon
						aria-hidden="true"
						className="size-4 motion-safe:animate-spin"
					/>
				) : (
					<XIcon aria-hidden="true" className="size-4" />
				)}
				Cancel scan
			</Button>
		) : null;

	const headerActions = (
		<div className="flex flex-wrap items-center gap-2">
			{historyButtons}
			{noScannerEnabled ? (
				<Tooltip>
					<TooltipTrigger asChild>
						{/* Span wrapper keeps the tooltip reachable while the
						    button is disabled. */}
						<span className="inline-flex">{runButton}</span>
					</TooltipTrigger>
					<TooltipContent>
						Enable at least one scanner below to run a scan.
					</TooltipContent>
				</Tooltip>
			) : (
				runButton
			)}
			{cancelScanButton}
		</div>
	);

	return (
		<div className="space-y-8">
			{/* Live region announcing scan status for assistive tech. */}
			<output className="sr-only" aria-live="polite">
				{scanInFlight
					? "A security and accessibility scan is running."
					: latestScan
						? `Latest scan ${SCAN_STATUS_LABEL[
								latestScan.status
							].toLowerCase()}.`
						: ""}
			</output>

			<PageHeader
				label="Security & Accessibility"
				title="Security & Accessibility"
				titleAdornment={<ScanPageInfoButton />}
				description="Configure AI scanning, run scans on demand, and review security and accessibility findings for this project."
				actions={headerActions}
				getStartedPageId="security"
			/>

			<LastScanSummary
				scan={latestScan}
				isLoading={latestQuery.isLoading}
				onRetry={() => handleRunScan("INCREMENTAL")}
				retryDisabled={runDisabled}
				retrying={triggerMutation.isPending}
			/>

			<ScanConfigCard
				projectId={projectId}
				organizationId={organizationId}
			/>

			<BranchScanStatusPanel
				projectId={projectId}
				organizationId={organizationId}
			/>

			<div
				className="space-y-4"
				data-onboarding-target="security-results"
			>
				<h2 className="app-editorial-label">Results</h2>
				<ScanFindingsList
					projectId={projectId}
					organizationId={organizationId}
					latestScan={latestScan}
					branch={selectedBranch}
					scanInFlight={scanInFlight}
				/>
			</div>

			{/* Scans history: scan runs + configuration changes. (Findings
			    history now lives in the RESULTS bar, rendered by
			    ScanFindingsList, next to "Review findings".) */}
			<ScanHistoryDialog
				projectId={projectId}
				organizationId={organizationId}
				group="SCANS"
				open={historyOpen}
				onOpenChange={setHistoryOpen}
			/>

			{/* Re-scan with purge (G10): confirm before deleting findings. */}
			<AlertDialog
				open={purgeConfirmOpen}
				onOpenChange={setPurgeConfirmOpen}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Delete current findings and re-scan?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This permanently deletes the current unresolved
							(open) findings for this project, then runs a full
							scan from scratch. Resolved and dismissed findings
							are kept. Any unsaved triage on open findings is
							lost.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={handlePurgeRescan}
							variant="destructive"
						>
							Delete &amp; re-scan
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

/**
 * Re-render every `intervalMs` while `active`, returning the current epoch ms.
 * Drives the live running-scan timer; inactive ⇒ no interval (no wasted ticks).
 */
function useNow(active: boolean, intervalMs = 1000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) {
			return;
		}
		// Snap immediately so the first frame after activation is accurate.
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [active, intervalMs]);
	return now;
}

/** Display name of whoever triggered the scan, or null if unavailable. */
function scanActorName(scan: ProjectScan): string | null {
	return scan.user?.name ?? scan.user?.email ?? null;
}

function LastScanSummary({
	scan,
	isLoading,
	onRetry,
	retryDisabled,
	retrying,
}: {
	scan: ProjectScan | null;
	isLoading: boolean;
	/** Re-run the scan from the failure surface. */
	onRetry: () => void;
	retryDisabled: boolean;
	retrying: boolean;
}) {
	const tTooltips = useTranslations("tooltips.security");
	// Tick every second while a scan is in-flight so the elapsed timer advances
	// live. It's derived from the server `startedAt`, so it stays correct across
	// refresh / navigation — every mount recomputes from the absolute timestamp.
	const isActive = !!scan && isScanActive(scan.status);
	const now = useNow(isActive);

	if (isLoading) {
		return (
			<div
				className="h-12 animate-pulse rounded-lg border border-border bg-muted"
				aria-hidden="true"
			/>
		);
	}

	if (!scan) {
		return (
			<div className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-muted-foreground text-sm">
				No scans yet — run your first scan to check this project.
			</div>
		);
	}

	// In-flight (PENDING / RUNNING): show an indeterminate progress bar in place
	// of the settled summary, mirroring the design's running state, plus a live
	// elapsed timer and who started the scan.
	if (isScanActive(scan.status)) {
		const startedAt = toDate(scan.startedAt) ?? toDate(scan.createdAt);
		const elapsedMs = startedAt ? now - startedAt.getTime() : 0;
		const actor = scanActorName(scan);
		return (
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
				<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
					Last scan
				</span>
				<Badge variant={SCAN_STATUS_BADGE_VARIANT[scan.status]}>
					{SCAN_STATUS_LABEL[scan.status]}
				</Badge>
				{scan.branch ? <ScanBranchTag branch={scan.branch} /> : null}
				<div
					className="h-1.5 w-40 overflow-hidden rounded-full bg-muted"
					role="progressbar"
					aria-label="Scan in progress"
				>
					<div className="scan-progress-indeterminate h-full rounded-full bg-primary" />
				</div>
				<span className="text-muted-foreground text-xs">
					Scanning this project…
				</span>
				{/* The chip already carries its own `aria-label`, which wins over
					any child content — so no `sr-only` echo here, it would never
					be read. The tooltip rehomes the pointer affordance. */}
				<Tooltip>
					<TooltipTrigger asChild>
						<span
							role="timer"
							className="font-mono text-foreground text-xs tabular-nums"
							aria-label={`Running for ${formatElapsed(elapsedMs)}`}
						>
							{formatElapsed(elapsedMs)}
						</span>
					</TooltipTrigger>
					<TooltipContent>
						{startedAt
							? tTooltips("scanStartedAt", {
									startedAt: startedAt.toLocaleString(),
								})
							: tTooltips("scanElapsed")}
					</TooltipContent>
				</Tooltip>
				{actor && (
					<span className="text-muted-foreground text-xs">
						Started by {actor}
					</span>
				)}
			</div>
		);
	}

	// FAILED: a bare red badge on the settled layout below leaves the user with
	// no idea WHY the scan failed or what to do (bug #1935). The failure reason —
	// already classified server-side and carried on `scan.error` — persists here
	// in an alert (not just the transient toast), with an actionable retry. A
	// user-initiated cancel is stored as FAILED too, but it isn't a failure — it
	// keeps the calm settled summary below, not this alarming surface.
	if (scan.status === "FAILED" && !isCancelledScan(scan)) {
		const failedAt = toDate(scan.completedAt) ?? toDate(scan.createdAt);
		const actor = scanActorName(scan);
		const reason = scan.error?.trim();
		return (
			<Alert variant="error">
				<AlertTriangleIcon aria-hidden="true" />
				<AlertTitle className="flex flex-wrap items-center gap-x-3 gap-y-1">
					Last scan failed
					{scan.branch ? (
						<ScanBranchTag branch={scan.branch} />
					) : null}
					{failedAt && (
						<time
							dateTime={failedAt.toISOString()}
							title={failedAt.toLocaleString()}
							className="font-normal text-muted-foreground text-xs"
						>
							{formatDistanceToNow(failedAt, { addSuffix: true })}
						</time>
					)}
					{actor && (
						<span className="font-normal text-muted-foreground text-xs">
							by {actor}
						</span>
					)}
				</AlertTitle>
				<AlertDescription>
					<p className="text-foreground">
						{reason ||
							"The scan couldn't be completed. Please try again — if it keeps failing, contact support."}
					</p>
					<Button
						variant="outline"
						size="sm"
						onClick={onRetry}
						disabled={retryDisabled}
						className="mt-3 gap-2 text-foreground"
					>
						{retrying ? (
							<Loader2Icon
								aria-hidden="true"
								className="size-4 motion-safe:animate-spin"
							/>
						) : (
							<RefreshCwIcon
								aria-hidden="true"
								className="size-4"
							/>
						)}
						Try again
					</Button>
				</AlertDescription>
			</Alert>
		);
	}

	const when = toDate(scan.completedAt) ?? toDate(scan.createdAt);
	const total = scan.securityFindingCount + scan.accessibilityFindingCount;
	const durationSeconds =
		scan.durationMs != null ? Math.round(scan.durationMs / 100) / 10 : null;
	const actor = scanActorName(scan);

	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
			<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
				Last scan
			</span>
			<Badge variant={SCAN_STATUS_BADGE_VARIANT[scan.status]}>
				{SCAN_STATUS_LABEL[scan.status]}
			</Badge>
			{scan.branch ? <ScanBranchTag branch={scan.branch} /> : null}
			{when && (
				<time
					dateTime={when.toISOString()}
					title={when.toLocaleString()}
					className="text-muted-foreground"
				>
					{formatDistanceToNow(when, { addSuffix: true })}
				</time>
			)}
			{actor && (
				<span className="text-muted-foreground text-xs">
					by {actor}
				</span>
			)}
			<span className="text-muted-foreground">
				{total} {total === 1 ? "finding" : "findings"}
				<span className="ml-1 text-muted-foreground/70">
					({scan.securityFindingCount} security,{" "}
					{scan.accessibilityFindingCount} accessibility)
				</span>
			</span>
			{/* Model name intentionally lives in History, not this summary. */}
			{durationSeconds != null && (
				<span className="text-muted-foreground text-xs">
					{durationSeconds}s
				</span>
			)}
		</div>
	);
}
