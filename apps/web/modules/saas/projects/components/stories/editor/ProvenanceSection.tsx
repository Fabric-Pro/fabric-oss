"use client";

import { formatLastEditSource } from "../../../lib/last-edit-source-copy";
import type { UserStory } from "../../../lib/stories/types";
import {
	getValidExternalUrl,
	ViewInPmToolLink,
} from "../pm-sync/ViewInPmToolLink";
import { SourceChip } from "../SourceChip";

// types.ts does NOT export ReporterSource — inline the union literal.
const REPORTER_LABEL: Record<"SLACK" | "TEAMS" | "MANUAL", string> = {
	SLACK: "Slack",
	TEAMS: "Teams",
	MANUAL: "manual entry",
};

function formatDate(value: Date | string): string {
	const d = typeof value === "string" ? new Date(value) : value;
	return d.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

type Props = {
	story: UserStory;
	creatorName?: string | null;
	creatorEmail?: string | null;
	pmToolName?: string | null;
	isMetaLoading?: boolean;
};

/** Read-only provenance block for the Details tab — created/modified, creator,
 * source, original proposer, PM deep link, version. All data is already on the
 * story prop except creatorName/email (resolved by the shell from
 * projects.members.list). Tokens only; no hardcoded colors. */
export function ProvenanceSection({
	story,
	creatorName,
	creatorEmail,
	pmToolName,
	isMetaLoading,
}: Props) {
	const creatorUnresolved = !creatorName && !creatorEmail;
	const creatorDisplay = creatorName ?? creatorEmail ?? "Unknown user";
	const pmHref = getValidExternalUrl(story.externalUrl);

	return (
		<section className="space-y-3">
			<p className="app-editorial-label">Details</p>
			<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
				<dt className="text-muted-foreground">Created</dt>
				<dd className="flex items-center gap-1.5">
					<span>{formatDate(story.createdAt)}</span>
					<span className="text-muted-foreground">by</span>
					{isMetaLoading && creatorUnresolved ? (
						<span
							data-testid="creator-skeleton"
							className="inline-block h-3 w-20 animate-pulse rounded bg-muted"
						/>
					) : (
						<span>{creatorDisplay}</span>
					)}
				</dd>

				<dt className="text-muted-foreground">Modified</dt>
				<dd>
					{story.lastEditedAt ? (
						<>
							{formatDate(story.lastEditedAt)}
							{story.lastEditedByName ? (
								<span className="text-muted-foreground">
									{" "}
									by {story.lastEditedByName}
								</span>
							) : null}
							<span className="text-muted-foreground">
								{" · "}
								{formatLastEditSource(
									story.lastEditedSource,
									pmToolName ?? null,
								)}
							</span>
						</>
					) : (
						<span className="text-muted-foreground">
							Not recorded
						</span>
					)}
				</dd>

				<dt className="text-muted-foreground">Source</dt>
				<dd>
					<SourceChip source={story.source} className="text-xs" />
				</dd>

				{story.reporterName ? (
					<>
						<dt className="text-muted-foreground">Proposed</dt>
						<dd>
							{story.reporterSourceUrl ? (
								<>
									Originally proposed by{" "}
									<a
										href={story.reporterSourceUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="underline hover:text-foreground"
									>
										{story.reporterName}
									</a>{" "}
									via{" "}
									{story.reporterSource
										? REPORTER_LABEL[story.reporterSource]
										: "an external source"}
								</>
							) : (
								<span>
									Originally proposed by {story.reporterName}{" "}
									via{" "}
									{story.reporterSource
										? REPORTER_LABEL[story.reporterSource]
										: "an external source"}
								</span>
							)}
						</dd>
					</>
				) : null}

				{pmHref ? (
					<>
						<dt className="text-muted-foreground">PM ticket</dt>
						<dd>
							<ViewInPmToolLink
								externalUrl={story.externalUrl}
								pmTool={pmToolName}
							/>
						</dd>
					</>
				) : null}

				{story.sourceMeeting ? (
					<>
						<dt className="text-muted-foreground">From meeting</dt>
						<dd>
							{story.sourceMeeting.subject ?? "Untitled meeting"}
							{story.sourceMeeting.meetingDate ? (
								<span className="text-muted-foreground">
									{" "}
									·{" "}
									{formatDate(
										story.sourceMeeting.meetingDate,
									)}
								</span>
							) : null}
						</dd>
					</>
				) : null}

				<dt className="text-muted-foreground">Version</dt>
				<dd>{story.version}</dd>
			</dl>
		</section>
	);
}
