"use client";

/**
 * SourceDetailsDialog — Context Source Type Labeling (Fizzy #1888).
 *
 * One dialog serves EVERY source type (URL, file, text, transcript,
 * integration): a "Type" combobox (six presets suggested, free text allowed)
 * and an optional AI-instructions textarea (500-char limit with live counter).
 * The fields also render inline in the add flows.
 *
 * Owner-agnostic: whoever owns the source supplies a
 * {@link ContextSourceDetailsAdapter} — how to save, which list to update, and
 * how to name the last editor. The save carries the values the dialog opened
 * with as `expected`, so an edit made elsewhere in the meantime (another
 * person, or an agent over MCP) is refused with CONFLICT instead of silently
 * overwritten; the dialog then shows the other version and lets the user
 * decide. When the source has been edited before, the dialog says who last did
 * it and when.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type {
	ContextSourceDetailsAdapter,
	ContextSourceMetadata,
	SavedContextSourceMetadata,
} from "../lib/submit-adapter";

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

// Mirror the server-side limits in `update-context-metadata.ts`.
const MAX_SOURCE_TYPE_LENGTH = 80;
const MAX_INSTRUCTIONS_LENGTH = 500;

export interface SourceDetailsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	adapter: ContextSourceDetailsAdapter;
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

/** The one representation the server stores: trimmed, blank as null. */
function normalizeMetadataValue(value: string | null | undefined) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function sameMetadata(a: ContextSourceMetadata, b: ContextSourceMetadata) {
	return (
		normalizeMetadataValue(a.sourceType) ===
			normalizeMetadataValue(b.sourceType) &&
		normalizeMetadataValue(a.aiInstructions) ===
			normalizeMetadataValue(b.aiInstructions)
	);
}

/**
 * The contexts list with one row's metadata replaced by what a save returned.
 * Written into the cache straight away so that reopening the dialog before
 * the refetch lands starts from the saved values — otherwise the next save
 * would carry the pre-save values as `expected` and be refused as if someone
 * else had changed the source. Anything that is not the list shape passes
 * through untouched.
 */
function withSavedMetadata<T>(old: T, saved: SavedContextSourceMetadata): T {
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
function readConflict(error: unknown): ContextSourceMetadata | null {
	const candidate = error as {
		code?: string;
		data?: { current?: Partial<ContextSourceMetadata> };
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

export function SourceDetailsDialog({
	open,
	onOpenChange,
	adapter,
	contextId,
	sourceName,
	initialSourceType,
	initialAiInstructions,
	initialMetadataUpdatedAt,
	initialMetadataUpdatedByUserId,
}: SourceDetailsDialogProps) {
	const t = useTranslations("tooltips.contextSources.sourceDetails");
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
	const [expected, setExpected] = useState<ContextSourceMetadata>({
		sourceType: initialSourceType,
		aiInstructions: initialAiInstructions,
	});
	const expectedRef = useRef(expected);
	const updateExpected = useCallback((next: ContextSourceMetadata) => {
		expectedRef.current = next;
		setExpected(next);
	}, []);
	const [conflict, setConflict] = useState<ContextSourceMetadata | null>(
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
		const incoming: ContextSourceMetadata = {
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

	const listQueryKey = adapter.listQueryKey;

	const saveMutation = useMutation({
		mutationFn: () =>
			adapter.saveMetadata({
				contextId,
				sourceType: sourceType.trim() ? sourceType.trim() : null,
				aiInstructions: aiInstructions.trim()
					? aiInstructions.trim()
					: null,
				expected,
			}),
		onSuccess: (saved: SavedContextSourceMetadata) => {
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
							useEditorName={adapter.useEditorName}
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
 * The name comes from the owner's `useEditorName` resolver. It mounts only
 * when the dialog is open AND the source carries a stamp, so the resolver's
 * lookup never runs on the list's hot path. While the name is unknown —
 * loading, failed, or an editor the owner cannot name — the line shows the
 * date only rather than guessing.
 */
function ContextSourceLastEdited({
	useEditorName,
	at,
	byUserId,
}: {
	useEditorName: ContextSourceDetailsAdapter["useEditorName"];
	at: Date | string;
	byUserId: string | null;
}) {
	const t = useTranslations("tooltips.contextSources.sourceDetails");
	const format = useFormatter();

	const editorName = useEditorName(byUserId);

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
