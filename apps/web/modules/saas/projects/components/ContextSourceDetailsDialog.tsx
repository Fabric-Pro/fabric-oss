"use client";

/**
 * ContextSourceDetailsDialog — Context Source Type Labeling (Fizzy #1888).
 *
 * One dialog serves EVERY source type (URL, file, text, transcript,
 * integration): a "Type" combobox (six presets suggested, free text allowed)
 * and an optional AI-instructions textarea (500-char limit with live counter).
 * Opened from each context card's menu via {@link EditSourceDetailsMenuItem};
 * the fields also render inline in the add flows.
 *
 * Saved through `projects.contexts.updateMetadata`, which also backs the
 * `fabric_update_project_context` MCP tool. The save carries the values the
 * dialog opened with as `expected`, so an edit made elsewhere in the meantime
 * (another person, or an agent over MCP) is refused with CONFLICT instead of
 * silently overwritten; the dialog then shows the other version and lets the
 * user decide. When the source has been edited before, the dialog says who
 * last did it and when.
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { DropdownMenuItem } from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { Settings2Icon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

/** Application-global preset labels (org-level lists are out of scope for
 * v1). Free-text custom entries are stored verbatim alongside these. */
export const CONTEXT_SOURCE_TYPE_PRESETS = [
	"Client Chat",
	"Architect Chat",
	"QA Thread",
	"Knowledge Base",
	"SDK Docs",
	"Meeting Transcript",
] as const;

const MAX_SOURCE_TYPE_LENGTH = 80;
const MAX_INSTRUCTIONS_LENGTH = 500;

interface ContextSourceDetailsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	contextId: string;
	/** Card title, shown in the dialog header so the user knows which
	 * source they are annotating. Optional — some call sites don't have a
	 * human-readable name. */
	sourceName?: string;
	initialSourceType: string | null;
	initialAiInstructions: string | null;
	/** When `sourceType` / `aiInstructions` were last edited, and by whom —
	 * the row's `metadataUpdatedAt` / `metadataUpdatedByUserId`. Absent for a
	 * source nobody has edited since those were recorded. */
	initialMetadataUpdatedAt?: Date | string | null;
	initialMetadataUpdatedByUserId?: string | null;
}

interface ContextMetadataValues {
	sourceType: string | null;
	aiInstructions: string | null;
}

/** The one representation the server stores: trimmed, blank as null. */
function normalizeMetadataValue(value: string | null | undefined) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function sameMetadata(a: ContextMetadataValues, b: ContextMetadataValues) {
	return (
		normalizeMetadataValue(a.sourceType) ===
			normalizeMetadataValue(b.sourceType) &&
		normalizeMetadataValue(a.aiInstructions) ===
			normalizeMetadataValue(b.aiInstructions)
	);
}

/** What `projects.contexts.updateMetadata` returns for a save. */
interface SavedContextMetadata extends ContextMetadataValues {
	contextId: string;
	metadataUpdatedAt?: Date | string | null;
	metadataUpdatedByUserId?: string | null;
}

/**
 * The contexts list with one row's metadata replaced by what a save returned.
 * Written into the cache straight away so that reopening the dialog before
 * the refetch lands starts from the saved values — otherwise the next save
 * would carry the pre-save values as `expected` and be refused as if someone
 * else had changed the source. Anything that is not the list shape passes
 * through untouched.
 */
function withSavedMetadata<T>(old: T, saved: SavedContextMetadata): T {
	const list = old as { contexts?: unknown } | undefined;
	if (!list || !Array.isArray(list.contexts)) {
		return old;
	}
	return {
		...list,
		contexts: (list.contexts as Array<{ id?: string }>).map((ctx) =>
			ctx.id === saved.contextId
				? {
						...ctx,
						sourceType: saved.sourceType,
						aiInstructions: saved.aiInstructions,
						metadataUpdatedAt: saved.metadataUpdatedAt ?? null,
						metadataUpdatedByUserId:
							saved.metadataUpdatedByUserId ?? null,
					}
				: ctx,
		),
	} as T;
}

/** The server's CONFLICT for a stale save, with the values now stored. */
function readConflict(error: unknown): ContextMetadataValues | null {
	const candidate = error as {
		code?: string;
		data?: { current?: Partial<ContextMetadataValues> };
	} | null;
	if (candidate?.code !== "CONFLICT") {
		return null;
	}
	const current = candidate.data?.current;
	return {
		sourceType: current?.sourceType ?? null,
		aiInstructions: current?.aiInstructions ?? null,
	};
}

export function ContextSourceDetailsDialog({
	open,
	onOpenChange,
	projectId,
	contextId,
	sourceName,
	initialSourceType,
	initialAiInstructions,
	initialMetadataUpdatedAt,
	initialMetadataUpdatedByUserId,
}: ContextSourceDetailsDialogProps) {
	const t = useTranslations("tooltips.contextSources.sourceDetails");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();

	const [sourceType, setSourceType] = useState(initialSourceType ?? "");
	const [aiInstructions, setAiInstructions] = useState(
		initialAiInstructions ?? "",
	);
	// What the save claims to be replacing — the compare-and-swap the server
	// checks. The values the dialog opened with, until newer ones reach the
	// user: a CONFLICT's current values, or a list refetch that changed them.
	// Mirrored in a ref so the effect below can compare against it without
	// re-running every time it moves.
	const [expected, setExpected] = useState<ContextMetadataValues>({
		sourceType: initialSourceType,
		aiInstructions: initialAiInstructions,
	});
	const expectedRef = useRef(expected);
	const updateExpected = useCallback((next: ContextMetadataValues) => {
		expectedRef.current = next;
		setExpected(next);
	}, []);
	const [conflict, setConflict] = useState<ContextMetadataValues | null>(
		null,
	);

	// Fill the fields ONLY when the dialog opens. A caller may feed live list
	// values (the link card does), and the list refetches while the dialog is
	// open — every 2s during a crawl, and on window focus. Re-filling on every
	// prop change would overwrite what the user is typing. Instead, a change
	// that arrives while open and differs from `expected` is someone else's
	// save: show it as the conflict notice, leave the fields alone, and make
	// it the baseline so Save is an informed overwrite.
	const wasOpenRef = useRef(false);
	useEffect(() => {
		const justOpened = open && !wasOpenRef.current;
		wasOpenRef.current = open;
		if (!open) {
			return;
		}
		const incoming: ContextMetadataValues = {
			sourceType: initialSourceType,
			aiInstructions: initialAiInstructions,
		};
		if (justOpened) {
			setSourceType(initialSourceType ?? "");
			setAiInstructions(initialAiInstructions ?? "");
			updateExpected(incoming);
			setConflict(null);
			return;
		}
		if (!sameMetadata(incoming, expectedRef.current)) {
			updateExpected(incoming);
			setConflict(incoming);
		}
	}, [open, initialSourceType, initialAiInstructions, updateExpected]);

	const listQueryKey = orpc.projects.contexts.list.queryKey({
		input: { projectId, organizationId },
	});

	const saveMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.contexts.updateMetadata({
				contextId,
				projectId,
				organizationId,
				sourceType: sourceType.trim() ? sourceType.trim() : null,
				aiInstructions: aiInstructions.trim()
					? aiInstructions.trim()
					: null,
				expected,
			}),
		onSuccess: (saved: SavedContextMetadata) => {
			toast.success(t("savedToast"));
			// The saved values are the baseline now, so the list update below
			// can never read as someone else's change, even if it reaches
			// this dialog before it has closed.
			updateExpected({
				sourceType: saved.sourceType,
				aiInstructions: saved.aiInstructions,
			});
			onOpenChange(false);
			queryClient.setQueryData(listQueryKey, (old) =>
				withSavedMetadata(old, saved),
			);
			queryClient.invalidateQueries({ queryKey: listQueryKey });
		},
		onError: (error: unknown) => {
			const current = readConflict(error);
			if (current) {
				// Someone else saved first. Keep the user's text in the
				// fields, show the other version, and make it the new
				// baseline: saving again is now an informed overwrite, and
				// Cancel keeps theirs. The list is refetched so the card
				// behind the dialog shows the stored values; that refetch
				// equals the new baseline, so the fill-on-open effect leaves
				// the fields and this notice alone. (Realtime does not cover
				// this: a `context_change` event refetches `projects.get`,
				// not the contexts list.)
				setConflict(current);
				updateExpected(current);
				queryClient.invalidateQueries({ queryKey: listQueryKey });
				return;
			}
			setConflict(null);
			toast.error(
				error instanceof Error ? error.message : t("errorFallback"),
			);
		},
	});

	const listId = `context-source-type-presets-${contextId}`;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("dialogTitle")}</DialogTitle>
					<DialogDescription>
						{sourceName ? `${sourceName} — ` : ""}
						{t("description")}
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-4 py-2">
					{conflict ? (
						<Alert
							variant="warning"
							data-testid="context-source-details-conflict"
						>
							<AlertDescription>
								{t("conflict", {
									sourceType:
										conflict.sourceType ??
										t("conflictEmpty"),
									aiInstructions:
										conflict.aiInstructions ??
										t("conflictEmpty"),
								})}
							</AlertDescription>
						</Alert>
					) : null}

					<div className="grid gap-2">
						<Label htmlFor={`${contextId}-source-type`}>
							{t("typeLabel")}
						</Label>
						<Input
							id={`${contextId}-source-type`}
							value={sourceType}
							onChange={(e) => setSourceType(e.target.value)}
							maxLength={MAX_SOURCE_TYPE_LENGTH}
							placeholder={t("typePlaceholder")}
							list={listId}
							autoComplete="off"
						/>
						<datalist id={listId}>
							{CONTEXT_SOURCE_TYPE_PRESETS.map((preset) => (
								<option key={preset} value={preset} />
							))}
						</datalist>
						<p className="text-muted-foreground text-xs">
							{t("typeHelp")}
						</p>
					</div>

					<div className="grid gap-2">
						<div className="flex items-center justify-between">
							<Label htmlFor={`${contextId}-ai-instructions`}>
								{t("instructionsLabel")}
							</Label>
							<span
								id={`${contextId}-ai-instructions-count`}
								className={`text-xs ${aiInstructions.length >= MAX_INSTRUCTIONS_LENGTH ? "text-highlight" : "text-muted-foreground"}`}
								data-testid="context-instructions-char-count"
							>
								{t("charCount", {
									count: aiInstructions.length,
									max: MAX_INSTRUCTIONS_LENGTH,
								})}
							</span>
						</div>
						<Textarea
							id={`${contextId}-ai-instructions`}
							value={aiInstructions}
							onChange={(e) => setAiInstructions(e.target.value)}
							maxLength={MAX_INSTRUCTIONS_LENGTH}
							rows={4}
							placeholder={t("instructionsPlaceholder")}
							aria-describedby={`${contextId}-ai-instructions-count`}
						/>
						<p className="text-muted-foreground text-xs">
							{t("instructionsHelp")}
						</p>
					</div>

					{initialMetadataUpdatedAt ? (
						<ContextSourceLastEdited
							projectId={projectId}
							organizationId={organizationId}
							at={initialMetadataUpdatedAt}
							byUserId={initialMetadataUpdatedByUserId ?? null}
						/>
					) : null}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						{t("cancel")}
					</Button>
					<Button
						type="button"
						onClick={() => saveMutation.mutate()}
						disabled={saveMutation.isPending}
					>
						{saveMutation.isPending ? t("saving") : t("save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * "Last edited by <name> on <date>" for a source's metadata.
 *
 * The name comes from `projects.members.list` — the same lazy, session-cached
 * lookup the feature details popover uses (`StoryDetailsButton`) — rather than
 * a join on the context list, which would cost every Context tab load a user
 * query for a line only this dialog shows. It mounts only when the dialog is
 * open AND the source carries a stamp, so the members request fires at most
 * once per project per session and never on the list's hot path.
 *
 * The member list covers the project owner and its project members. An editor
 * whose access comes from an organization role alone is not in it; for them,
 * and while the lookup is loading or if it fails, the line shows the date
 * only rather than guessing a name.
 */
function ContextSourceLastEdited({
	projectId,
	organizationId,
	at,
	byUserId,
}: {
	projectId: string;
	organizationId: string | null;
	at: Date | string;
	byUserId: string | null;
}) {
	const t = useTranslations("tooltips.contextSources.sourceDetails");
	const format = useFormatter();

	const { data: membersData } = useQuery({
		...orpc.projects.members.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: Boolean(byUserId),
		staleTime: Number.POSITIVE_INFINITY,
	});

	const editorName = useMemo(() => {
		if (!byUserId) {
			return null;
		}
		const member = membersData?.members?.find(
			(m: { userId?: string }) => m.userId === byUserId,
		) as { user?: { name?: string | null } } | undefined;
		return member?.user?.name || null;
	}, [membersData, byUserId]);

	const date = format.dateTime(new Date(at), { dateStyle: "medium" });

	return (
		<p
			className="text-muted-foreground text-xs"
			data-testid="context-source-last-edited"
		>
			{editorName
				? t("lastEditedBy", { name: editorName, date })
				: t("lastEdited", { date })}
		</p>
	);
}

/** Dropdown-menu item that OPENS the details dialog. Deliberately does NOT
 * own the dialog: Radix unmounts everything inside DropdownMenuContent when
 * the menu closes, so a dialog rendered here dies before it can show. The
 * caller owns a single `<ContextSourceDetailsDialog>` OUTSIDE the menu and
 * flips it from {@link onOpen}. */
export function EditSourceDetailsMenuItem({
	testId,
	onOpen,
}: {
	testId?: string;
	onOpen: () => void;
}) {
	const t = useTranslations("tooltips.contextSources.sourceDetails");

	return (
		<DropdownMenuItem
			onSelect={() => {
				// Let Radix close the menu and restore focus to the trigger;
				// the dialog lives outside the menu tree (see above), so
				// closing costs nothing and prevents a stranded open menu.
				onOpen();
			}}
			data-testid={testId ?? "context-edit-details"}
		>
			<Settings2Icon className="mr-2 size-4" aria-hidden="true" />
			{t("editMenuItem")}
		</DropdownMenuItem>
	);
}

/** Small chip shown on context cards when the source carries a type label. */
function SourceTypeChip({ label }: { label: string }) {
	return (
		<span
			className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground text-[11px]"
			data-testid="context-source-type-chip"
		>
			{label}
		</span>
	);
}

/** Card-list display for a source's metadata (Fizzy #1888 FR3): the type
 * chip plus the instructions truncated to one line (full text on hover).
 * Renders nothing for unannotated sources, so existing cards are
 * pixel-identical. Span-rooted so it can sit inline beside a row title. */
export function ContextSourceMetaLine({
	sourceType,
	aiInstructions,
}: {
	sourceType?: string | null;
	aiInstructions?: string | null;
}) {
	if (!sourceType && !aiInstructions) {
		return null;
	}
	return (
		<span className="flex flex-wrap items-center gap-1.5">
			{sourceType ? <SourceTypeChip label={sourceType} /> : null}
			{aiInstructions ? (
				<span
					className="max-w-full truncate text-[11px] text-muted-foreground italic"
					title={aiInstructions}
				>
					{aiInstructions}
				</span>
			) : null}
		</span>
	);
}
