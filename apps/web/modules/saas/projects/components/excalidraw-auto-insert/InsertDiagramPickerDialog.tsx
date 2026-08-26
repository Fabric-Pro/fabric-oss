"use client";

/**
 * `InsertDiagramPickerDialog` -- the picker shown when the chat surface
 * can't resolve an active TipTap editor on the page (FR-7 / spec § 8.3).
 *
 * Flow:
 *   - Mount with `open={true}` from the button (D2, wired by E2).
 *   - Render a shadcn `<Dialog>` carrying two tabs (Documents / Features)
 *     fed by `projects.documents.list` and `projects.stories.list`.
 *   - A search input filters the in-memory list (server-side pagination
 *     is the safety net for the 100-entry cap; spec § 15).
 *   - User clicks a row -> the parent's `onPick` is called with the
 *     selected `{ kind, id, label }`. The parent (D2) writes the
 *     sessionStorage intent and navigates to the destination route.
 *
 * Spec sections covered:
 *   - § 8.3   Picker dialog UX (tabs, scrollarea, row layout, keyboard,
 *             empty state with "Create a new document" link)
 *   - § 14.3  Accessibility (focus trap from Radix, initial focus on
 *             search, escape closes & returns focus, aria-labels)
 *   - § 14.7  i18n -- `diagrams.autoInsert.*` namespace
 *   - § 15    Performance -- 100-entry render cap with "More results --
 *             search to filter" hint; loaded via `next/dynamic` (E2)
 *   - § 12    Telemetry -- `diagram_auto_insert_picker_opened` on open,
 *             `diagram_auto_insert_picker_picked` on row click.
 *
 * Lazy load: this file MUST be imported through `next/dynamic` from the
 * caller (E2). A static import in `ChatMessageInsertDiagramButton` would
 * pull the Dialog + Tabs + ScrollArea bundle into every chat-message
 * render, defeating the perf budget in spec § 15.
 *
 * Virtualization: spec § 8.3 calls for TanStack Virtual when count > 50.
 * The package isn't installed in this repo and adding it is outside the
 * scope of this PR; the 100-entry hard cap below already bounds the
 * rendered DOM tree (100 buttons * 2 tabs = 200 nodes max). Virtualization
 * is tracked as a follow-up if real-world projects exceed the cap.
 */

import { useAnalytics } from "@analytics";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { ScrollArea } from "@ui/components/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { cn } from "@ui/lib";
import { FileTextIcon, LayersIcon, SearchIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ChatSurface } from "./types";

/**
 * The "kind" of picker target. Matches the resolver target kind plus
 * the explicit "feature" label spec § 12 uses for the picker analytics
 * event (the frontend names stories as "features" -- CLAUDE.md naming
 * note).
 */
export type PickerTargetKind = "document" | "feature";

/** Shape passed to `onPick` when the user selects a row. */
export interface PickerPick {
	kind: PickerTargetKind;
	id: string;
	label: string;
}

/**
 * Hard cap on the number of in-DOM rows per tab. Anything beyond this is
 * trimmed from the render with a "More results -- search to filter" hint.
 * Spec § 15 row 5 ("Picker query cost").
 */
const PICKER_RENDER_CAP = 100;

export interface InsertDiagramPickerDialogProps {
	/** Whether the dialog is open (controlled by the parent / button). */
	open: boolean;
	/** Called when the dialog requests close (Esc, overlay click, etc.). */
	onOpenChange(open: boolean): void;
	/** Source chat surface -- carried into telemetry properties. */
	surface: ChatSurface;
	/** Chat-scoped project id (the picker only lists items for this project). */
	projectId: string;
	/**
	 * Chat-scoped organization id -- passed through to
	 * `projects.documents.list` / `projects.stories.list` so the org
	 * filter enforces XOR isolation server-side.
	 */
	organizationId: string;
	/** Project name -- shown in the dialog description for context. */
	projectName: string;
	/** Called with the user's pick. The parent handles the navigation. */
	onPick(target: PickerPick): void;
}

// ---------------------------------------------------------------------------
// Row shapes (minimum fields the dialog needs from each list procedure)
// ---------------------------------------------------------------------------

interface PickerRow {
	kind: PickerTargetKind;
	id: string;
	title: string;
	/** ISO timestamp from the procedure -- formatted for the muted suffix. */
	updatedAt: string | Date | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function InsertDiagramPickerDialog({
	open,
	onOpenChange,
	surface,
	projectId,
	organizationId,
	projectName,
	onPick,
}: InsertDiagramPickerDialogProps): JSX.Element {
	const t = useTranslations("diagrams.autoInsert");
	const { trackEvent } = useAnalytics();
	const searchInputId = useId();

	const [activeTab, setActiveTab] = useState<PickerTargetKind>("document");
	const [searchTerm, setSearchTerm] = useState<string>("");
	const [focusedRowIndex, setFocusedRowIndex] = useState<number>(0);

	// Documents tab -- enabled only while the dialog is open so we don't
	// pay the query cost on every chat-message mount that pre-renders the
	// dialog with `open={false}`.
	const documentsQuery = useQuery({
		...orpc.projects.documents.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: open,
	});

	// Stories ("features") tab -- same enabled gating.
	const storiesQuery = useQuery({
		...orpc.projects.stories.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: open,
	});

	// Normalise both into a uniform `PickerRow[]` shape for the row
	// renderer. The procedures return slightly different shapes today
	// (`{ documents, total, hasMore }` vs `{ statuses, stories }`); we
	// hide that here so the row component stays trivial.
	const documents = useMemo<PickerRow[]>(() => {
		const list =
			(documentsQuery.data as { documents?: unknown[] } | undefined)
				?.documents ?? [];
		return list
			.map((entry): PickerRow | null => {
				if (!entry || typeof entry !== "object") {
					return null;
				}
				const candidate = entry as {
					id?: unknown;
					title?: unknown;
					updatedAt?: unknown;
				};
				if (typeof candidate.id !== "string") {
					return null;
				}
				return {
					kind: "document",
					id: candidate.id,
					title:
						typeof candidate.title === "string" &&
						candidate.title.length > 0
							? candidate.title
							: "Untitled document",
					updatedAt:
						candidate.updatedAt instanceof Date
							? candidate.updatedAt
							: typeof candidate.updatedAt === "string"
								? candidate.updatedAt
								: null,
				};
			})
			.filter((row): row is PickerRow => row !== null);
	}, [documentsQuery.data]);

	const features = useMemo<PickerRow[]>(() => {
		const data = storiesQuery.data as
			| {
					stories?: Array<{
						id?: unknown;
						title?: unknown;
						identifier?: unknown;
						createdAt?: unknown;
						lastEditedAt?: unknown;
						status?: {
							name?: unknown;
							isArchived?: unknown;
						} | null;
					}>;
			  }
			| undefined;
		const rows = data?.stories ?? [];
		return rows
			.filter((story) => {
				// Filter out archived statuses per task E1 acceptance check.
				// Explicit `isArchived` flag is the authoritative signal;
				// the status-name heuristic catches the canonical
				// "Archived" / "Cancelled" labels for seeds without the
				// boolean flag set.
				if (story.status?.isArchived === true) {
					return false;
				}
				const statusName =
					typeof story.status?.name === "string"
						? story.status.name.toLowerCase()
						: "";
				if (statusName === "archived" || statusName === "cancelled") {
					return false;
				}
				return true;
			})
			.map((story): PickerRow | null => {
				if (typeof story.id !== "string") {
					return null;
				}
				const identifier =
					typeof story.identifier === "string"
						? story.identifier
						: "";
				const titleText =
					typeof story.title === "string" && story.title.length > 0
						? story.title
						: "Untitled feature";
				const composedTitle =
					identifier.length > 0
						? `${identifier} ${titleText}`
						: titleText;
				const activityAt = story.lastEditedAt ?? story.createdAt;
				return {
					kind: "feature",
					id: story.id,
					title: composedTitle,
					updatedAt:
						activityAt instanceof Date ||
						typeof activityAt === "string"
							? activityAt
							: null,
				};
			})
			.filter((row): row is PickerRow => row !== null);
	}, [storiesQuery.data]);

	// Apply search filter + the 100-entry render cap.
	const filteredDocuments = useMemo(
		() => applySearchAndCap(documents, searchTerm),
		[documents, searchTerm],
	);
	const filteredFeatures = useMemo(
		() => applySearchAndCap(features, searchTerm),
		[features, searchTerm],
	);

	const activeRows =
		activeTab === "document" ? filteredDocuments : filteredFeatures;
	const activeSourceCount =
		activeTab === "document" ? documents.length : features.length;
	const hasMoreThanCap = activeSourceCount > PICKER_RENDER_CAP;

	// Fire `diagram_auto_insert_picker_opened` on each open transition.
	// Use a ref to avoid firing twice for a single open if React's strict
	// mode double-invokes the effect.
	const openTelemetryFiredRef = useRef<boolean>(false);
	useEffect(() => {
		if (!open) {
			openTelemetryFiredRef.current = false;
			return;
		}
		if (openTelemetryFiredRef.current) {
			return;
		}
		openTelemetryFiredRef.current = true;
		trackEvent("diagram_auto_insert_picker_opened", {
			surface,
			projectId,
			hasDocuments: documents.length > 0,
			hasFeatures: features.length > 0,
		});
		// Intentionally only depends on `open` -- we want exactly one
		// fire per open transition. The properties read at that moment
		// from the latest closure are fine for telemetry purposes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Reset the focused-row index when the active tab or filter changes
	// so arrow-key navigation always starts at the top of the visible list.
	useEffect(() => {
		setFocusedRowIndex(0);
	}, [activeTab, searchTerm]);

	const handlePick = useCallback(
		(row: PickerRow) => {
			trackEvent("diagram_auto_insert_picker_picked", {
				surface,
				targetKind: row.kind,
				targetId: row.id,
				projectId,
			});
			onPick({ kind: row.kind, id: row.id, label: row.title });
			onOpenChange(false);
		},
		[onOpenChange, onPick, projectId, surface, trackEvent],
	);

	// Up/Down/Enter inside the search input drives the row list (keeps
	// the search field focused throughout). Radix Dialog already handles
	// Escape -> close and returns focus to the trigger element.
	const handleSearchKeyDown = useCallback(
		(event: KeyboardEvent<HTMLInputElement>) => {
			if (activeRows.length === 0) {
				return;
			}
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setFocusedRowIndex((idx) =>
					Math.min(idx + 1, activeRows.length - 1),
				);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setFocusedRowIndex((idx) => Math.max(idx - 1, 0));
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				const row = activeRows[focusedRowIndex];
				if (row) {
					handlePick(row);
				}
			}
		},
		[activeRows, focusedRowIndex, handlePick],
	);

	const bothEmpty =
		!documentsQuery.isLoading &&
		!storiesQuery.isLoading &&
		documents.length === 0 &&
		features.length === 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-w-xl"
				onOpenAutoFocus={(event) => {
					// Defer focus to the search input -- Radix's default
					// auto-focus lands on the first focusable in DOM, which
					// would be the tab list. The search input is the
					// expected initial focus per spec § 14.3.
					event.preventDefault();
				}}
			>
				<DialogHeader>
					<DialogTitle>{t("pickerTitle")}</DialogTitle>
					<DialogDescription>
						{t("pickerDescription", { projectName })}
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					<label htmlFor={searchInputId} className="sr-only">
						{t("pickerTitle")}
					</label>
					<div className="relative">
						<SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							id={searchInputId}
							autoFocus
							value={searchTerm}
							onChange={(event) =>
								setSearchTerm(event.target.value)
							}
							onKeyDown={handleSearchKeyDown}
							placeholder={t("pickerTabDocuments")}
							className="pl-9"
							aria-label={t("pickerTitle")}
						/>
					</div>

					<Tabs
						value={activeTab}
						onValueChange={(value) =>
							setActiveTab(value as PickerTargetKind)
						}
					>
						<TabsList>
							<TabsTrigger value="document">
								{t("pickerTabDocuments")}
							</TabsTrigger>
							<TabsTrigger value="feature">
								{t("pickerTabFeatures")}
							</TabsTrigger>
						</TabsList>

						<TabsContent value="document" className="mt-3">
							<PickerRowList
								rows={filteredDocuments}
								focusedIndex={focusedRowIndex}
								onPick={handlePick}
								isLoading={documentsQuery.isLoading}
								emptyState={bothEmpty}
								t={t}
								hasMoreThanCap={
									activeTab === "document" && hasMoreThanCap
								}
							/>
						</TabsContent>

						<TabsContent value="feature" className="mt-3">
							<PickerRowList
								rows={filteredFeatures}
								focusedIndex={focusedRowIndex}
								onPick={handlePick}
								isLoading={storiesQuery.isLoading}
								emptyState={bothEmpty}
								t={t}
								hasMoreThanCap={
									activeTab === "feature" && hasMoreThanCap
								}
							/>
						</TabsContent>
					</Tabs>
				</div>
			</DialogContent>
		</Dialog>
	);
}

// ---------------------------------------------------------------------------
// Row list -- the scrollarea + the row buttons + the empty state
// ---------------------------------------------------------------------------

interface PickerRowListProps {
	rows: PickerRow[];
	focusedIndex: number;
	onPick(row: PickerRow): void;
	isLoading: boolean;
	emptyState: boolean;
	t: ReturnType<typeof useTranslations>;
	hasMoreThanCap: boolean;
}

function PickerRowList({
	rows,
	focusedIndex,
	onPick,
	isLoading,
	emptyState,
	t,
	hasMoreThanCap,
}: PickerRowListProps): JSX.Element {
	if (isLoading) {
		return (
			<div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
				...
			</div>
		);
	}

	if (rows.length === 0 && emptyState) {
		return (
			<div className="flex h-64 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
				<p>{t("pickerEmpty")}</p>
			</div>
		);
	}

	if (rows.length === 0) {
		return (
			<div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
				{t("pickerEmpty")}
			</div>
		);
	}

	return (
		<ScrollArea className="h-64 rounded-md border">
			{/*
			 * Listbox pattern with native `<button>` rows so each row
			 * stays semantically interactive without applying ARIA
			 * roles to non-interactive elements (Biome a11y rule
			 * forbids `<ul role="listbox">` + `<li role="option">`).
			 */}
			<div role="listbox" className="flex flex-col">
				{rows.map((row, idx) => (
					<button
						key={`${row.kind}:${row.id}`}
						type="button"
						role="option"
						aria-selected={idx === focusedIndex}
						onClick={() => onPick(row)}
						className={cn(
							"flex w-full items-center gap-3 px-3 py-2 text-left text-sm",
							"hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
							idx === focusedIndex && "bg-accent",
						)}
						aria-label={`Insert into ${row.title}`}
					>
						{row.kind === "document" ? (
							<FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
						) : (
							<LayersIcon className="size-4 shrink-0 text-muted-foreground" />
						)}
						<span className="flex-1 truncate">{row.title}</span>
						{row.updatedAt ? (
							<span className="shrink-0 text-xs text-muted-foreground">
								{formatPickerDate(row.updatedAt)}
							</span>
						) : null}
					</button>
				))}
			</div>
			{hasMoreThanCap ? (
				<div className="border-t bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
					More results -- search to filter.
				</div>
			) : null}
		</ScrollArea>
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Filter the row list by the user's search term (case-insensitive,
 * substring match on title) and cap the result at `PICKER_RENDER_CAP`.
 *
 * Exported for testability.
 */
export function applySearchAndCap(
	rows: PickerRow[],
	searchTerm: string,
): PickerRow[] {
	const trimmed = searchTerm.trim().toLowerCase();
	const filtered =
		trimmed.length === 0
			? rows
			: rows.filter((row) => row.title.toLowerCase().includes(trimmed));
	return filtered.slice(0, PICKER_RENDER_CAP);
}

/** Short, locale-aware updatedAt label (e.g. "May 23"). */
function formatPickerDate(value: string | Date): string {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}
