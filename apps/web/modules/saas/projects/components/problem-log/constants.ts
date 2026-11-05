import type {
	ContextProblemCategory,
	ProblemLogCategory,
	ProblemLogSeverity,
	ProblemLogStatus,
} from "@repo/database";

export type {
	ContextProblemCategory,
	ProblemLogCategory,
	ProblemLogSeverity,
	ProblemLogStatus,
};

export const formatDateTime = (value: string | Date) =>
	new Date(value).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
export const CONTEXT_CATEGORIES: ContextProblemCategory[] = [
	"PROJECT_ISSUE",
	"PROJECT_BLOCKER",
	"PROJECT_RISK",
];

export type ReviewSeverity = Exclude<ProblemLogSeverity, "INFO">;
export const REVIEW_SEVERITIES: ReviewSeverity[] = [
	"WARNING",
	"ERROR",
	"CRITICAL",
];

export const STATUS_LABEL: Record<ProblemLogStatus, string> = {
	OPEN: "Open",
	RESOLVED: "Resolved",
};

export const CATEGORY_LABEL: Record<ProblemLogCategory, string> = {
	SYSTEM_ERROR: "System error",
	INTEGRATION_FAILURE: "Integration failure",
	BACKGROUND_JOB_FAILURE: "Background job failure",
	NOTIFICATION_FAILURE: "Notification delivery failure",
	SECURITY_EVENT: "Security event",
	DATA_PIPELINE_FAILURE: "Data pipeline failure",
	SLA_BREACH: "Threshold breach",
	PROJECT_ISSUE: "Project issue",
	PROJECT_BLOCKER: "Project blocker",
	PROJECT_RISK: "Project risk",
};

export const SEVERITY_CONFIG: Record<
	ProblemLogSeverity,
	{ label: string; className: string }
> = {
	INFO: { label: "Info", className: "text-muted-foreground" },
	WARNING: {
		label: "Warning",
		className: "border-highlight-ink/40 text-highlight-ink",
	},
	ERROR: {
		label: "Error",
		className: "border-destructive/40 text-destructive",
	},
	CRITICAL: {
		label: "Critical",
		className: "border-destructive bg-destructive/10 text-destructive",
	},
};
