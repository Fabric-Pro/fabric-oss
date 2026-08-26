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
 * Saved through `projects.contexts.updateMetadata`.
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
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
}

export function ContextSourceDetailsDialog({
	open,
	onOpenChange,
	projectId,
	contextId,
	sourceName,
	initialSourceType,
	initialAiInstructions,
}: ContextSourceDetailsDialogProps) {
	const t = useTranslations("tooltips.contextSources.sourceDetails");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();

	const [sourceType, setSourceType] = useState(initialSourceType ?? "");
	const [aiInstructions, setAiInstructions] = useState(
		initialAiInstructions ?? "",
	);

	// Re-seed when the dialog opens so edits made elsewhere (or a stale
	// cached row) never show through.
	useEffect(() => {
		if (open) {
			setSourceType(initialSourceType ?? "");
			setAiInstructions(initialAiInstructions ?? "");
		}
	}, [open, initialSourceType, initialAiInstructions]);

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
			}),
		onSuccess: () => {
			toast.success(t("savedToast"));
			queryClient.invalidateQueries({
				queryKey: orpc.projects.contexts.list.queryKey({
					input: { projectId, organizationId },
				}),
			});
			onOpenChange(false);
		},
		onError: (error: unknown) => {
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
