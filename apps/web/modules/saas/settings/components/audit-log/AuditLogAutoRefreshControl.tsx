"use client";

/**
 * AuditLogAutoRefreshControl
 *
 * Compact dropdown next to the export button — off / 10s / 30s / 1m.
 * Selecting an interval drives `useInfiniteQuery`'s `refetchInterval`
 * on the table and the stats strip's `useQuery` cadence implicitly via
 * its 30s `staleTime` (which becomes more aggressive when the table is
 * refetching).
 *
 * Preference is persisted to `localStorage` so it survives reload and
 * tab switches. Rehydration runs once on mount; the writable state
 * stays in the parent so the table sees changes immediately.
 */

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { RefreshCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

const STORAGE_KEY = "auditLog.autoRefreshIntervalMs";

const OPTIONS: { labelKey: string; value: number | false }[] = [
	{ labelKey: "off", value: false },
	{ labelKey: "tenSeconds", value: 10_000 },
	{ labelKey: "thirtySeconds", value: 30_000 },
	{ labelKey: "oneMinute", value: 60_000 },
];

interface Props {
	value: number | false;
	onChange: (next: number | false) => void;
}

export function AuditLogAutoRefreshControl({ value, onChange }: Props) {
	const t = useTranslations();

	// Hydrate from localStorage on first mount only.
	useEffect(() => {
		try {
			const raw = window.localStorage.getItem(STORAGE_KEY);
			if (!raw) {
				return;
			}
			if (raw === "false") {
				onChange(false);
				return;
			}
			const parsed = Number(raw);
			if (Number.isFinite(parsed) && parsed > 0) {
				onChange(parsed);
			}
		} catch {
			// localStorage unavailable — silently fall back to defaults.
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		try {
			window.localStorage.setItem(STORAGE_KEY, String(value));
		} catch {
			// no-op
		}
	}, [value]);

	const currentLabel =
		value === false
			? t("settings.auditLog.autoRefresh.off")
			: value === 10_000
				? t("settings.auditLog.autoRefresh.tenSeconds")
				: value === 30_000
					? t("settings.auditLog.autoRefresh.thirtySeconds")
					: t("settings.auditLog.autoRefresh.oneMinute");

	return (
		<TooltipProvider>
			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button
								variant="outline"
								size="sm"
								aria-label={t(
									"settings.auditLog.autoRefresh.ariaLabel",
								)}
								className="h-9 gap-2 text-sm"
							>
								<RefreshCcw className="size-3.5" />
								<span className="text-muted-foreground">
									{t("settings.auditLog.autoRefresh.label")}:
								</span>
								<span className="text-foreground">
									{currentLabel}
								</span>
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent>
						{t("settings.auditLog.tooltips.autoRefresh")}
					</TooltipContent>
				</Tooltip>
				<DropdownMenuContent align="end">
					{OPTIONS.map((option) => (
						<DropdownMenuItem
							key={String(option.value)}
							onSelect={() => onChange(option.value)}
						>
							{t(
								`settings.auditLog.autoRefresh.${option.labelKey as "off" | "tenSeconds" | "thirtySeconds" | "oneMinute"}`,
							)}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</TooltipProvider>
	);
}
