export type DecisionStatus =
	| "PROPOSED"
	| "ACCEPTED"
	| "SUPERSEDED"
	| "DEPRECATED"
	| "REJECTED";

/** Lifecycle order used for the status filter tabs (proposed → … → rejected). */
export const DECISION_STATUSES: DecisionStatus[] = [
	"PROPOSED",
	"ACCEPTED",
	"DEPRECATED",
	"SUPERSEDED",
	"REJECTED",
];

/**
 * Status presentation. Neutral (muted token) for PROPOSED; semantic accent
 * palettes — with explicit light/dark text — for the rest. These are data
 * status indicators (a small colored dot + tinted pill), the same pattern used
 * by the other status maps in this module.
 */
export const STATUS_CONFIG: Record<
	DecisionStatus,
	{
		label: string;
		badgeClassName: string;
		dotClassName: string;
		description: string;
	}
> = {
	PROPOSED: {
		label: "Proposed",
		badgeClassName: "border-border/70 bg-muted/60 text-muted-foreground",
		dotClassName: "bg-stone-400 dark:bg-stone-500",
		description: "Under discussion — not yet agreed.",
	},
	ACCEPTED: {
		label: "Accepted",
		badgeClassName:
			"border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
		dotClassName: "bg-emerald-500",
		description: "Agreed and currently in effect.",
	},
	DEPRECATED: {
		label: "Deprecated",
		badgeClassName:
			"border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
		dotClassName: "bg-amber-500",
		description: "Still in place but discouraged for new work.",
	},
	SUPERSEDED: {
		label: "Superseded",
		badgeClassName:
			"border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
		dotClassName: "bg-violet-500",
		description: "Replaced by a newer decision.",
	},
	REJECTED: {
		label: "Rejected",
		badgeClassName:
			"border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
		dotClassName: "bg-rose-500",
		description: "Considered but not adopted.",
	},
};

// ---------------------------------------------------------------------------
// Domains (category / area)
// ---------------------------------------------------------------------------

export type DecisionDomain =
	| "infra"
	| "data"
	| "ai"
	| "security"
	| "frontend"
	| "platform";

export const DECISION_DOMAINS: DecisionDomain[] = [
	"infra",
	"data",
	"ai",
	"security",
	"frontend",
	"platform",
];

export const DOMAIN_CONFIG: Record<
	DecisionDomain,
	{
		label: string;
		tagClassName: string;
		dotClassName: string;
		description: string;
	}
> = {
	infra: {
		label: "Infrastructure",
		tagClassName:
			"border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
		dotClassName: "bg-sky-500",
		description: "Compute, networking, deployment, and runtime platforms.",
	},
	data: {
		label: "Data",
		tagClassName:
			"border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
		dotClassName: "bg-cyan-500",
		description: "Storage, databases, schemas, and data pipelines.",
	},
	ai: {
		label: "AI",
		tagClassName:
			"border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
		dotClassName: "bg-violet-500",
		description: "Models, inference, embeddings, and AI/LLM tooling.",
	},
	security: {
		label: "Security",
		tagClassName:
			"border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
		dotClassName: "bg-rose-500",
		description: "Authentication, authorization, secrets, and compliance.",
	},
	frontend: {
		label: "Frontend",
		tagClassName:
			"border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
		dotClassName: "bg-amber-500",
		description: "UI architecture, client state, and rendering.",
	},
	platform: {
		label: "Platform",
		tagClassName:
			"border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
		dotClassName: "bg-emerald-500",
		description: "Cross-cutting services, APIs, and developer tooling.",
	},
};

export function isDecisionDomain(
	value: string | null | undefined,
): value is DecisionDomain {
	return (
		Boolean(value) &&
		(DECISION_DOMAINS as string[]).includes(value as string)
	);
}

// ---------------------------------------------------------------------------
// Duration (how long the decision stands)
// ---------------------------------------------------------------------------

export type DecisionDuration = "LONG_STANDING" | "SHORT_TERM";

export const DURATION_CONFIG: Record<
	DecisionDuration,
	{ label: string; tagClassName: string; description: string }
> = {
	LONG_STANDING: {
		label: "Long-standing",
		tagClassName:
			"border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
		description: "Standing guidance until explicitly revised.",
	},
	SHORT_TERM: {
		label: "Short-term",
		tagClassName:
			// amber-800 (not -700): the pill renders on the detail sheet's
			// background too, where -700 sits just under 4.5:1 in light mode.
			"border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
		description:
			"Bound to a deadline or milestone; revisit when it passes.",
	},
};

/** Neutral pill style for a decision-type taxonomy label. */
export const TYPE_TAG_CLASS =
	"border-border/70 bg-muted/60 text-muted-foreground";

// ---------------------------------------------------------------------------
// Avatars (deterministic color from a stable key — id or name)
// ---------------------------------------------------------------------------

const AVATAR_PALETTE = [
	"bg-rose-500",
	"bg-amber-500",
	"bg-emerald-500",
	"bg-sky-500",
	"bg-violet-500",
	"bg-cyan-500",
	"bg-fuchsia-500",
	"bg-teal-500",
];

export function avatarColorClass(key: string): string {
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
	}
	return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

export function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return "?";
	}
	if (parts.length === 1) {
		return parts[0].slice(0, 2).toUpperCase();
	}
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function formatDecisionDate(value: string | Date): string {
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	}).format(value instanceof Date ? value : new Date(value));
}

/** Full date + time in the viewer's locale, e.g. "Jun 15, 2026, 2:30 PM". */
export function formatDecisionDateTime(value: string | Date): string {
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) {
		return "";
	}
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(d);
}

/** Full date + time in UTC, e.g. "Jun 15, 2026, 14:30 UTC". */
export function formatDecisionDateTimeUtc(value: string | Date): string {
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) {
		return "";
	}
	return `${new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
		timeZone: "UTC",
		hour12: false,
	}).format(d)} UTC`;
}

/** Format a Date as a yyyy-mm-dd string for a native date input. */
export function toDateInputValue(
	value: string | Date | null | undefined,
): string {
	if (!value) {
		return "";
	}
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) {
		return "";
	}
	return d.toISOString().slice(0, 10);
}
