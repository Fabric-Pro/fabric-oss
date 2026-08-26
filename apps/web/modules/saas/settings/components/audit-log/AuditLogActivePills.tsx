"use client";

/**
 * AuditLogActivePills
 *
 * Removable chip row showing every currently-applied filter. Sits above
 * the table and lets the operator unstick a single dimension without
 * opening the corresponding popover. Each pill carries the dimension
 * label + value and an `aria-label` on the dismiss button so screen
 * readers announce what's being removed.
 *
 * Keyboard: pills are focusable buttons; Enter/Space removes the filter.
 * When 2+ pills are visible we surface a "Clear all" link at the end.
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { describeAction, resolveActionLabel } from "./action-catalog";
import type {
	AuditActorType,
	AuditLogFiltersState,
	AuditViewerMode,
	AuditViewerUser,
} from "./types";
import { EMPTY_FILTERS_STATE } from "./types";

interface Pill {
	key: string;
	label: string;
	value: string;
	ariaRemoveLabel: string;
	onRemove: () => void;
}

interface AuditLogActivePillsProps {
	mode: AuditViewerMode;
	filters: AuditLogFiltersState;
	/** Null in explorer mode — there is no signed-in customer user. */
	currentUser: AuditViewerUser | null;
	onFiltersChange: (next: AuditLogFiltersState) => void;
}

function formatDate(iso: string): string {
	try {
		return new Date(iso).toLocaleDateString();
	} catch {
		return iso;
	}
}

export function AuditLogActivePills({
	mode,
	filters,
	currentUser,
	onFiltersChange,
}: AuditLogActivePillsProps) {
	const t = useTranslations();

	const pills = useMemo<Pill[]>(() => {
		const list: Pill[] = [];

		const labelFor = (key: string) =>
			t(
				`settings.auditLog.pills.labels.${key}` as Parameters<
					typeof t
				>[0],
			);

		const removeAria = (key: string, value: string) =>
			t("settings.auditLog.pills.remove", {
				label: labelFor(key),
				value,
			} as never);

		// actions — one pill per selected action; multiple is rare so this
		// gives operators per-action removability.
		for (const action of filters.actions) {
			const descriptor = describeAction(action);
			const display = resolveActionLabel(
				t as (key: string) => string,
				descriptor,
			);
			list.push({
				key: `actions.${action}`,
				label: labelFor("action"),
				value: display,
				ariaRemoveLabel: removeAria("action", display),
				onRemove: () =>
					onFiltersChange({
						...filters,
						actions: filters.actions.filter((v) => v !== action),
					}),
			});
		}

		for (const category of filters.categories) {
			list.push({
				key: `categories.${category}`,
				label: labelFor("category"),
				value: category,
				ariaRemoveLabel: removeAria("category", category),
				onRemove: () =>
					onFiltersChange({
						...filters,
						categories: filters.categories.filter(
							(v) => v !== category,
						),
					}),
			});
		}

		// In personal mode actorIds is pinned to current user — that pin is
		// "default" and is NOT rendered as a removable pill. Explorer mode
		// has no current user so we fall through to the org-mode branch.
		const filteredActorIds =
			mode === "personal" && currentUser
				? filters.actorIds.filter((id) => id !== currentUser.id)
				: filters.actorIds;
		for (const actorId of filteredActorIds) {
			list.push({
				key: `actorIds.${actorId}`,
				label: labelFor("actor"),
				value: actorId,
				ariaRemoveLabel: removeAria("actor", actorId),
				onRemove: () =>
					onFiltersChange({
						...filters,
						actorIds: filters.actorIds.filter((v) => v !== actorId),
					}),
			});
		}

		for (const actorType of filters.actorTypes) {
			const display = t(
				`settings.auditLog.filters.actorType.${actorType}` as Parameters<
					typeof t
				>[0],
			);
			list.push({
				key: `actorTypes.${actorType}`,
				label: labelFor("actorType"),
				value: display,
				ariaRemoveLabel: removeAria("actorType", display),
				onRemove: () =>
					onFiltersChange({
						...filters,
						actorTypes: filters.actorTypes.filter(
							(v) => v !== actorType,
						) as AuditActorType[],
					}),
			});
		}

		if (filters.projectId) {
			list.push({
				key: "projectId",
				label: labelFor("project"),
				value: filters.projectId,
				ariaRemoveLabel: removeAria("project", filters.projectId),
				onRemove: () =>
					onFiltersChange({
						...filters,
						projectId: undefined,
					}),
			});
		}

		for (const severity of filters.severities) {
			const display = t(
				`settings.auditLog.severities.${severity as "info" | "warning" | "error" | "critical"}`,
			);
			list.push({
				key: `severities.${severity}`,
				label: labelFor("severity"),
				value: display,
				ariaRemoveLabel: removeAria("severity", display),
				onRemove: () =>
					onFiltersChange({
						...filters,
						severities: filters.severities.filter(
							(v) => v !== severity,
						),
					}),
			});
		}

		for (const outcome of filters.outcomes) {
			const display = t(
				`settings.auditLog.outcomes.${outcome as "success" | "failure"}`,
			);
			list.push({
				key: `outcomes.${outcome}`,
				label: labelFor("outcome"),
				value: display,
				ariaRemoveLabel: removeAria("outcome", display),
				onRemove: () =>
					onFiltersChange({
						...filters,
						outcomes: filters.outcomes.filter((v) => v !== outcome),
					}),
			});
		}

		if (filters.dateFrom || filters.dateTo) {
			const from = filters.dateFrom ? formatDate(filters.dateFrom) : "…";
			const to = filters.dateTo ? formatDate(filters.dateTo) : "…";
			const display = `${from} → ${to}`;
			list.push({
				key: "dateRange",
				label: labelFor("dateRange"),
				value: display,
				ariaRemoveLabel: removeAria("dateRange", display),
				onRemove: () =>
					onFiltersChange({
						...filters,
						dateFrom: undefined,
						dateTo: undefined,
					}),
			});
		}

		if (filters.correlationId) {
			const display =
				filters.correlationId.length > 12
					? `${filters.correlationId.slice(0, 12)}…`
					: filters.correlationId;
			list.push({
				key: "correlationId",
				label: labelFor("correlation"),
				value: display,
				ariaRemoveLabel: removeAria(
					"correlation",
					filters.correlationId,
				),
				onRemove: () =>
					onFiltersChange({
						...filters,
						correlationId: undefined,
					}),
			});
		}

		if (filters.ipAddressContains) {
			list.push({
				key: "ipAddressContains",
				label: labelFor("ipAddress"),
				value: filters.ipAddressContains,
				ariaRemoveLabel: removeAria(
					"ipAddress",
					filters.ipAddressContains,
				),
				onRemove: () =>
					onFiltersChange({
						...filters,
						ipAddressContains: undefined,
					}),
			});
		}

		return list;
	}, [filters, mode, currentUser, onFiltersChange, t]);

	if (pills.length === 0) {
		return null;
	}

	return (
		<TooltipProvider>
			<div
				role="region"
				aria-label={t("settings.auditLog.pills.region")}
				className="flex flex-wrap items-center gap-2"
			>
				<span className="app-editorial-label">
					{t("settings.auditLog.pills.heading")}
				</span>
				{pills.map((pill) => (
					<Badge
						key={pill.key}
						variant="outline"
						className="gap-1.5 px-2 py-1 text-xs"
					>
						<span className="text-muted-foreground">
							{pill.label}:
						</span>
						<span className="text-foreground">{pill.value}</span>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label={pill.ariaRemoveLabel}
									onClick={pill.onRemove}
									className="ml-0.5 inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
								>
									<XIcon
										aria-hidden="true"
										className="size-3"
									/>
								</button>
							</TooltipTrigger>
							<TooltipContent>
								{t("settings.auditLog.tooltips.removeFilter")}
							</TooltipContent>
						</Tooltip>
					</Badge>
				))}
				{pills.length >= 2 ? (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 text-xs text-muted-foreground"
						onClick={() =>
							onFiltersChange(
								mode === "personal" && currentUser
									? {
											...EMPTY_FILTERS_STATE,
											actorIds: [currentUser.id],
										}
									: EMPTY_FILTERS_STATE,
							)
						}
					>
						{t("settings.auditLog.pills.clearAll")}
					</Button>
				) : null}
			</div>
		</TooltipProvider>
	);
}
