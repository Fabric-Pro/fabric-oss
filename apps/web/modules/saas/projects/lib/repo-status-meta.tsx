import {
	AlertTriangleIcon,
	CheckCircle2Icon,
	CircleQuestionMarkIcon,
	EyeOffIcon,
	type LucideIcon,
} from "lucide-react";

type RepoStatusTone = "active" | "expired" | "error" | "unknown";

export interface RepoStatusMeta {
	label: string;
	tone: RepoStatusTone;
	icon: LucideIcon;
	bgColor: string;
	iconColor: string;
	/** Recovery sub-text shown under the repo name; `undefined` for healthy. */
	hint?: string;
}

const META: Record<string, RepoStatusMeta> = {
	ACTIVE: {
		label: "Active",
		tone: "active",
		icon: CheckCircle2Icon,
		bgColor:
			"bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800",
		iconColor: "text-green-600 dark:text-green-400",
	},
	TOKEN_EXPIRED: {
		label: "Expired",
		tone: "expired",
		icon: AlertTriangleIcon,
		bgColor:
			"bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800",
		iconColor: "text-amber-600 dark:text-amber-400",
		hint: "Credentials expired — re-authenticate to restore access",
	},
	// Deliberately NOT the Expired hint: here the credential is fine but cannot
	// read THIS repository (app not installed on it), and reconnecting refreshes
	// the wrong grant. The remedy is granting access, not re-authenticating.
	REPO_UNAVAILABLE: {
		label: "No access",
		tone: "error",
		icon: EyeOffIcon,
		bgColor:
			"bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800",
		iconColor: "text-red-600 dark:text-red-400",
		hint: "Credentials work, but Fabric can't read this repository — install the provider app on it, or connect it with a personal access token from the row menu",
	},
	ERROR: {
		label: "Error",
		tone: "error",
		icon: AlertTriangleIcon,
		bgColor:
			"bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800",
		iconColor: "text-red-600 dark:text-red-400",
		hint: "Connection error — reconnect to restore access",
	},
	DISCONNECTED: {
		label: "Disconnected",
		tone: "error",
		icon: AlertTriangleIcon,
		bgColor:
			"bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800",
		iconColor: "text-red-600 dark:text-red-400",
		hint: "Disconnected — re-configure to restore access",
	},
};

const UNKNOWN: RepoStatusMeta = {
	label: "Status unavailable",
	tone: "unknown",
	icon: CircleQuestionMarkIcon,
	bgColor: "bg-muted border-border",
	iconColor: "text-muted-foreground",
	hint: "Status unavailable — try refreshing the page",
};

export function getRepoStatusMeta(status: string): RepoStatusMeta {
	return META[status] ?? UNKNOWN;
}
