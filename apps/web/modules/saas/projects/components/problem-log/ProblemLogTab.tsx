"use client";

import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	EmptyState,
	EmptyStateDescription,
	EmptyStateIcon,
	EmptyStateTitle,
} from "@ui/components/empty-state";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	CATEGORY_LABEL,
	formatDateTime,
	type ProblemLogCategory,
	type ProblemLogSeverity,
	type ProblemLogStatus,
	SEVERITY_CONFIG,
	STATUS_LABEL,
} from "./constants";
import { IncidentReportDialog } from "./IncidentReportDialog";
import { ProblemLogDrafts } from "./ProblemLogDrafts";

const ALL = "all";

type Props = {
	projectId: string;
	/** Organization admins and project admins may resolve and reopen. */
	canManage: boolean;
};

/**
 * Problem Log (Fizzy #2277): user-impacting failures Fabric recorded for this
 * project, aggregated by error signature, with their resolution status.
 */
export function ProblemLogTab({ projectId, canManage }: Props) {
	const { organizationId } = useOrganizationContext();
	const [status, setStatus] = useState<ProblemLogStatus | typeof ALL>("OPEN");
	const [category, setCategory] = useState<ProblemLogCategory | typeof ALL>(
		ALL,
	);
	const [openId, setOpenId] = useState<string | null>(null);
	const [report, setReport] = useState<{ entryId?: string } | null>(null);

	const listQuery = useInfiniteQuery(
		orpc.problemLog.list.infiniteOptions({
			input: (cursor: string | undefined) => ({
				projectId,
				organizationId: organizationId ?? null,
				status: status === ALL ? undefined : status,
				category: category === ALL ? undefined : category,
				limit: 50,
				cursor,
			}),
			initialPageParam: undefined as string | undefined,
			getNextPageParam: (lastPage: {
				nextCursor: string | null;
			}): string | undefined => lastPage.nextCursor ?? undefined,
		}),
	);
	const items = useMemo(
		() => listQuery.data?.pages.flatMap((page) => page.items) ?? [],
		[listQuery.data],
	);

	return (
		<div className="space-y-4" data-onboarding-target="problem-log-list">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<div className="flex items-center gap-1.5">
						<h2 className="font-semibold text-lg">Problem Log</h2>
						<PageTourButton pageId="problem-log" />
					</div>
					<p className="text-muted-foreground text-sm">
						Failures Fabric recorded for this project — sync errors,
						failed jobs and deliveries, server errors and access
						denials — and confirmed issues, blockers and risks from
						its meetings. Repeats of the same problem are counted on
						one entry.
					</p>
				</div>
				<div className="flex gap-2">
					<Select
						value={status}
						onValueChange={(v) => setStatus(v as typeof status)}
					>
						<SelectTrigger className="w-36" aria-label="Status">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All statuses</SelectItem>
							<SelectItem value="OPEN">Open</SelectItem>
							<SelectItem value="RESOLVED">Resolved</SelectItem>
						</SelectContent>
					</Select>
					<Select
						value={category}
						onValueChange={(v) => setCategory(v as typeof category)}
					>
						<SelectTrigger className="w-52" aria-label="Category">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ALL}>All categories</SelectItem>
							{Object.entries(CATEGORY_LABEL).map(
								([value, label]) => (
									<SelectItem key={value} value={value}>
										{label}
									</SelectItem>
								),
							)}
						</SelectContent>
					</Select>
					<Button variant="outline" onClick={() => setReport({})}>
						Incident report
					</Button>
				</div>
			</div>

			{canManage && (
				<ProblemLogDrafts
					projectId={projectId}
					organizationId={organizationId ?? null}
				/>
			)}

			{listQuery.isPending ? (
				<div className="space-y-2">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : listQuery.isError ? (
				<p className="text-destructive text-sm">
					Could not load the Problem Log: {listQuery.error.message}
				</p>
			) : items.length === 0 ? (
				<EmptyState>
					<EmptyStateIcon>
						<TriangleAlertIcon />
					</EmptyStateIcon>
					<EmptyStateTitle>No problems recorded</EmptyStateTitle>
					<EmptyStateDescription>
						{status === "OPEN"
							? "Nothing is open. New failures appear here as they happen."
							: "No entries match these filters."}
					</EmptyStateDescription>
				</EmptyState>
			) : (
				<div className="overflow-x-auto rounded-lg border">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b bg-muted/40 text-left text-muted-foreground text-xs uppercase tracking-wide">
								<th className="px-3 py-2 font-medium">
									Severity
								</th>
								<th className="px-3 py-2 font-medium">
									Problem
								</th>
								<th className="hidden px-3 py-2 text-right font-medium md:table-cell">
									Occurrences
								</th>
								<th className="hidden px-3 py-2 font-medium md:table-cell">
									Last seen
								</th>
								<th className="px-3 py-2 font-medium">
									Status
								</th>
							</tr>
						</thead>
						<tbody>
							{items.map((entry) => (
								<tr
									key={entry.id}
									tabIndex={0}
									onClick={() => setOpenId(entry.id)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											setOpenId(entry.id);
										}
									}}
									className="cursor-pointer border-b transition-colors last:border-b-0 hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
								>
									<td className="px-3 py-2.5 align-top">
										<SeverityBadge
											severity={entry.severity}
										/>
									</td>
									<td className="max-w-[32rem] px-3 py-2.5 align-top">
										<div className="line-clamp-2 break-words font-medium">
											{entry.title}
										</div>
										<div className="text-muted-foreground text-xs">
											{CATEGORY_LABEL[entry.category]}
										</div>
									</td>
									<td className="hidden px-3 py-2.5 text-right align-top tabular-nums md:table-cell">
										{entry.occurrenceCount}
									</td>
									<td className="hidden px-3 py-2.5 align-top text-muted-foreground md:table-cell">
										{formatDateTime(entry.lastSeenAt)}
									</td>
									<td className="px-3 py-2.5 align-top">
										<StatusBadge status={entry.status} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			{listQuery.hasNextPage && (
				<Button
					variant="outline"
					onClick={() => listQuery.fetchNextPage()}
					loading={listQuery.isFetchingNextPage}
				>
					Load more
				</Button>
			)}

			<ProblemLogEntrySheet
				projectId={projectId}
				organizationId={organizationId ?? null}
				entryId={openId}
				canManage={canManage}
				onClose={() => setOpenId(null)}
				onReport={(entryId) => setReport({ entryId })}
			/>

			{report && (
				<IncidentReportDialog
					projectId={projectId}
					organizationId={organizationId ?? null}
					entryId={report.entryId}
					status={status === ALL ? undefined : status}
					category={category === ALL ? undefined : category}
					onClose={() => setReport(null)}
				/>
			)}
		</div>
	);
}

function ProblemLogEntrySheet({
	projectId,
	organizationId,
	entryId,
	canManage,
	onClose,
	onReport,
}: {
	projectId: string;
	organizationId: string | null;
	entryId: string | null;
	canManage: boolean;
	onClose: () => void;
	onReport: (entryId: string) => void;
}) {
	const queryClient = useQueryClient();
	const [note, setNote] = useState("");

	const detailQuery = useQuery({
		...orpc.problemLog.get.queryOptions({
			input: { projectId, organizationId, entryId: entryId ?? "" },
		}),
		enabled: entryId !== null,
	});

	const statusMutation = useMutation(
		orpc.problemLog.setStatus.mutationOptions({
			onSuccess: () => {
				setNote("");
				queryClient.invalidateQueries({
					queryKey: orpc.problemLog.key(),
				});
			},
			onError: (error) =>
				toast.error(`Could not change the status: ${error.message}`),
		}),
	);

	const entry = detailQuery.data?.entry;
	const history = detailQuery.data?.history ?? [];
	const affectedUser = detailQuery.data?.affectedUser ?? null;
	const nextStatus: ProblemLogStatus =
		entry?.status === "OPEN" ? "RESOLVED" : "OPEN";

	return (
		<Sheet
			open={entryId !== null}
			onOpenChange={(open) => !open && onClose()}
		>
			<SheetContent className="w-full overflow-y-auto sm:max-w-lg">
				{!entry ? (
					<div className="space-y-3 pt-8">
						<SheetTitle className="sr-only">
							Loading problem
						</SheetTitle>
						<Skeleton className="h-6 w-2/3" />
						<Skeleton className="h-20 w-full" />
					</div>
				) : (
					<>
						<SheetHeader>
							<SheetTitle className="break-words pr-6">
								{entry.title}
							</SheetTitle>
							<SheetDescription>
								{CATEGORY_LABEL[entry.category]}
							</SheetDescription>
						</SheetHeader>

						<div className="mt-4 flex flex-wrap gap-2">
							<SeverityBadge severity={entry.severity} />
							<StatusBadge status={entry.status} />
							<Button
								size="sm"
								variant="outline"
								className="ml-auto"
								onClick={() => {
									onClose();
									onReport(entry.id);
								}}
							>
								Incident report
							</Button>
						</div>

						{entry.description && (
							<p className="mt-4 whitespace-pre-wrap break-words text-sm">
								{entry.description}
							</p>
						)}

						{entry.sourceQuote && (
							<blockquote className="mt-4 border-l-2 pl-3 text-muted-foreground text-sm italic">
								“{entry.sourceQuote}”
							</blockquote>
						)}

						<dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
							<dt className="text-muted-foreground">Source</dt>
							<dd className="break-all font-mono text-xs">
								{entry.source}
							</dd>
							{affectedUser && (
								<>
									<dt className="text-muted-foreground">
										Affected user
									</dt>
									<dd className="break-words">
										{affectedUser}
									</dd>
								</>
							)}
							<dt className="text-muted-foreground">
								Occurrences
							</dt>
							<dd className="tabular-nums">
								{entry.occurrenceCount}
							</dd>
							<dt className="text-muted-foreground">
								First seen
							</dt>
							<dd>{formatDateTime(entry.firstSeenAt)}</dd>
							<dt className="text-muted-foreground">Last seen</dt>
							<dd>{formatDateTime(entry.lastSeenAt)}</dd>
							{entry.resolvedAt && (
								<>
									<dt className="text-muted-foreground">
										Resolved
									</dt>
									<dd>{formatDateTime(entry.resolvedAt)}</dd>
								</>
							)}
						</dl>

						{canManage && (
							<div className="mt-6 space-y-2">
								<Textarea
									value={note}
									onChange={(e) => setNote(e.target.value)}
									placeholder="Optional note (kept in the audit log)"
									aria-label="Status change note"
									maxLength={1000}
								/>
								<Button
									onClick={() =>
										statusMutation.mutate({
											projectId,
											organizationId,
											entryId: entry.id,
											status: nextStatus,
											note: note.trim() || undefined,
										})
									}
									loading={statusMutation.isPending}
								>
									{nextStatus === "RESOLVED"
										? "Mark resolved"
										: "Reopen"}
								</Button>
							</div>
						)}

						<section className="mt-6">
							<h3 className="font-medium text-sm">
								Status history
							</h3>
							{history.length === 0 ? (
								<p className="mt-1 text-muted-foreground text-sm">
									Open since it was first recorded.
								</p>
							) : (
								<ol className="mt-2 space-y-2 text-sm">
									{history.map((h) => (
										<li
											key={h.id}
											className="rounded-md border p-2"
										>
											<div>
												{h.previousStatus &&
													STATUS_LABEL[
														h.previousStatus
													]}{" "}
												→{" "}
												{h.newStatus &&
													STATUS_LABEL[h.newStatus]}
											</div>
											<div className="text-muted-foreground text-xs">
												{h.actorType === "system"
													? "Fabric (happened again)"
													: (h.actorName ??
														"A member")}{" "}
												· {formatDateTime(h.at)}
											</div>
											{h.note && (
												<p className="mt-1 whitespace-pre-wrap break-words">
													{h.note}
												</p>
											)}
										</li>
									))}
								</ol>
							)}
						</section>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}

function SeverityBadge({ severity }: { severity: ProblemLogSeverity }) {
	const cfg = SEVERITY_CONFIG[severity];
	return (
		<Badge variant="outline" className={cn("gap-1.5", cfg.className)}>
			{cfg.label}
		</Badge>
	);
}

function StatusBadge({ status }: { status: ProblemLogStatus }) {
	return (
		<Badge variant={status === "OPEN" ? "secondary" : "outline"}>
			{STATUS_LABEL[status]}
		</Badge>
	);
}
