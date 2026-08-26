"use client";

/**
 * SeverityBadge
 *
 * Tiny token-driven badge for the audit row severity column. Renders as a
 * coloured dot (info/warning/error) or a solid pill for `critical` so the
 * most urgent severity reads as a primary signal at a glance.
 *
 * `iconOnly` mode (item 17): shrinks to just the indicator without the
 * text label — the surrounding component is expected to provide a
 * Tooltip with the severity name on hover.
 *
 * Colours are CSS variable tokens from the design system — no hardcoded
 * hex. Each variant ships an `aria-label` for screen readers.
 */

import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";

export type Severity = "info" | "warning" | "error" | "critical";

interface SeverityBadgeProps {
	severity: string;
	className?: string;
	iconOnly?: boolean;
}

const TONE: Record<Severity, { dot: string; ring: string; text: string }> = {
	info: {
		dot: "bg-muted-foreground/70",
		ring: "ring-muted-foreground/30",
		text: "text-muted-foreground",
	},
	warning: {
		dot: "bg-highlight",
		ring: "ring-highlight/30",
		text: "text-highlight",
	},
	error: {
		dot: "bg-destructive",
		ring: "ring-destructive/30",
		text: "text-destructive",
	},
	critical: {
		dot: "bg-destructive",
		ring: "ring-destructive/40",
		text: "text-destructive-foreground",
	},
};

function normalize(severity: string): Severity {
	if (
		severity === "warning" ||
		severity === "error" ||
		severity === "critical"
	) {
		return severity;
	}
	return "info";
}

export function SeverityBadge({
	severity,
	className,
	iconOnly = false,
}: SeverityBadgeProps) {
	const t = useTranslations();
	const tone = normalize(severity);
	const styles = TONE[tone];
	const label = t(`settings.auditLog.severities.${tone}`);
	const aria = t("settings.auditLog.aria.severity", { severity: label });

	if (tone === "critical") {
		// Critical is always a solid red pill; in iconOnly mode it
		// shrinks to a compact square with the dot.
		if (iconOnly) {
			return (
				<span
					role="status"
					aria-label={aria}
					className={cn(
						"inline-flex size-4 items-center justify-center rounded-full bg-destructive",
						className,
					)}
				>
					<span
						aria-hidden="true"
						className="inline-block size-1.5 rounded-full bg-destructive-foreground"
					/>
				</span>
			);
		}
		return (
			<span
				role="status"
				aria-label={aria}
				className={cn(
					"inline-flex items-center gap-1.5 rounded-full bg-destructive px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-destructive-foreground",
					className,
				)}
			>
				<span className="inline-block size-1.5 rounded-full bg-destructive-foreground" />
				{label}
			</span>
		);
	}

	if (iconOnly) {
		return (
			<span
				role="status"
				aria-label={aria}
				className={cn(
					"inline-flex items-center",
					styles.text,
					className,
				)}
			>
				<span
					aria-hidden="true"
					className={cn(
						"inline-block size-2 rounded-full ring-2",
						styles.dot,
						styles.ring,
					)}
				/>
			</span>
		);
	}

	return (
		<span
			role="status"
			aria-label={aria}
			className={cn(
				"inline-flex items-center gap-1.5 text-[11px] font-medium",
				styles.text,
				className,
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"inline-block size-1.5 rounded-full ring-2",
					styles.dot,
					styles.ring,
				)}
			/>
			{label}
		</span>
	);
}
