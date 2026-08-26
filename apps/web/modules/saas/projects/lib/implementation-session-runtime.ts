type CodingRunStatus =
	| "QUEUED"
	| "STARTING"
	| "RUNNING"
	| "AWAITING_REVIEW"
	| "PR_OPENED"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "TERMINATED_STALE";

type ProviderMetadata = Record<string, unknown> | null;

const ACTIVE_STATUSES: CodingRunStatus[] = [
	"QUEUED",
	"STARTING",
	"RUNNING",
	"AWAITING_REVIEW",
	"PR_OPENED",
];

export type VibeLinkState = {
	status: "linked" | "skipped" | "failed" | "unknown";
	label: string;
	description: string;
	projectId: string | null;
	projectName: string | null;
	issueId: string | null;
	issueSimpleId: string | null;
	issueTitle: string | null;
	organizationName: string | null;
	matchReason: string | null;
	error: string | null;
};

export type WorkspaceRuntimeState = {
	label: string;
	shortLabel: string;
	description: string;
	tone: "default" | "success" | "warning" | "danger" | "muted";
	reviewRequired: boolean;
	rawExternalStatus: string | null;
	latestProcessStatus: string | null;
	prStatus: string | null;
};

export type ImplementationSessionLinks = {
	sessionUrl: string | null;
	projectUrl: string | null;
	issueUrl: string | null;
};

export type PrimaryTaskSummary = {
	id: string;
	identifier: string;
	title?: string | null;
};

export type TaskSessionLike = {
	latestCodingRun?: {
		status: string;
		provider?: string | null;
		externalStatus?: string | null;
		providerMetadata?: unknown;
		createdAt: Date | string;
	} | null;
};

export type TaskSessionVisibilitySummary = {
	activeCount: number;
	reviewCount: number;
	recentCount: number;
	workspaceCount: number;
};

export function asProviderMetadata(value: unknown): ProviderMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function readString(metadata: ProviderMetadata, key: string): string | null {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim() ? value : null;
}

function readBoolean(metadata: ProviderMetadata, key: string): boolean {
	return metadata?.[key] === true;
}

function getAbsoluteHttpUrl(url: string | null | undefined): string | null {
	if (!url) {
		return null;
	}
	const trimmed = url.trim();
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		return trimmed;
	}
	return null;
}

export function getVibeLinkState(metadataValue: unknown): VibeLinkState {
	const metadata = asProviderMetadata(metadataValue);
	const issueLinkingStatus = readString(metadata, "issueLinkingStatus");
	const projectId = readString(metadata, "remoteProjectId");
	const projectName = readString(metadata, "remoteProjectName");
	const issueId = readString(metadata, "remoteIssueId");
	const issueSimpleId = readString(metadata, "remoteIssueSimpleId");
	const issueTitle = readString(metadata, "remoteIssueTitle");
	const organizationName = readString(metadata, "remoteOrganizationName");
	const matchReason = readString(metadata, "remoteProjectMatchReason");
	const error = readString(metadata, "issueLinkingError");

	if (issueLinkingStatus === "linked_remote_issue") {
		return {
			status: "linked",
			label: "Linked",
			description:
				"Fabric created a Vibe issue and linked this workspace before execution started.",
			projectId,
			projectName,
			issueId,
			issueSimpleId,
			issueTitle,
			organizationName,
			matchReason,
			error,
		};
	}

	if (issueLinkingStatus === "link_failed") {
		return {
			status: "failed",
			label: "Link failed",
			description:
				"Fabric launched the workspace, but Vibe issue linking did not complete successfully.",
			projectId,
			projectName,
			issueId,
			issueSimpleId,
			issueTitle,
			organizationName,
			matchReason,
			error,
		};
	}

	if (
		issueLinkingStatus === "skipped_no_project_match" ||
		issueLinkingStatus === "skipped_remote_auth_unavailable"
	) {
		return {
			status: "skipped",
			label: "Not linked",
			description:
				issueLinkingStatus === "skipped_remote_auth_unavailable"
					? "Fabric launched the workspace, but Vibe remote project access was unavailable for issue linking."
					: "Fabric launched the workspace, but no matching Vibe remote project policy was available for automatic issue linking.",
			projectId,
			projectName,
			issueId,
			issueSimpleId,
			issueTitle,
			organizationName,
			matchReason,
			error,
		};
	}

	return {
		status: "unknown",
		label: "Unknown",
		description:
			"Vibe metadata is present, but Fabric does not have a recognized issue-linking state for this session.",
		projectId,
		projectName,
		issueId,
		issueSimpleId,
		issueTitle,
		organizationName,
		matchReason,
		error,
	};
}

export function getWorkspaceRuntimeState(input: {
	status: CodingRunStatus;
	externalStatus?: string | null;
	providerMetadata?: unknown;
}): WorkspaceRuntimeState {
	const metadata = asProviderMetadata(input.providerMetadata);
	const latestProcessStatus = readString(metadata, "latestProcessStatus");
	const prStatus = readString(metadata, "prStatus");
	const reviewRequired =
		input.status === "AWAITING_REVIEW" ||
		readBoolean(metadata, "hasPendingApproval");

	if (input.status === "FAILED") {
		return {
			label: "Workspace failed",
			shortLabel: "Workspace Failed",
			description: "The workspace runtime reported a failure.",
			tone: "danger",
			reviewRequired,
			rawExternalStatus: input.externalStatus ?? null,
			latestProcessStatus,
			prStatus,
		};
	}

	if (input.status === "TERMINATED_STALE") {
		return {
			label: "Stopped — exceeded max duration",
			shortLabel: "Stopped",
			description:
				"The workspace ran longer than the configured maximum (CODING_RUN_MAX_MINUTES) and was force-stopped by the system.",
			tone: "danger",
			reviewRequired,
			rawExternalStatus: input.externalStatus ?? null,
			latestProcessStatus,
			prStatus,
		};
	}

	if (input.status === "CANCELLED") {
		return {
			label: "Workspace stopped",
			shortLabel: "Workspace Stopped",
			description: "The workspace session was cancelled or stopped.",
			tone: "muted",
			reviewRequired,
			rawExternalStatus: input.externalStatus ?? null,
			latestProcessStatus,
			prStatus,
		};
	}

	if (input.status === "COMPLETED") {
		return {
			label: "Workspace completed",
			shortLabel: "Workspace Done",
			description: "The workspace runtime finished execution.",
			tone: "success",
			reviewRequired,
			rawExternalStatus: input.externalStatus ?? null,
			latestProcessStatus,
			prStatus,
		};
	}

	if (input.status === "PR_OPENED") {
		return {
			label: "Pull request opened",
			shortLabel: "PR Opened",
			description:
				"The workspace opened a pull request and may still need review or follow-up.",
			tone: "success",
			reviewRequired,
			rawExternalStatus: input.externalStatus ?? null,
			latestProcessStatus,
			prStatus,
		};
	}

	if (reviewRequired) {
		return {
			label: "Workspace review required",
			shortLabel: "Review Required",
			description:
				"The workspace is waiting for approval or review before continuing.",
			tone: "warning",
			reviewRequired,
			rawExternalStatus: input.externalStatus ?? null,
			latestProcessStatus,
			prStatus,
		};
	}

	if (input.externalStatus === "launching_vibe_workspace") {
		return {
			label: "Launching workspace",
			shortLabel: "Launching",
			description:
				"Fabric is starting the Vibe runtime, creating the workspace, and attaching repository context.",
			tone: "default",
			reviewRequired,
			rawExternalStatus: input.externalStatus,
			latestProcessStatus,
			prStatus,
		};
	}

	if (input.externalStatus === "workspace_linked_to_vibe_issue") {
		return {
			label: "Workspace running with linked issue",
			shortLabel: "Linked Workspace",
			description:
				"The workspace is active and linked to a remote Vibe issue.",
			tone: "success",
			reviewRequired,
			rawExternalStatus: input.externalStatus,
			latestProcessStatus,
			prStatus,
		};
	}

	if (input.externalStatus === "workspace_created_no_remote_issue") {
		return {
			label: "Workspace running without linked issue",
			shortLabel: "Workspace Running",
			description:
				"The workspace launched successfully without a matched remote Vibe issue.",
			tone: "default",
			reviewRequired,
			rawExternalStatus: input.externalStatus,
			latestProcessStatus,
			prStatus,
		};
	}

	if (input.externalStatus === "workspace_created_issue_link_failed") {
		return {
			label: "Workspace running, issue link failed",
			shortLabel: "Link Failed",
			description:
				"The workspace launched successfully, but linking to a remote Vibe issue failed.",
			tone: "warning",
			reviewRequired,
			rawExternalStatus: input.externalStatus,
			latestProcessStatus,
			prStatus,
		};
	}

	if (input.externalStatus === "workspace_created_remote_link_unavailable") {
		return {
			label: "Workspace running, remote linking unavailable",
			shortLabel: "Workspace Running",
			description:
				"The workspace launched, but remote Vibe project access was unavailable for issue linking.",
			tone: "muted",
			reviewRequired,
			rawExternalStatus: input.externalStatus,
			latestProcessStatus,
			prStatus,
		};
	}

	if (latestProcessStatus === "running" || input.status === "RUNNING") {
		return {
			label: "Workspace running",
			shortLabel: "Workspace Running",
			description:
				"The workspace runtime is actively executing the session.",
			tone: "default",
			reviewRequired,
			rawExternalStatus: input.externalStatus ?? null,
			latestProcessStatus,
			prStatus,
		};
	}

	if (input.status === "STARTING" || input.status === "QUEUED") {
		return {
			label: "Workspace queued",
			shortLabel: "Queued",
			description:
				"Fabric has queued the workspace session and is preparing launch.",
			tone: "muted",
			reviewRequired,
			rawExternalStatus: input.externalStatus ?? null,
			latestProcessStatus,
			prStatus,
		};
	}

	return {
		label: "Workspace status available",
		shortLabel: "Workspace",
		description:
			"Workspace runtime metadata is available for this implementation session.",
		tone: "default",
		reviewRequired,
		rawExternalStatus: input.externalStatus ?? null,
		latestProcessStatus,
		prStatus,
	};
}

export function formatPrimaryTaskLabel(
	primaryTask?: PrimaryTaskSummary | null,
): string | null {
	if (!primaryTask?.identifier) {
		return null;
	}
	if (primaryTask.title?.trim()) {
		return `${primaryTask.identifier} · ${primaryTask.title.trim()}`;
	}
	return primaryTask.identifier;
}

export function getImplementationSessionLinks(input: {
	provider?: string | null;
	externalUrl?: string | null;
	providerMetadata?: unknown;
}): ImplementationSessionLinks {
	const sessionUrl = getAbsoluteHttpUrl(input.externalUrl);
	if (input.provider !== "VIBE_WORKSPACE" || !sessionUrl) {
		return {
			sessionUrl,
			projectUrl: null,
			issueUrl: null,
		};
	}

	const metadata = asProviderMetadata(input.providerMetadata);
	const projectId = readString(metadata, "remoteProjectId");
	const issueId = readString(metadata, "remoteIssueId");

	try {
		const url = new URL(sessionUrl);
		const projectUrl = projectId
			? new URL(`/projects/${projectId}`, url.origin).toString()
			: null;
		const issueUrl =
			projectId && issueId
				? new URL(
						`/projects/${projectId}/issues/${issueId}`,
						url.origin,
					).toString()
				: null;
		return {
			sessionUrl,
			projectUrl,
			issueUrl,
		};
	} catch {
		return {
			sessionUrl,
			projectUrl: null,
			issueUrl: null,
		};
	}
}

function isActiveImplementationSessionStatus(
	status: string | null | undefined,
): boolean {
	return ACTIVE_STATUSES.includes(status as CodingRunStatus);
}

function isRecentImplementationSession(input: {
	status: string;
	createdAt: Date | string;
	now?: number;
}): boolean {
	if (isActiveImplementationSessionStatus(input.status)) {
		return true;
	}
	const createdAt = new Date(input.createdAt).getTime();
	const now = input.now ?? Date.now();
	return now - createdAt < 24 * 60 * 60 * 1000;
}

export function summarizeTaskSessionVisibility(
	tasks: TaskSessionLike[],
	now?: number,
): TaskSessionVisibilitySummary {
	return tasks.reduce<TaskSessionVisibilitySummary>(
		(summary, task) => {
			const run = task.latestCodingRun;
			if (!run) {
				return summary;
			}

			if (
				isRecentImplementationSession({
					status: run.status,
					createdAt: run.createdAt,
					now,
				})
			) {
				summary.recentCount += 1;
			}
			if (isActiveImplementationSessionStatus(run.status)) {
				summary.activeCount += 1;
			}
			if (
				run.status === "AWAITING_REVIEW" ||
				readBoolean(
					asProviderMetadata(run.providerMetadata),
					"hasPendingApproval",
				)
			) {
				summary.reviewCount += 1;
			}
			if (run.provider === "VIBE_WORKSPACE") {
				summary.workspaceCount += 1;
			}
			return summary;
		},
		{ activeCount: 0, reviewCount: 0, recentCount: 0, workspaceCount: 0 },
	);
}
