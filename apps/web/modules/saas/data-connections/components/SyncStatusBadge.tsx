/**
 * SyncStatusBadge Component
 *
 * Displays the per-tenant sync status of a data connection (PENDING /
 * CONNECTED / SYNCING / ERROR / PAUSED / EXPIRED). This is DISTINCT from
 * the upstream provider-health surface rendered by
 * `ProviderHealthBadge` -- the two coexist on each `ConnectionCard`.
 *
 * The `aria-label` is qualified with the literal prefix "Sync status:" so
 * screen-reader users can disambiguate it from the neighbouring provider
 * health badge ("Provider status: ...").
 */

"use client";

import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib";
import {
	AlertTriangle,
	CheckCircle,
	Clock,
	Loader2,
	Pause,
	XCircle,
} from "lucide-react";
import type { DataConnectionStatus } from "../lib/providers";
import { STATUS_CONFIG } from "../lib/providers";

interface SyncStatusBadgeProps {
	status: DataConnectionStatus;
	className?: string;
	showIcon?: boolean;
	/**
	 * Override the auto-generated `aria-label` if the host component
	 * already wraps the badge in a labelled region. Defaults to
	 * `Sync status: <human label>` so the badge is self-describing.
	 */
	"aria-label"?: string;
}

const STATUS_ICONS: Record<
	DataConnectionStatus,
	React.ComponentType<{ className?: string }>
> = {
	PENDING: Clock,
	CONNECTED: CheckCircle,
	SYNCING: Loader2,
	ERROR: XCircle,
	PAUSED: Pause,
	EXPIRED: AlertTriangle,
};

export function SyncStatusBadge({
	status,
	className,
	showIcon = true,
	"aria-label": ariaLabelProp,
}: SyncStatusBadgeProps) {
	const config = STATUS_CONFIG[status];
	const Icon = STATUS_ICONS[status];
	const ariaLabel = ariaLabelProp ?? `Sync status: ${config.label}`;

	return (
		<Badge
			variant="outline"
			role="status"
			aria-label={ariaLabel}
			className={cn(
				"flex items-center gap-1.5",
				config.bgColor,
				config.color,
				"border-transparent",
				className,
			)}
		>
			{showIcon && (
				<Icon
					className={cn(
						"h-3 w-3",
						status === "SYNCING" && "animate-spin",
					)}
					aria-hidden="true"
				/>
			)}
			{config.label}
		</Badge>
	);
}
