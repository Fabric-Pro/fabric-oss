"use client";

// Leaf import (not the barrel): client component — the barrel pulls Prisma.
import {
	isProtectedProjectTab,
	type ProjectTabConfig,
	type ProjectTabDisplay,
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
import { ChevronDownIcon, ChevronUpIcon, LockIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
	 * Persists `{ hidden, order, display }`. The dialog stays open until the
	 * owner closes it on success, so a failed save never throws the draft away.
	 */
	onSave: (prefs: ProjectTabPrefs) => void;
	saving: boolean;
};

/** What one tab paints. Both false is how this dialog spells "hidden". */
type Paint = { icon: boolean; title: boolean };

const BOTH: Paint = { icon: true, title: true };

/**
 * Per-user "Customize tabs" dialog (Fizzy card #1837).
 *
 * Each tab carries two toggles, Icon and Title. Both on is the default and
 * needs nothing stored. Turning one off narrows how that tab paints; turning
 * both off is how the viewer hides it, which is why there is no separate hide
 * control — one state, one way to reach it.
 *
 * Reordering uses explicit up/down buttons rather than drag: the tab bar
 * already uses mouse drag to scroll, and up/down is keyboard-accessible by
 * construction.
 *
 * Edits draft locally and persist together on "Done", so a failed save leaves
 * visibility, ordering and paint untouched.
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

	// Draft state: the visual sequence of admin-visible tab ids, plus what each
	// paints. Hidden tabs stay in the sequence so turning a toggle back on
	// restores their position. `saved` mirrors what the draft was seeded FROM,
	// so dirty is measured against IT rather than against factory defaults —
	// that keeps Reset persistable when saved customizations exist.
	const [sequence, setSequence] = useState<string[]>(defaultSequence);
	const [paint, setPaint] = useState<Record<string, Paint>>({});
	const [saved, setSaved] = useState<{
		sequence: string[];
		paint: Record<string, Paint>;
	}>({ sequence: defaultSequence, paint: {} });

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
		const seededPaint: Record<string, Paint> = {};
		for (const [id, mode] of Object.entries(prefs?.display ?? {})) {
			if (defaultSequence.includes(id)) {
				seededPaint[id] = {
					icon: mode !== "title",
					title: mode !== "icon",
				};
			}
		}
		// `hidden` outranks `display`: it is the list every other surface reads
		// (deep-link fallback, Get Started), so a tab in it is both-off here
		// whatever a stale display entry says.
		for (const id of prefs?.hidden ?? []) {
			if (defaultSequence.includes(id)) {
				seededPaint[id] = { icon: false, title: false };
			}
		}
		setSequence(seededSequence);
		setPaint(seededPaint);
		setSaved({ sequence: seededSequence, paint: seededPaint });
	}, [open, prefs, defaultSequence]);

	const paintOf = (map: Record<string, Paint>, id: string): Paint =>
		map[id] ?? BOTH;
	const serialize = (seq: string[], map: Record<string, Paint>) =>
		seq
			.map((id) => {
				const p = paintOf(map, id);
				return `${id}:${p.icon ? 1 : 0}${p.title ? 1 : 0}`;
			})
			.join(" ");

	const draftKey = serialize(sequence, paint);
	const dirty = draftKey !== serialize(saved.sequence, saved.paint);
	// Reset must also be reachable on a pristine open whenever the SAVED state
	// differs from factory defaults — otherwise "put everything back" is
	// impossible without first making a throwaway edit.
	const savedDiffersFromDefaults =
		serialize(saved.sequence, saved.paint) !==
		serialize(defaultSequence, {});

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

	// Toggling the last remaining half moves the row into another section, and
	// React cannot carry a DOM node across two <ul> parents — the button the
	// viewer just pressed unmounts and focus falls to the dialog. Remember which
	// toggle was pressed and put focus back on its new node.
	const toggleRefs = useRef(new Map<string, HTMLButtonElement>());
	const [refocus, setRefocus] = useState<string | null>(null);

	const togglePaint = (id: string, part: keyof Paint) => {
		setRefocus(`${id}:${part}`);
		setPaint((prev) => {
			const current = paintOf(prev, id);
			return {
				...prev,
				[id]: { ...current, [part]: !current[part] },
			};
		});
	};

	// `draftKey` is in the deps as the trigger, not as a value read here: it
	// changes on the render that remounted the row, which is exactly when the
	// new node exists to receive focus.
	useEffect(() => {
		if (!refocus) {
			return;
		}
		toggleRefs.current.get(refocus)?.focus();
		setRefocus(null);
	}, [refocus, draftKey]);

	const metaById = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);
	const isShown = (id: string) => {
		const p = paintOf(paint, id);
		return p.icon || p.title;
	};
	const visibleRows = sequence.filter(isShown);
	const hiddenRows = sequence.filter((id) => !isShown(id));
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

	const renderPaintToggle = (
		id: string,
		part: keyof Paint,
		label: string,
		tabLabel: string,
		disabled: boolean,
	) => {
		const on = paintOf(paint, id)[part];
		return (
			<button
				type="button"
				ref={(el) => {
					const key = `${id}:${part}`;
					if (el) {
						toggleRefs.current.set(key, el);
					} else {
						toggleRefs.current.delete(key);
					}
				}}
				aria-pressed={on}
				disabled={disabled}
				onClick={() => togglePaint(id, part)}
				aria-label={`${on ? "Hide" : "Show"} the ${tabLabel} ${part}`}
				title={
					disabled
						? `${tabLabel} is always shown, so it needs its icon or its title`
						: undefined
				}
				className={cn(
					"rounded-md border px-2 py-1 font-medium text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
					on
						? "border-primary/30 bg-primary/10 text-foreground"
						: "border-border/60 text-muted-foreground hover:text-foreground",
				)}
			>
				{label}
			</button>
		);
	};

	const renderRow = (
		id: string,
		options: { hidden?: boolean; unavailable?: boolean },
	) => {
		const meta = metaById.get(id);
		if (!meta) {
			return null;
		}
		const Icon = meta.icon;
		const protectedTab = isProtectedProjectTab(id);
		const showIndex = visibleRows.indexOf(id);
		const current = paintOf(paint, id);
		return (
			<li
				key={id}
				className={cn(
					"flex items-center gap-2 rounded-lg px-2 py-1.5",
					options.unavailable && "opacity-50",
				)}
			>
				{/* Only the tab's own icon and name dim when it is hidden. The
				    toggles stay at full strength because they are the way back,
				    and dimming them would read like the inert admin-disabled
				    rows further down. */}
				<span
					className={cn(
						"flex size-7 shrink-0 items-center justify-center rounded-md bg-muted",
						options.hidden && "opacity-50",
					)}
				>
					<Icon
						aria-hidden="true"
						className="size-4 text-muted-foreground"
					/>
				</span>
				<span
					className={cn(
						"min-w-0 flex-1 truncate font-medium text-[13px]",
						options.hidden && "opacity-50",
					)}
				>
					{meta.label}
				</span>
				{options.unavailable ? (
					<span className="pr-1 text-[11px] text-muted-foreground">
						Hidden by project admin
					</span>
				) : (
					<span className="flex shrink-0 items-center gap-1">
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
						{/* A protected tab cannot be hidden, so its last
						    remaining toggle is disabled rather than allowed to
						    reach the both-off state the API would reject. */}
						{renderPaintToggle(
							id,
							"icon",
							"Icon",
							meta.label,
							protectedTab && current.icon && !current.title,
						)}
						{renderPaintToggle(
							id,
							"title",
							"Title",
							meta.label,
							protectedTab && current.title && !current.icon,
						)}
						{protectedTab && (
							<span className="flex shrink-0 items-center gap-1 pl-0.5 text-[11px] text-muted-foreground">
								<LockIcon
									aria-hidden="true"
									className="size-3"
								/>
								Always shown
							</span>
						)}
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
						Pick what each tab shows and the order they run in —
						your changes apply only to you. Turn off both Icon and
						Title to hide a tab. Tabs the project admin disabled
						can't be turned back on here.
					</DialogDescription>
				</DialogHeader>

				<div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
					<section>
						<p className="mb-1 px-2 font-medium text-[10.5px] text-muted-foreground uppercase tracking-[0.12em]">
							Shown ({visibleRows.length})
						</p>
						<ul>{visibleRows.map((id) => renderRow(id, {}))}</ul>
					</section>

					{hiddenRows.length > 0 && (
						<section>
							<p className="mb-1 px-2 font-medium text-[10.5px] text-muted-foreground uppercase tracking-[0.12em]">
								Hidden by you
							</p>
							<p className="mb-1 px-2 text-[11px] text-muted-foreground">
								Turn Icon or Title back on to bring one back.
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
							<p className="mb-1 px-2 font-medium text-[10.5px] text-muted-foreground uppercase tracking-[0.12em]">
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
							setPaint({});
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
								const display: Record<
									string,
									ProjectTabDisplay
								> = {};
								for (const id of visibleRows) {
									const p = paintOf(paint, id);
									if (!p.title) {
										display[id] = "icon";
									} else if (!p.icon) {
										display[id] = "title";
									}
								}
								onSave({
									hidden: hiddenRows,
									order: sequence,
									display,
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
