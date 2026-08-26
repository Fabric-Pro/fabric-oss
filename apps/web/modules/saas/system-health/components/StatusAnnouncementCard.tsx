"use client";

/**
 * One customer-facing status announcement with its progression timeline.
 *
 * The timeline is the load-bearing part: a status page showing "Investigating"
 * from three hours ago with no visible progression is the most common way these
 * surfaces lose a customer's trust.
 */

import type { StatusUpdateImpact, StatusUpdateLifecycle } from "@repo/database";
import { Card } from "@ui/components/card";
import { cn } from "@ui/lib";
import { formatUtc } from "../lib/format-utc";

/**
 * Aliased to the generated Prisma enum types rather than re-declared, so adding a
 * variant to the schema breaks the label/tone maps below instead of leaving them
 * silently short. `import type` is erased at build time, so this costs the client
 * bundle nothing.
 */
type StatusLifecycle = StatusUpdateLifecycle;
type StatusImpact = StatusUpdateImpact;

export interface StatusAnnouncement {
	id: string;
	title: string;
	body: string;
	lifecycle: StatusLifecycle;
	impact: StatusImpact;
	startedAt: string | Date;
	resolvedAt: string | Date | null;
	scheduledFor: string | Date | null;
	revisions: {
		id: string;
		lifecycle: StatusLifecycle;
		body: string;
		createdAt: string | Date;
	}[];
}

const LIFECYCLE_LABEL: Record<StatusLifecycle, string> = {
	INVESTIGATING: "Investigating",
	IDENTIFIED: "Identified",
	MONITORING: "Monitoring",
	RESOLVED: "Resolved",
	SCHEDULED: "Scheduled",
	IN_PROGRESS: "In progress",
	COMPLETED: "Completed",
};

// Solid fills for the impact pills, same reasoning and same measured AA
// failures as `HealthStatusBadge` — coloured text on a 10% tint of itself came
// out at 2.83:1 (highlight, light) and 4.19:1 (destructive, dark).
const IMPACT_TONE: Record<StatusImpact, string> = {
	NONE: "border-border/60 bg-muted text-muted-foreground",
	MINOR: "border-highlight bg-highlight text-highlight-foreground",
	MAJOR: "border-highlight bg-highlight text-highlight-foreground",
	CRITICAL: "border-destructive bg-destructive text-destructive-foreground",
};

const IMPACT_LABEL: Record<StatusImpact, string> = {
	NONE: "Informational",
	MINOR: "Minor impact",
	MAJOR: "Major impact",
	CRITICAL: "Critical impact",
};

export function StatusAnnouncementCard({
	announcement,
}: {
	announcement: StatusAnnouncement;
}) {
	const isScheduled =
		announcement.lifecycle === "SCHEDULED" && announcement.scheduledFor;

	return (
		<Card className="border-border/60 bg-card p-5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="font-medium text-base text-foreground">
						{announcement.title}
					</h3>
					<p className="mt-1 text-muted-foreground text-xs">
						{isScheduled && announcement.scheduledFor
							? `Scheduled for ${formatUtc(announcement.scheduledFor)}`
							: `Started ${formatUtc(announcement.startedAt)}`}
						{announcement.resolvedAt
							? ` · Resolved ${formatUtc(announcement.resolvedAt)}`
							: ""}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<span
						className={cn(
							"inline-flex items-center rounded-full border px-2.5 py-0.5 font-medium text-xs",
							IMPACT_TONE[announcement.impact],
						)}
					>
						{IMPACT_LABEL[announcement.impact]}
					</span>
					<span className="inline-flex items-center rounded-full border border-border/60 bg-muted px-2.5 py-0.5 font-medium text-muted-foreground text-xs">
						{LIFECYCLE_LABEL[announcement.lifecycle]}
					</span>
				</div>
			</div>

			<p className="mt-3 whitespace-pre-line text-foreground/90 text-sm">
				{announcement.body}
			</p>

			{announcement.revisions.length > 1 && (
				<ol className="mt-4 space-y-3 border-border/60 border-l pl-4">
					{announcement.revisions.map((revision) => (
						<li key={revision.id} className="relative">
							<span
								aria-hidden="true"
								className="absolute top-1.5 left-[-1.3125rem] size-1.5 rounded-full bg-border"
							/>
							<p className="font-medium text-foreground text-xs">
								{LIFECYCLE_LABEL[revision.lifecycle]}
								<span className="ml-2 font-normal text-muted-foreground">
									{formatUtc(revision.createdAt)}
								</span>
							</p>
							<p className="mt-0.5 whitespace-pre-line text-muted-foreground text-xs">
								{revision.body}
							</p>
						</li>
					))}
				</ol>
			)}
		</Card>
	);
}
