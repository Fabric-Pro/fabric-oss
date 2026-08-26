"use client";

/**
 * AuditLogMetadataDrawer
 *
 * Side sheet that renders the full row when one is selected. The drawer
 * is the place where forensic detail lives — every field the row carries
 * is laid out under a humanized title, the correlation ID is offered as
 * a first-class affordance with a click-to-trace button, and exception
 * metadata (when present) gets its own collapsible section with a
 * cleaned stack trace and cause chain.
 *
 * Spec: docs/audit-log/README.md §8.2,
 * §8.5 (focus trap / Esc handled by `<Sheet>` from Radix).
 */

import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
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
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	CheckCircle2,
	ChevronDown,
	ClipboardIcon,
	GitBranch,
	XCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import {
	describeAction,
	resolveActionLabel,
	resourceIcon,
} from "./action-catalog";
import { SeverityBadge } from "./SeverityBadge";
import type { AuditLogFiltersState } from "./types";
import { filtersStateToApi } from "./types";

interface ExceptionMetadata {
	type?: string;
	message?: string;
	stacktrace?: unknown;
	escaped?: boolean;
	cause?: ExceptionMetadata;
}

interface AuditLogMetadataDrawerProps {
	organizationId: string | null;
	filters: AuditLogFiltersState;
	selectedRowId: string | null;
	viewerTimezone: string;
	onClose: () => void;
	onTraceCorrelation?: (correlationId: string) => void;
	/**
	 * Override for the React-Query cache walk that locates the selected
	 * row. Defaults to `["audit-log", organizationId]` (the in-product
	 * viewer's namespace). The admin "Audit Log Explorer" passes its own
	 * prefix so the drawer can find rows fetched through the staff proxy.
	 */
	cacheKeyPrefix?: readonly unknown[];
}

type AuditListResultPage = {
	items: Array<{
		id: string;
		organizationId: string | null;
		userId: string | null;
		actorType: string;
		actorEmailSnapshot: string | null;
		actorNameSnapshot: string | null;
		impersonatedById: string | null;
		action: string;
		category: string;
		severity: string;
		outcome: string;
		resourceType: string | null;
		resourceId: string | null;
		resourceName: string | null;
		projectId: string | null;
		ipAddress: string | null;
		userAgent: string | null;
		requestId: string | null;
		sessionId: string | null;
		metadata: unknown;
		createdAt: string | Date;
	}>;
};

function formatTimestamp(date: Date, timezone: string): string {
	try {
		return new Intl.DateTimeFormat(undefined, {
			timeZone: timezone,
			year: "numeric",
			month: "short",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		}).format(date);
	} catch {
		return date.toISOString();
	}
}

function DetailRow({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1">
			<div className="text-xs uppercase tracking-wider text-muted-foreground">
				{label}
			</div>
			<div className="text-sm text-foreground">{children}</div>
		</div>
	);
}

function CollapsibleSection({
	title,
	tone = "default",
	defaultOpen = false,
	children,
}: {
	title: string;
	tone?: "default" | "danger";
	defaultOpen?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Collapsible defaultOpen={defaultOpen}>
			<div
				className={cn(
					"flex flex-col rounded-md border bg-muted/30",
					tone === "danger"
						? "border-destructive/30 bg-destructive/5"
						: "border-border/60",
				)}
			>
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider"
					>
						<span
							className={cn(
								tone === "danger"
									? "text-destructive"
									: "text-muted-foreground",
							)}
						>
							{title}
						</span>
						<ChevronDown
							aria-hidden="true"
							className="size-4 text-muted-foreground transition-transform [&[data-state=open]]:rotate-180"
						/>
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="px-3 pb-3">{children}</div>
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
}

export function AuditLogMetadataDrawer({
	organizationId,
	filters,
	selectedRowId,
	viewerTimezone,
	onClose,
	onTraceCorrelation,
	cacheKeyPrefix,
}: AuditLogMetadataDrawerProps) {
	const t = useTranslations();
	const queryClient = useQueryClient();
	const queryFilter = filtersStateToApi(filters);

	const row = useMemo(() => {
		if (!selectedRowId) {
			return null;
		}
		// AuditLogTable's React-Query cache shape was switched in v2 from
		// `useInfiniteQuery` (`{ pages: [{ items: [...] }] }`) to a
		// page-based `useQuery` (`{ items: [...], nextCursor, totalCount }`).
		// Walk both shapes so the drawer continues to find the row no
		// matter which page it lives on, and so any straggling legacy
		// caches (e.g. another tab on an older bundle) still work.
		//
		// The explorer passes its own `cacheKeyPrefix` (e.g.
		// `["audit-log-explorer", tenantKey, baseUrl]`) so the drawer can
		// reuse the same render path for cross-tenant rows.
		const matches = queryClient.getQueriesData<unknown>({
			queryKey: cacheKeyPrefix ?? ["audit-log", organizationId],
		});
		for (const [, data] of matches) {
			if (!data || typeof data !== "object") {
				continue;
			}
			// New flat shape: { items, nextCursor, totalCount }
			const flatItems = (data as { items?: AuditListResultPage["items"] })
				.items;
			if (flatItems) {
				const match = flatItems.find(
					(item) => item.id === selectedRowId,
				);
				if (match) {
					return match;
				}
				continue;
			}
			// Legacy paged shape: { pages: [{ items: [...] }] }
			const pages = (data as { pages?: AuditListResultPage[] }).pages;
			if (!pages) {
				continue;
			}
			for (const page of pages) {
				const match = page.items.find(
					(item) => item.id === selectedRowId,
				);
				if (match) {
					return match;
				}
			}
		}
		return null;
	}, [selectedRowId, organizationId, queryClient, cacheKeyPrefix]);
	// queryFilter is consumed elsewhere (legacy key precompute); the
	// `getQueriesData` lookup above no longer depends on it.
	void queryFilter;

	const isOpen = selectedRowId !== null && row !== null;
	const created = row ? new Date(row.createdAt) : null;
	const iso = created ? created.toISOString() : null;
	const display = created ? formatTimestamp(created, viewerTimezone) : null;

	const metadata =
		row?.metadata && typeof row.metadata === "object"
			? (row.metadata as Record<string, unknown>)
			: null;
	const correlationId =
		metadata && typeof metadata.correlationId === "string"
			? (metadata.correlationId as string)
			: null;
	const fingerprint =
		metadata && typeof metadata.fingerprint === "string"
			? (metadata.fingerprint as string)
			: null;
	const exception: ExceptionMetadata | null =
		metadata && typeof metadata.exception === "object" && metadata.exception
			? (metadata.exception as ExceptionMetadata)
			: null;
	const cause: ExceptionMetadata | null =
		metadata && typeof metadata.cause === "object" && metadata.cause
			? (metadata.cause as ExceptionMetadata)
			: null;
	const requestInput =
		metadata && metadata.input !== undefined ? metadata.input : null;

	const [copied, setCopied] = useState<"correlation" | "fingerprint" | null>(
		null,
	);
	const copy = useCallback(
		async (value: string, kind: "correlation" | "fingerprint") => {
			try {
				await navigator.clipboard.writeText(value);
				setCopied(kind);
				window.setTimeout(() => setCopied(null), 1500);
			} catch {
				// no-op: clipboard unavailable
			}
		},
		[],
	);

	const descriptor = row ? describeAction(row.action) : null;
	const ActionIcon = descriptor?.icon ?? null;
	const ResourceIcon = row ? resourceIcon(row.resourceType) : null;
	const isFailure = row?.outcome === "failure";

	const actionLabel: string = descriptor
		? resolveActionLabel(t as (key: string) => string, descriptor)
		: "";

	return (
		<Sheet
			open={isOpen}
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<SheetContent className="flex w-full max-w-xl flex-col overflow-y-auto sm:max-w-xl">
				<SheetHeader>
					<SheetTitle className="flex items-start gap-3">
						{ActionIcon ? (
							<ActionIcon
								aria-hidden="true"
								className="mt-1 size-5 text-muted-foreground"
							/>
						) : null}
						<span>
							{actionLabel ||
								t("settings.auditLog.metadataDrawer.title")}
						</span>
					</SheetTitle>
					{row ? (
						<SheetDescription className="flex flex-wrap items-center gap-2 text-xs">
							<SeverityBadge severity={row.severity} />
							<span
								className={cn(
									"inline-flex items-center gap-1.5",
									isFailure
										? "text-destructive"
										: "text-secondary",
								)}
							>
								{isFailure ? (
									<XCircle
										aria-hidden="true"
										className="size-3.5"
									/>
								) : (
									<CheckCircle2
										aria-hidden="true"
										className="size-3.5"
									/>
								)}
								{isFailure
									? t("settings.auditLog.outcomes.failure")
									: t("settings.auditLog.outcomes.success")}
							</span>
							<code className="font-mono text-[11px] text-muted-foreground">
								{row.action}
							</code>
						</SheetDescription>
					) : null}
				</SheetHeader>
				{row ? (
					<div className="mt-4 flex flex-col gap-4 text-sm">
						{correlationId ? (
							<div className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/30 p-3">
								<div className="text-xs uppercase tracking-wider text-muted-foreground">
									{t(
										"settings.auditLog.metadataDrawer.correlationId",
									)}
								</div>
								{/* Stack the monospace ID above the action
								 * buttons so the long CUID never pushes the
								 * buttons onto a wrap line in narrow drawers. */}
								<code className="break-all rounded bg-background/80 px-2 py-1 font-mono text-xs text-foreground">
									{correlationId}
								</code>
								<div className="flex flex-wrap items-center gap-2">
									<Button
										variant="ghost"
										size="sm"
										onClick={() =>
											copy(correlationId, "correlation")
										}
										aria-label={t(
											"settings.auditLog.metadataDrawer.copyCorrelation",
										)}
										title={t(
											"settings.auditLog.metadataDrawer.copyCorrelationHint",
										)}
									>
										<ClipboardIcon className="size-3.5" />
										<span className="ml-1">
											{copied === "correlation"
												? t(
														"settings.auditLog.metadataDrawer.copied",
													)
												: t(
														"settings.auditLog.metadataDrawer.copyCorrelation",
													)}
										</span>
									</Button>
									{onTraceCorrelation ? (
										<TooltipProvider>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="outline"
														size="sm"
														data-testid="audit-trace-flow"
														onClick={() =>
															onTraceCorrelation(
																correlationId,
															)
														}
													>
														<GitBranch className="size-3.5" />
														<span className="ml-1">
															{t(
																"settings.auditLog.metadataDrawer.traceFlow",
															)}
														</span>
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													{t(
														"settings.auditLog.tooltips.traceFlow",
													)}
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>
									) : null}
								</div>
								<p className="text-xs text-muted-foreground">
									{t(
										"settings.auditLog.metadataDrawer.correlationHint",
									)}
								</p>
							</div>
						) : null}

						<DetailRow
							label={t("settings.auditLog.columns.timestamp")}
						>
							<div className="flex flex-col">
								<span className="font-mono">{display}</span>
								{iso ? (
									<span className="font-mono text-xs text-muted-foreground">
										{t(
											"settings.auditLog.metadataDrawer.utcTooltip",
											{ iso },
										)}
									</span>
								) : null}
							</div>
						</DetailRow>

						<DetailRow
							label={t("settings.auditLog.metadataDrawer.actor")}
						>
							<div className="flex flex-col gap-1">
								<span>
									{row.actorEmailSnapshot ??
										t("settings.auditLog.badges.system")}
								</span>
								{row.impersonatedById ? (
									<Badge
										variant="outline"
										className="w-fit text-[10px] uppercase tracking-wider text-highlight"
									>
										{t(
											"settings.auditLog.badges.impersonation",
										)}
									</Badge>
								) : null}
							</div>
						</DetailRow>

						<DetailRow
							label={t(
								"settings.auditLog.metadataDrawer.resource",
							)}
						>
							<div className="flex flex-col gap-1">
								<div className="flex items-center gap-2">
									{ResourceIcon ? (
										<ResourceIcon
											aria-hidden="true"
											className="size-4 text-muted-foreground"
										/>
									) : null}
									<span>
										{row.resourceName ??
											row.resourceType ??
											"—"}
									</span>
								</div>
								{row.resourceId ? (
									<code className="font-mono text-xs text-muted-foreground">
										{row.resourceId}
									</code>
								) : null}
								{row.resourceName && !row.resourceId ? (
									<Badge
										variant="outline"
										className="w-fit text-[10px] uppercase tracking-wider text-muted-foreground"
									>
										{t(
											"settings.auditLog.badges.deletedResource",
										)}
									</Badge>
								) : null}
							</div>
						</DetailRow>

						{row.ipAddress ? (
							<DetailRow
								label={t("settings.auditLog.metadataDrawer.ip")}
							>
								<code className="font-mono text-xs text-foreground">
									{row.ipAddress}
								</code>
							</DetailRow>
						) : null}

						{row.userAgent ? (
							<DetailRow
								label={t(
									"settings.auditLog.metadataDrawer.userAgent",
								)}
							>
								<code className="break-all font-mono text-xs text-foreground">
									{row.userAgent.length > 200
										? `${row.userAgent.slice(0, 200)}…`
										: row.userAgent}
								</code>
							</DetailRow>
						) : null}

						{requestInput !== null ? (
							<CollapsibleSection
								title={t(
									"settings.auditLog.metadataDrawer.requestInput",
								)}
							>
								<pre className="max-h-64 overflow-y-auto rounded border border-border/60 bg-card p-2 font-mono text-[11px] text-foreground">
									{JSON.stringify(requestInput, null, 2)}
								</pre>
							</CollapsibleSection>
						) : null}

						{exception ? (
							<CollapsibleSection
								title={t(
									"settings.auditLog.metadataDrawer.exception.title",
								)}
								tone="danger"
								defaultOpen
							>
								<div className="flex flex-col gap-2 text-xs">
									{exception.type ? (
										<div>
											<span className="text-muted-foreground">
												{t(
													"settings.auditLog.metadataDrawer.exception.type",
												)}
												:{" "}
											</span>
											<code className="font-mono text-foreground">
												{exception.type}
											</code>
										</div>
									) : null}
									{exception.message ? (
										<div className="text-foreground">
											{exception.message}
										</div>
									) : null}
									{fingerprint ? (
										<div className="flex items-center gap-2 text-xs">
											<span className="text-muted-foreground">
												{t(
													"settings.auditLog.metadataDrawer.exception.fingerprint",
												)}
												:
											</span>
											<code className="font-mono text-foreground">
												{fingerprint}
											</code>
											<Button
												variant="ghost"
												size="sm"
												onClick={() =>
													copy(
														fingerprint,
														"fingerprint",
													)
												}
												aria-label={t(
													"settings.auditLog.metadataDrawer.exception.copyFingerprint",
												)}
											>
												<ClipboardIcon className="size-3.5" />
											</Button>
										</div>
									) : null}
								</div>
								{Array.isArray(exception.stacktrace) &&
								exception.stacktrace.length > 0 ? (
									<details className="mt-2">
										<summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
											{t(
												"settings.auditLog.metadataDrawer.exception.stacktrace",
											)}
										</summary>
										<pre className="mt-2 max-h-64 overflow-y-auto rounded border border-border/60 bg-muted/50 p-2 font-mono text-[11px] text-foreground">
											{(
												exception.stacktrace as string[]
											).join("\n")}
										</pre>
									</details>
								) : null}
								{cause ? (
									<details className="mt-2">
										<summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
											{t(
												"settings.auditLog.metadataDrawer.exception.cause",
											)}
										</summary>
										<pre className="mt-2 max-h-64 overflow-y-auto rounded border border-border/60 bg-muted/50 p-2 font-mono text-[11px] text-foreground">
											{JSON.stringify(cause, null, 2)}
										</pre>
									</details>
								) : null}
							</CollapsibleSection>
						) : null}

						<CollapsibleSection
							title={t(
								"settings.auditLog.metadataDrawer.rawMetadata",
							)}
						>
							{row.metadata ? (
								<pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/50 p-3 font-mono text-xs text-foreground">
									{JSON.stringify(row.metadata, null, 2)}
								</pre>
							) : (
								<div className="text-muted-foreground">
									{t(
										"settings.auditLog.metadataDrawer.noMetadata",
									)}
								</div>
							)}
						</CollapsibleSection>

						<p className="mt-2 text-[11px] text-muted-foreground">
							{t("settings.auditLog.metadataDrawer.keyboardHelp")}
						</p>
					</div>
				) : null}
			</SheetContent>
		</Sheet>
	);
}
