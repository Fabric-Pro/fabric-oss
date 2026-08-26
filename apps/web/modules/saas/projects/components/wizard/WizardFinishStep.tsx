"use client";

/**
 * WizardFinishStep — post-create "finish setup" step (unified-project-setup
 * spec §4.6, D4; tasks TG4 §4.2).
 *
 * Rendered as the in-wizard terminal step AFTER `projects.create` resolves and
 * the project is real. It:
 *   - confirms what was set up (brief always; optional backlog / repo when
 *     connected) with links to the project and its settings;
 *   - hosts meeting-transcript linking against the REAL `projectId` by reusing
 *     `MeetingTranscriptSyncSettings` (which composes `LinkedMeetingSelector`) —
 *     no reinvention. This sidesteps the real-`projectId` requirement that kept
 *     transcripts out of the pre-create wizard;
 *   - offers a clear "Go to project" primary action. Transcripts are optional
 *     and skippable (AC#1 intent) — the user can click "Go to project" without
 *     linking anything.
 *
 * a11y (§7): a single step-level heading (`h2`; the wizard owns the page `h1`)
 * receives focus on mount so keyboard/SR users land on the step, not a toast.
 * The summary links and primary action are plain-English, multi-word, and
 * non-destructive, so they need no tooltip (per `frontend/tooltips.md`).
 * Visuals use design tokens only (`frontend/css.md`).
 */

import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	ArrowRightIcon,
	CheckIcon,
	FileTextIcon,
	GitBranchIcon,
	Link2Icon,
	SettingsIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { MeetingTranscriptSyncSettings } from "../MeetingTranscriptSyncSettings";

/**
 * Minimal project shape required by the reused transcript settings card. A
 * freshly created project has these unset, which the card renders as its empty
 * "no meetings linked" state — exactly what we want on the finish step.
 */
type FinishStepProject = {
	meetingTranscriptSyncEnabled?: boolean;
	meetingTranscriptSyncIntervalMin?: number | null;
	meetingTranscriptSyncLastRun?: Date | string | null;
};

interface WizardFinishStepProps {
	projectId: string;
	organizationId: string | null;
	/** Base path for the active tenant (e.g. `/app` or `/app/{slug}`). */
	projectsBasePath: string;
	projectName: string;
	/** True when the user connected a backlog (PM tool) in the wizard. */
	hasBacklogConnected: boolean;
	/** Human-readable board/container name for the connected backlog, if any. */
	backlogContainerName?: string | null;
	/** True when the user connected at least one code repository. */
	hasRepoConnected: boolean;
	/** Number of connected repositories (for the summary copy). */
	repoCount: number;
	/** Navigate to the project page (primary action / skip). */
	onGoToProject: () => void;
}

function SummaryRow({
	icon,
	title,
	detail,
}: {
	icon: React.ReactNode;
	title: string;
	detail: string;
}) {
	return (
		<li className="flex items-start gap-3">
			<span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
				{icon}
			</span>
			<span className="min-w-0">
				<span className="flex items-center gap-1.5 font-medium text-foreground">
					<CheckIcon aria-hidden className="h-4 w-4 text-secondary" />
					{title}
				</span>
				<span className="mt-0.5 block text-sm text-muted-foreground">
					{detail}
				</span>
			</span>
		</li>
	);
}

export function WizardFinishStep({
	projectId,
	organizationId,
	projectsBasePath,
	projectName,
	hasBacklogConnected,
	backlogContainerName,
	hasRepoConnected,
	repoCount,
	onGoToProject,
}: WizardFinishStepProps) {
	const headingRef = useRef<HTMLHeadingElement | null>(null);
	const projectHref = `${projectsBasePath}/${projectId}`;
	// Project Settings is an in-page tab on the project route, not a route of
	// its own — `/projects/:id/settings` 404s. `?tab=settings` is the supported
	// deep link (same one the PM-credentials and Kanban CTAs use).
	const settingsHref = `${projectHref}?tab=settings`;

	// Move focus to the step heading on entry (§7) so keyboard / screen-reader
	// users land on the finish step rather than wherever focus was on the
	// Create button. Toasts (fired by the wizard onSuccess) must not steal
	// focus — sonner toasts are non-modal and do not, so this is sufficient.
	useEffect(() => {
		headingRef.current?.focus();
	}, []);

	// The reused transcript card expects a `project` with the sync fields; a
	// brand-new project has them unset, which renders the card's empty state.
	const project: FinishStepProject = {};

	return (
		<div className="space-y-8">
			<div>
				<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
					Finish setup
				</p>
				<h2
					ref={headingRef}
					tabIndex={-1}
					className="mt-2 text-2xl font-semibold tracking-tight focus:outline-none"
				>
					{projectName.trim()
						? `${projectName.trim()} is ready`
						: "Your project is ready"}
				</h2>
				<p className="mt-2 text-sm leading-6 text-muted-foreground">
					Here's what was set up. You can link meeting transcripts now
					or skip straight to your project — everything below is also
					available later in project settings.
				</p>
			</div>

			{/* What was set up */}
			<Card className="rounded-2xl border border-border bg-card p-6">
				<h3 className="mb-4 text-sm font-medium text-foreground">
					What was set up
				</h3>
				<ul className="space-y-4">
					<SummaryRow
						icon={<FileTextIcon className="h-4 w-4" />}
						title="Project brief"
						detail="Your brief and project shape are saved and ready for document generation."
					/>
					{hasBacklogConnected && (
						<SummaryRow
							icon={<Link2Icon className="h-4 w-4" />}
							title="Backlog connected"
							detail={
								backlogContainerName
									? `Synced from ${backlogContainerName}. It appears in your project's context list and settings.`
									: "Your backlog appears in the project's context list and settings."
							}
						/>
					)}
					{hasRepoConnected && (
						<SummaryRow
							icon={<GitBranchIcon className="h-4 w-4" />}
							title={
								repoCount > 1
									? `${repoCount} repositories connected`
									: "Code repository connected"
							}
							detail="Fabric is analyzing your code to generate documentation."
						/>
					)}
				</ul>

				<div className="mt-5 flex flex-wrap items-center gap-4 border-t border-border pt-4 text-sm">
					<Link
						href={projectHref}
						className="font-medium text-primary underline-offset-4 hover:underline"
					>
						View project
					</Link>
					<Link
						href={settingsHref}
						className="flex items-center gap-1.5 font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
					>
						<SettingsIcon aria-hidden className="h-3.5 w-3.5" />
						Project settings
					</Link>
				</div>
			</Card>

			{/* Optional: link meeting transcripts against the real projectId. */}
			<div className="space-y-3">
				<div>
					<h3 className="text-sm font-medium text-foreground">
						Link meeting transcripts
						<span className="ml-2 font-normal text-muted-foreground">
							Optional
						</span>
					</h3>
					<p className="mt-0.5 text-sm text-muted-foreground">
						Link recurring Teams meetings to automatically sync
						their transcripts as project context. You can skip this
						and add meetings anytime from settings.
					</p>
				</div>
				<MeetingTranscriptSyncSettings
					projectId={projectId}
					organizationId={organizationId}
					project={project}
				/>
			</div>

			{/* Primary action / skip. */}
			<div className="flex justify-end">
				<Button
					onClick={onGoToProject}
					size="lg"
					className="gap-2"
					data-testid="finish-go-to-project"
				>
					Go to project
					<ArrowRightIcon aria-hidden className="h-4 w-4" />
				</Button>
			</div>
		</div>
	);
}
