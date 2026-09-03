"use client";

// Leaf import (not the barrel): client component — the barrel pulls Prisma.
import { PROJECT_TAB_PROTECTED_IDS } from "@repo/database/src/project-tabs";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Switch } from "@ui/components/switch";
import { LockIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	isProjectTabFeatureEnabled,
	type ProjectTabMeta,
	resolveAdminTabState,
	useProjectTabGates,
} from "../lib/project-tab-preferences";

type Props = {
	tabs: readonly ProjectTabMeta[];
	/** The raw `tabVisibility.get` payload (already null-safe). */
	config: Record<string, unknown> | null;
	canEdit: boolean;
	onSave: (
		config: { overrides: Record<string, boolean> },
		handlers: { onError: (error: unknown) => void },
	) => void;
	saving: boolean;
};

/**
 * Admin panel for project-wide tab visibility (Fizzy card #1837): one switch
 * per non-protected tab. Every tab this deployment offers starts on; turning
 * one off here hides it for EVERY member — personal preferences can't bring
 * it back — and turning it on again restores it for the whole project.
 * Overview and Settings are locked: the
 * overview is every project's landing page and settings is where a hidden tab
 * gets re-enabled.
 *
 * Edits draft locally and persist on Save so a failed request leaves the
 * stored configuration untouched.
 */
export function ProjectTabVisibilitySettings({
	tabs,
	config,
	canEdit,
	onSave,
	saving,
}: Props) {
	const stored = useMemo(() => {
		const overrides =
			config && typeof config === "object" && !Array.isArray(config)
				? (config as { overrides?: unknown }).overrides
				: null;
		if (!overrides || typeof overrides !== "object") {
			return {} as Record<string, boolean>;
		}
		const clean: Record<string, boolean> = {};
		for (const [id, value] of Object.entries(
			overrides as Record<string, unknown>,
		)) {
			if (typeof value === "boolean") {
				clean[id] = value;
			}
		}
		return clean;
	}, [config]);

	const [draft, setDraft] = useState<Record<string, boolean>>(stored);
	useEffect(() => setDraft(stored), [stored]);

	const tabGates = useProjectTabGates();
	const offered = useMemo(
		() => tabs.filter((t) => isProjectTabFeatureEnabled(t.id, tabGates)),
		[tabs, tabGates],
	);

	const effective = useMemo(
		() =>
			resolveAdminTabState(
				offered.map((t) => t.id),
				{ overrides: stored },
				tabGates,
			),
		[offered, stored, tabGates],
	);

	const dirty = offered.some((t) => {
		if ((PROJECT_TAB_PROTECTED_IDS as readonly string[]).includes(t.id)) {
			return false;
		}
		return draft[t.id] !== undefined && draft[t.id] !== effective[t.id];
	});

	return (
		<Card className="rounded-2xl">
			<div className="p-6">
				<p className="font-medium text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
					Navigation
				</p>
				<h3 className="mt-2 font-semibold text-lg">Tab visibility</h3>
				<p className="mt-1 max-w-3xl text-muted-foreground text-sm">
					Choose which tabs are available in this project. Hidden tabs
					disappear for every member; each member can still hide
					available tabs for themselves and reorder their own tab bar.
				</p>

				<ul className="mt-4 divide-y rounded-xl border border-border/70">
					{offered.map((tab) => {
						const Icon = tab.icon;
						const locked = (
							PROJECT_TAB_PROTECTED_IDS as readonly string[]
						).includes(tab.id);
						const visible = draft[tab.id] ?? effective[tab.id];
						return (
							<li
								key={tab.id}
								className="flex items-center gap-3 px-4 py-3"
							>
								<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
									<Icon
										aria-hidden="true"
										className="size-4 text-muted-foreground"
									/>
								</span>
								<span className="min-w-0 flex-1 truncate font-medium text-sm">
									{tab.label}
								</span>
								{locked ? (
									<span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
										<LockIcon
											aria-hidden="true"
											className="size-3.5"
										/>
										Always shown
									</span>
								) : (
									<Switch
										checked={visible}
										disabled={!canEdit || saving}
										onCheckedChange={(checked) =>
											setDraft((prev) => ({
												...prev,
												[tab.id]: checked,
											}))
										}
										aria-label={`${visible ? "Hide" : "Show"} the ${tab.label} tab`}
									/>
								)}
							</li>
						);
					})}
				</ul>

				{canEdit && (
					<div className="mt-4 flex justify-end gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={!dirty || saving}
							onClick={() => setDraft(stored)}
						>
							Discard
						</Button>
						<Button
							size="sm"
							disabled={!dirty || saving}
							onClick={() =>
								onSave(
									{ overrides: draft },
									{
										onError: (error) => {
											toast.error(
												"Couldn't save tab visibility",
												{
													description:
														error instanceof Error
															? error.message
															: String(error),
												},
											);
										},
									},
								)
							}
						>
							{saving ? "Saving…" : "Save"}
						</Button>
					</div>
				)}
			</div>
		</Card>
	);
}
