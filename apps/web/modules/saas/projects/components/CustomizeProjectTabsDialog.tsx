"use client";

// Leaf import (not the barrel): client component — the barrel pulls Prisma.
import {
	isProtectedProjectTab,
	type ProjectTabConfig,
	type ProjectTabPrefs,
} from "@repo/database/src/project-tabs";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { cn } from "@ui/lib";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	EyeIcon,
	EyeOffIcon,
	LockIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	isProjectTabFeatureEnabled,
	type ProjectTabMeta,
	resolveAdminTabState,
	useProjectTabGates,
} from "../lib/project-tab-preferences";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	tabs: readonly ProjectTabMeta[];
	config: ProjectTabConfig | null;
	prefs: ProjectTabPrefs | null;
	/**
	 * Persists `{ hidden, order }`. The dialog stays open until the owner
	 * closes it on success, so a failed save never throws the draft away.
	 */
	onSave: (prefs: ProjectTabPrefs) => void;
	saving: boolean;
};

/**
 * Per-user "Customize tabs" dialog (Fizzy card #1837): hide/show tabs within
 * the set the project admin allows, and reorder them. Deliberately NOT
 * drag-on-the-bar — the tab bar already uses mouse drag to scroll, and an
 * explicit up/down control is keyboard-accessible by construction (FR3's
 * "equivalent accessible interaction").
 *
 * Edits are drafted locally and persisted together on "Done", so a failed
 * save leaves both visibility and ordering untouched.
 */
export function CustomizeProjectTabsDialog({
	open,
	onOpenChange,
	tabs,
	config,
	prefs,
	onSave,
	saving,
}: Props) {
	const tabGates = useProjectTabGates();
	const adminState = useMemo(
		() =>
			resolveAdminTabState(
				tabs.map((t) => t.id),
				config,
				tabGates,
			),
		[tabs, config, tabGates],
	);

	const defaultSequence = useMemo(
		() => tabs.filter((t) => adminState[t.id]).map((t) => t.id),
		[tabs, adminState],
	);

	// Draft state: the full visual sequence of admin-visible tab ids, plus the
	// personal hidden set. Tabs stay in the sequence while hidden so showing
	// them again restores their previous position. `saved` mirrors what the
	// draft was seeded FROM — dirty is measured against IT, not against factory
	// defaults, so Reset stays persistable when saved customizations exist
	// (Reset makes the draft equal the defaults, which must still count as a
	// change worth saving).
	const [sequence, setSequence] = useState<string[]>(defaultSequence);
	const [hidden, setHidden] = useState<Set<string>>(new Set());
	const [saved, setSaved] = useState<{
		sequence: string[];
		hidden: Set<string>;
	}>({ sequence: defaultSequence, hidden: new Set() });

	useEffect(() => {
		if (!open) {
			return;
		}
		// Seed from the saved prefs: listed ids first (skipping unknown or
		// no-longer-admin-visible ones), then any remaining defaults appended.
		const listed = (prefs?.order ?? []).filter((id) =>
			defaultSequence.includes(id),
		);
		const uniqueListed = [...new Set(listed)];
		const seededSequence = [
			...uniqueListed,
			...defaultSequence.filter((id) => !uniqueListed.includes(id)),
		];
		const seededHidden = new Set(
			(prefs?.hidden ?? []).filter((id) => defaultSequence.includes(id)),
		);
		setSequence(seededSequence);
		setHidden(seededHidden);
		setSaved({ sequence: seededSequence, hidden: seededHidden });
	}, [open, prefs, defaultSequence]);

	const sameSet = (a: Set<string>, b: Set<string>) =>
		a.size === b.size && [...a].every((id) => b.has(id));
	const dirty =
		sequence.join(" ") !== saved.sequence.join(" ") ||
		!sameSet(hidden, saved.hidden);
	// Reset must also be reachable on a pristine open whenever the SAVED state
	// differs from factory defaults — otherwise "put everything back" is
	// impossible without first making a throwaway edit.
	const savedDiffersFromDefaults =
		saved.sequence.join(" ") !== defaultSequence.join(" ") ||
		saved.hidden.size > 0;

	const move = (id: string, direction: -1 | 1) => {
		setSequence((prev) => {
			const index = prev.indexOf(id);
			const target = index + direction;
			if (index < 0 || target < 0 || target >= prev.length) {
				return prev;
			}
			const next = [...prev];
			next[index] = next[target];
			next[target] = id;
			return next;
		});
	};

	const toggleHidden = (id: string) =>
		setHidden((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});

	const metaById = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);
	const visibleRows = sequence.filter((id) => !hidden.has(id));
	const hiddenRows = sequence.filter((id) => hidden.has(id));
	// Everything an admin turned off project-wide — shown read-only so the
	// dialog explains why a tab someone remembers isn't offered, and where it
	// can be turned back on. A tab this deployment does not offer is NOT in
	// here: `resolveAdminTabState` leaves it out entirely, and listing it
	// would promise an admin toggle that cannot exist.
	const unavailableRows = tabs
		.map((t) => t.id)
		.filter(
			(id) => isProjectTabFeatureEnabled(id, tabGates) && !adminState[id],
		);

	const renderRow = (
		id: string,
		options: { locked?: boolean; hidden?: boolean; unavailable?: boolean },
	) => {
		const meta = metaById.get(id);
		if (!meta) {
			return null;
		}
		const Icon = meta.icon;
		const locked = options.locked || isProtectedProjectTab(id);
		const showIndex = visibleRows.indexOf(id);
		return (
			<li
				key={id}
				className={cn(
					"flex items-center gap-2 rounded-lg px-2 py-1.5",
					options.unavailable && "opacity-50",
				)}
			>
				<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
					<Icon
						aria-hidden="true"
						className="size-4 text-muted-foreground"
					/>
				</span>
				<span className="min-w-0 flex-1 truncate font-medium text-[13px]">
					{meta.label}
				</span>
				{locked ? (
					<span className="flex shrink-0 items-center gap-1 pr-1 text-[11px] text-muted-foreground">
						<LockIcon aria-hidden="true" className="size-3" />
						Always shown
					</span>
				) : options.unavailable ? (
					<span className="pr-1 text-[11px] text-muted-foreground">
						Hidden by project admin
					</span>
				) : (
					<span className="flex shrink-0 items-center gap-0.5">
						{!options.hidden && (
							<>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									disabled={showIndex === 0}
									onClick={() => move(id, -1)}
									aria-label={`Move ${meta.label} earlier`}
								>
									<ChevronUpIcon
										aria-hidden="true"
										className="size-4"
									/>
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									disabled={
										showIndex === visibleRows.length - 1
									}
									onClick={() => move(id, 1)}
									aria-label={`Move ${meta.label} later`}
								>
									<ChevronDownIcon
										aria-hidden="true"
										className="size-4"
									/>
								</Button>
							</>
						)}
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							onClick={() => toggleHidden(id)}
							aria-label={
								options.hidden
									? `Show ${meta.label}`
									: `Hide ${meta.label}`
							}
						>
							{options.hidden ? (
								<EyeIcon
									aria-hidden="true"
									className="size-4"
								/>
							) : (
								<EyeOffIcon
									aria-hidden="true"
									className="size-4"
								/>
							)}
						</Button>
					</span>
				)}
			</li>
		);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Customize tabs</DialogTitle>
					<DialogDescription>
						Choose which tabs you see and in what order — your
						changes apply only to you. Tabs the project admin
						disabled can't be turned back on here.
					</DialogDescription>
				</DialogHeader>

				<div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
					<section>
						<p className="mb-1 px-2 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
							Shown ({visibleRows.length})
						</p>
						<ul>{visibleRows.map((id) => renderRow(id, {}))}</ul>
					</section>

					{hiddenRows.length > 0 && (
						<section>
							<p className="mb-1 px-2 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
								Hidden by you
							</p>
							<ul>
								{hiddenRows.map((id) =>
									renderRow(id, { hidden: true }),
								)}
							</ul>
						</section>
					)}

					{unavailableRows.length > 0 && (
						<section>
							<p className="mb-1 px-2 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
								Unavailable in this project
							</p>
							<p className="mb-1 px-2 text-[11px] text-muted-foreground">
								A project admin can turn these back on in
								Settings → General → Tab visibility.
							</p>
							<ul>
								{unavailableRows.map((id) =>
									renderRow(id, { unavailable: true }),
								)}
							</ul>
						</section>
					)}
				</div>

				<DialogFooter className="mt-2 flex items-center gap-2 sm:justify-between">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={
							(!dirty && !savedDiffersFromDefaults) || saving
						}
						onClick={() => {
							setSequence(defaultSequence);
							setHidden(new Set());
						}}
					>
						Reset
					</Button>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							size="sm"
							disabled={!dirty || saving}
							onClick={() => {
								onSave({
									hidden: [...hidden],
									order: sequence,
								});
							}}
						>
							{saving ? "Saving…" : "Done"}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
