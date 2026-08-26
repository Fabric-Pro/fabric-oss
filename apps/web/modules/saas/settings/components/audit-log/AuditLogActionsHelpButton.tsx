"use client";

/**
 * AuditLogActionsHelpButton
 *
 * The (?) icon that sits next to the Action filter chip. Clicking it
 * opens a Dialog that lists every action key Fabric can emit, grouped
 * by category, with a short operator-facing description for each.
 *
 * Sourced from `audit-actions-catalog.ts` so the dialog and the
 * per-option hover tooltips on the Action filter dropdown can stay in
 * lock-step — adding an action means editing the catalog in one place.
 *
 * Theming: every color is a CSS variable token so the dialog reads the
 * same in light + dark and respects the `motion-safe` reduced-motion
 * preference.
 */

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { HelpCircleIcon, SearchIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
	type AuditActionEntry,
	type AuditCategory,
	getActionsByCategory,
} from "./audit-actions-catalog";

interface AuditLogActionsHelpButtonProps {
	className?: string;
}

export function AuditLogActionsHelpButton({
	className,
}: AuditLogActionsHelpButtonProps) {
	const t = useTranslations();
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");

	const groups = useMemo(() => {
		const lower = search.trim().toLowerCase();
		const all = getActionsByCategory();
		if (!lower) {
			return all;
		}
		return all
			.map(({ category, actions }) => ({
				category,
				actions: actions.filter((a) => {
					const labelMaybe = t(a.labelKey as Parameters<typeof t>[0]);
					const label =
						typeof labelMaybe === "string" &&
						!labelMaybe.startsWith("settings.")
							? labelMaybe
							: a.key;
					return (
						a.key.toLowerCase().includes(lower) ||
						label.toLowerCase().includes(lower) ||
						a.description.toLowerCase().includes(lower)
					);
				}),
			}))
			.filter((g) => g.actions.length > 0);
	}, [search, t]);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className={
						"h-7 w-7 rounded-full p-0 text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary" +
						(className ? ` ${className}` : "")
					}
					aria-label={t(
						"settings.auditLog.actionsHelp.openAriaLabel",
					)}
					data-testid="audit-actions-help-button"
				>
					<HelpCircleIcon className="size-4" aria-hidden />
				</Button>
			</DialogTrigger>
			<DialogContent
				className="flex max-h-[85vh] w-[min(820px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden p-0"
				data-testid="audit-actions-help-dialog"
			>
				<DialogHeader className="shrink-0 space-y-2 border-b border-border/40 px-6 pb-4 pt-6">
					<DialogTitle className="font-serif text-2xl font-normal text-foreground">
						{t("settings.auditLog.actionsHelp.dialogTitle")}
					</DialogTitle>
					<DialogDescription className="text-sm text-muted-foreground">
						{t("settings.auditLog.actionsHelp.dialogDescription")}
					</DialogDescription>
					<div className="relative mt-2">
						<SearchIcon
							aria-hidden
							className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
						/>
						<Input
							type="search"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder={t(
								"settings.auditLog.actionsHelp.searchPlaceholder",
							)}
							className="h-9 pl-9"
							aria-label={t(
								"settings.auditLog.actionsHelp.searchAriaLabel",
							)}
							data-testid="audit-actions-help-search"
						/>
					</div>
				</DialogHeader>
				<div
					className="flex-1 min-h-0 space-y-6 overflow-y-auto px-6 py-5"
					data-testid="audit-actions-help-list"
				>
					{groups.length === 0 ? (
						<p
							className="rounded-md border border-dashed border-border/60 bg-muted/40 px-4 py-6 text-center text-sm text-muted-foreground"
							data-testid="audit-actions-help-empty"
						>
							{t("settings.auditLog.actionsHelp.empty")}
						</p>
					) : (
						groups.map(({ category, actions }) => (
							<HelpSection
								key={category.id}
								category={category}
								actions={actions}
							/>
						))
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function HelpSection({
	category,
	actions,
}: {
	category: AuditCategory;
	actions: AuditActionEntry[];
}) {
	const t = useTranslations();
	return (
		<section
			className="space-y-3"
			data-testid={`audit-actions-help-section-${category.id}`}
		>
			<header className="space-y-1 border-l-2 border-primary/70 pl-3">
				<p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
					{category.label}
				</p>
				<p className="text-xs text-muted-foreground/90">
					{category.description}
				</p>
			</header>
			<ul className="grid gap-2 sm:grid-cols-2">
				{actions.map((entry) => {
					const labelMaybe = t(
						entry.labelKey as Parameters<typeof t>[0],
					);
					const label =
						typeof labelMaybe === "string" &&
						!labelMaybe.startsWith("settings.")
							? labelMaybe
							: entry.key;
					return (
						<li
							key={entry.key}
							className="rounded-md border border-border/50 bg-card/80 p-3 transition-colors hover:border-border hover:bg-card"
							data-testid={`audit-actions-help-item-${entry.key}`}
						>
							<div className="flex flex-col gap-1">
								<span className="text-sm font-medium text-foreground">
									{label}
								</span>
								<code className="font-mono text-[10px] text-muted-foreground">
									{entry.key}
								</code>
								<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
									{entry.description}
								</p>
							</div>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
