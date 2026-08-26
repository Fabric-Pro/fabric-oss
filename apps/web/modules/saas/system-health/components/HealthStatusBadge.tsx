"use client";

/**
 * Status pill for the customer-facing health surface.
 *
 * The tone vocabulary matches the admin monitoring grid's so the same status
 * never reads two different ways across the product. It is defined here rather
 * than imported from the admin module because that map is coupled to the admin
 * glossary tooltips; unifying the two behind one shared primitive is worthwhile
 * but is a refactor of admin code this change does not otherwise touch.
 *
 * Every colour is a design token — status colour is meaning, so a hardcoded hex
 * here would be a bug rather than a style choice.
 */

import { cn } from "@ui/lib";

export type HealthStatus =
	| "OPERATIONAL"
	| "DEGRADED"
	| "PARTIAL_OUTAGE"
	| "MAJOR_OUTAGE"
	| "MAINTENANCE"
	| "UNKNOWN"
	| "NOT_CONFIGURED";

interface Tone {
	label: string;
	/** Badge classes. */
	cls: string;
	/**
	 * Dot colour for a STANDALONE dot, on a normal page background. Carries the
	 * status hue, because here the dot is the only colour channel.
	 */
	dot: string;
	/**
	 * Dot colour INSIDE the badge. Distinct because the problem states use a
	 * solid fill, where a status-hued dot would be invisible against its own
	 * colour — it has to use the paired foreground instead.
	 */
	badgeDot: string;
}

const TONE: Record<HealthStatus, Tone> = {
	OPERATIONAL: {
		label: "Operational",
		// Solid, like every other state. It was a 10% tint until the contrast
		// proof measured `text-secondary` on `bg-secondary/10` at 4.41:1 over the
		// page background — under the 4.5:1 AA floor. It cleared on `--card`
		// (4.70:1) but a badge cannot assume which surface it sits on, so the
		// tint had to go. Solid measures 5.48:1 light / 9.83:1 dark.
		cls: "border-secondary bg-secondary text-secondary-foreground",
		dot: "bg-secondary",
		badgeDot: "bg-secondary-foreground",
	},
	// Every state uses a SOLID fill with a paired foreground rather than coloured
	// text on a 10% tint of itself. Measured on the real tokens by
	// `health-status-badge-contrast.test.ts`, the tinted form failed the 4.5:1 AA
	// floor on the text that tells a customer how bad an outage is: `highlight`
	// 2.66:1 over the page background (2.83:1 over a card), `secondary` 4.41:1,
	// `destructive` 4.20:1 over a card in dark mode.
	//
	// The paired `*-foreground` tokens are designed for this and clear the floor
	// everywhere except dark-mode `destructive`, which is handled below. The
	// earlier intent of keeping the all-clear visually quieter than a problem is
	// dropped: it cannot be expressed as a tint without failing AA, and hue
	// already carries that emphasis.
	DEGRADED: {
		label: "Degraded",
		cls: "border-highlight bg-highlight text-highlight-foreground",
		dot: "bg-highlight",
		badgeDot: "bg-highlight-foreground",
	},
	PARTIAL_OUTAGE: {
		label: "Partial outage",
		cls: "border-highlight bg-highlight text-highlight-foreground",
		dot: "bg-highlight",
		badgeDot: "bg-highlight-foreground",
	},
	MAJOR_OUTAGE: {
		label: "Major outage",
		// No local override needed. The dark-mode `--destructive-foreground` token
		// was #ffffff, which measures 3.76:1 on dark mode's brighter `--destructive`
		// — so this badge originally carried a `dark:text-background` workaround. The
		// token itself is fixed now (#111110, 5.02:1), because the failure was never
		// specific to this badge: every `bg-destructive` + `text-destructive-foreground`
		// pairing in the product had it.
		cls: "border-destructive bg-destructive text-destructive-foreground",
		dot: "bg-destructive",
		badgeDot: "bg-destructive-foreground",
	},
	MAINTENANCE: {
		label: "Maintenance",
		cls: "border-border/60 bg-muted text-muted-foreground",
		dot: "bg-muted-foreground",
		badgeDot: "bg-muted-foreground",
	},
	UNKNOWN: {
		label: "Unknown",
		cls: "border-border/60 bg-muted text-muted-foreground",
		dot: "bg-muted-foreground",
		badgeDot: "bg-muted-foreground",
	},
	NOT_CONFIGURED: {
		// Neutral, never destructive. Says "we are not watching this", NOT "this is
		// off" — the probe credential is absent in this environment but the
		// capability itself is usually working.
		label: "Not monitored",
		cls: "border-border/60 bg-muted text-muted-foreground",
		dot: "bg-muted-foreground",
		badgeDot: "bg-muted-foreground",
	},
};

export function healthStatusLabel(status: HealthStatus): string {
	return TONE[status].label;
}

export function HealthStatusBadge({
	status,
	className,
}: {
	status: HealthStatus;
	className?: string;
}) {
	const tone = TONE[status];
	return (
		<span
			className={cn(
				"inline-flex items-center gap-2 rounded-full border px-2.5 py-0.5 font-medium text-xs",
				tone.cls,
				className,
			)}
		>
			<span
				aria-hidden="true"
				className={cn("size-1.5 rounded-full", tone.badgeDot)}
			/>
			{tone.label}
		</span>
	);
}

export function HealthStatusDot({
	status,
	className,
}: {
	status: HealthStatus;
	className?: string;
}) {
	const tone = TONE[status];
	return (
		<span
			// The dot alone carries the status, so it needs an accessible name —
			// colour is never the only channel.
			role="img"
			aria-label={tone.label}
			className={cn(
				"inline-block size-2 rounded-full",
				tone.dot,
				className,
			)}
		/>
	);
}
