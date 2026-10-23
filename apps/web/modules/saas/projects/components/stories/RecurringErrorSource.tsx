"use client";

/**
 * Inbox rendering for proposals filed by the recurring-error scan
 * (`LOG_MONITOR`, `INCIDENT_CLUSTER`): the compact source badge on the row, and
 * the evidence panel in the detail view. Kept out of the inbox component so
 * the two sources' shape lives in one place.
 *
 * Reads only `sourceMetadata.recurringError` (written by the scan, already
 * redacted) and `sourceMetadata.transcript` (the rendered evidence). Anything
 * missing or malformed renders as absent rather than throwing.
 */

import { ActivityIcon, FileTextIcon, LayersIcon } from "lucide-react";

const RECURRING_ERROR_SOURCES = ["LOG_MONITOR", "INCIDENT_CLUSTER"];

export function isRecurringErrorSource(source: string): boolean {
	return RECURRING_ERROR_SOURCES.includes(source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function formatWhen(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? null
		: date.toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
}

export function RecurringErrorSourceBadge({
	source,
	sourceMetadata,
}: {
	source: string;
	sourceMetadata: Record<string, unknown> | null;
}) {
	const evidence = record(sourceMetadata?.recurringError);
	if (source === "LOG_MONITOR") {
		const occurrences = evidence?.occurrences;
		const windowHours = evidence?.windowHours;
		return (
			<span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
				<ActivityIcon className="size-3" aria-hidden="true" />
				{typeof occurrences === "number" &&
				typeof windowHours === "number"
					? `Recurring error · ${occurrences}× in ${windowHours}h`
					: "Recurring error"}
			</span>
		);
	}
	if (source === "INCIDENT_CLUSTER") {
		const count = Array.isArray(evidence?.stories)
			? evidence.stories.length
			: null;
		return (
			<span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
				<LayersIcon className="size-3" aria-hidden="true" />
				{count ? `${count} related bug reports` : "Related bug reports"}
			</span>
		);
	}
	return null;
}

export function RecurringErrorSourcePanel({
	source,
	sourceMetadata,
}: {
	source: string;
	sourceMetadata: Record<string, unknown> | null;
}) {
	if (!isRecurringErrorSource(source)) {
		return null;
	}
	const evidence = record(sourceMetadata?.recurringError);
	const transcript =
		typeof sourceMetadata?.transcript === "string" &&
		sourceMetadata.transcript.trim()
			? sourceMetadata.transcript
			: null;
	const isLogs = source === "LOG_MONITOR";
	const components = stringList(evidence?.components);
	const firstSeen = formatWhen(evidence?.firstSeen);
	const lastSeen = formatWhen(evidence?.lastSeen);
	const stories = Array.isArray(evidence?.stories)
		? evidence.stories.flatMap((story) => {
				const row = record(story);
				return typeof row?.identifier === "string"
					? [
							{
								identifier: row.identifier,
								title:
									typeof row.title === "string"
										? row.title
										: "",
							},
						]
					: [];
			})
		: [];

	return (
		<div className="space-y-1 rounded-lg border border-foreground/10 bg-muted/40 p-3 text-sm">
			<div className="flex flex-wrap items-center gap-2">
				{isLogs ? (
					<ActivityIcon
						className="size-3.5 text-muted-foreground"
						aria-hidden="true"
					/>
				) : (
					<LayersIcon
						className="size-3.5 text-muted-foreground"
						aria-hidden="true"
					/>
				)}
				<span className="font-medium text-foreground">
					{isLogs
						? "Detected from recurring application errors"
						: "Consolidates related open bug reports"}
				</span>
			</div>
			{isLogs && evidence && (
				<p className="text-xs text-muted-foreground">
					{typeof evidence.occurrences === "number" &&
						typeof evidence.windowHours === "number" &&
						`${evidence.occurrences} occurrences in ${evidence.windowHours} hours`}
					{components.length > 0 && ` · ${components.join(", ")}`}
					{typeof evidence.affectedUsers === "number" &&
						evidence.affectedUsers > 0 &&
						` · ${evidence.affectedUsers} users`}
					{firstSeen && ` · first seen ${firstSeen}`}
					{lastSeen && ` · last seen ${lastSeen}`}
				</p>
			)}
			{!isLogs && stories.length > 0 && (
				<ul className="space-y-0.5 text-xs text-muted-foreground">
					{stories.map((story) => (
						<li key={story.identifier}>
							<span className="font-medium text-foreground">
								{story.identifier}
							</span>{" "}
							{story.title}
						</li>
					))}
				</ul>
			)}
			{transcript && (
				<details className="mt-2">
					<summary className="inline-flex min-h-6 cursor-pointer items-center gap-1.5 text-xs text-primary hover:underline">
						<FileTextIcon className="size-3" aria-hidden="true" />
						See evidence
					</summary>
					<pre className="mt-2 max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap rounded-md border border-foreground/10 bg-background p-2 text-xs text-foreground/80">
						{transcript}
					</pre>
				</details>
			)}
		</div>
	);
}
