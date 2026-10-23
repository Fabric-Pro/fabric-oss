export type WorkflowStatus =
	| "DRAFT"
	| "PUBLISHED"
	| "ACTIVE"
	| "PAUSED"
	| "ARCHIVED";

/** Label and colours for a workflow's status, shared by the list and the editor. */
export const WORKFLOW_STATUS_DISPLAY: Record<
	WorkflowStatus,
	{ label: string; className: string; dot: string }
> = {
	DRAFT: {
		label: "Draft",
		className: "bg-muted text-muted-foreground",
		dot: "bg-muted-foreground/50",
	},
	PUBLISHED: {
		label: "Published",
		className: "bg-primary/10 text-primary",
		dot: "bg-primary",
	},
	ACTIVE: {
		label: "Active",
		className: "bg-success/10 text-success",
		dot: "bg-success",
	},
	PAUSED: {
		label: "Paused",
		className: "bg-highlight/10 text-highlight",
		dot: "bg-highlight",
	},
	ARCHIVED: {
		label: "Archived",
		className: "bg-destructive/10 text-destructive",
		dot: "bg-destructive",
	},
};
