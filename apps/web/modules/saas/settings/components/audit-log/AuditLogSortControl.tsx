"use client";

/**
 * AuditLogSortControl
 *
 * Single-select sort dropdown shown in the audit toolbar. Maps the
 * three sort variants to a clean label set; selecting one drives the
 * `audit.list` `sort` param through state held in `AuditLogViewer`.
 *
 * Uses Select primitives (combobox semantics) per the accessibility
 * spec, so screen readers announce "Sort by, combobox, Newest first".
 */

import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { useTranslations } from "next-intl";
import type { AuditSortOrder } from "./types";

interface AuditLogSortControlProps {
	value: AuditSortOrder;
	onChange: (next: AuditSortOrder) => void;
}

export function AuditLogSortControl({
	value,
	onChange,
}: AuditLogSortControlProps) {
	const t = useTranslations();
	return (
		<TooltipProvider>
			<div className="flex items-center gap-2">
				<span className="text-xs uppercase tracking-wider text-muted-foreground">
					{t("settings.auditLog.sort.label")}
				</span>
				<Tooltip>
					<TooltipTrigger asChild>
						<div>
							<Select
								value={value}
								onValueChange={(next) =>
									onChange(next as AuditSortOrder)
								}
							>
								<SelectTrigger
									className="h-9 w-44"
									aria-label={t(
										"settings.auditLog.sort.ariaLabel",
									)}
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="newest">
										{t("settings.auditLog.sort.newest")}
									</SelectItem>
									<SelectItem value="oldest">
										{t("settings.auditLog.sort.oldest")}
									</SelectItem>
									<SelectItem value="severity_desc">
										{t(
											"settings.auditLog.sort.severityDesc",
										)}
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</TooltipTrigger>
					<TooltipContent>
						{t("settings.auditLog.tooltips.sort")}
					</TooltipContent>
				</Tooltip>
			</div>
		</TooltipProvider>
	);
}
