"use client";

/**
 * ContextSummaryEditor — the manual-edit form body for a project's current
 * context summary. The parent mounts this inside a `<Dialog>`; this component
 * owns only the form (textarea + reference picker + footer actions), never its
 * own dialog chrome.
 *
 * References are added by picking a citable source from the popover; a new `[S#]`
 * marker is appended to the content and a matching reference is tracked locally.
 * The server re-sanitizes on save (dropping markers not in the content and
 * sources that don't exist), so the client only needs to send what it has.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import { QuoteIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import type { SummaryReference } from "./ContextSummaryMarkdown";

type SummaryCandidate = {
	sourceType: string;
	sourceId: string;
	label: string;
	timestamp: string;
};

type SummaryGroupKey = "context" | "decisions" | "roadmap" | "codeRepo";

const GROUP_ORDER: SummaryGroupKey[] = [
	"context",
	"decisions",
	"roadmap",
	"codeRepo",
];

const CONTENT_FIELD_ID = "context-summary-editor-content";

function groupForSource(sourceType: string): SummaryGroupKey {
	switch (sourceType) {
		case "DECISION":
			return "decisions";
		case "ROADMAP":
			return "roadmap";
		case "CODE_REPO":
			return "codeRepo";
		default:
			return "context";
	}
}

/** Next free `S#` marker: 1 + the max N across existing refs and `[S#]` in text. */
function nextMarker(references: SummaryReference[], content: string): string {
	let max = 0;
	for (const ref of references) {
		const parsed = /^S(\d+)$/.exec(ref.marker);
		if (parsed) {
			max = Math.max(max, Number.parseInt(parsed[1], 10));
		}
	}
	for (const match of content.matchAll(/\[S(\d+)\]/g)) {
		max = Math.max(max, Number.parseInt(match[1], 10));
	}
	return `S${max + 1}`;
}

type Props = {
	projectId: string;
	organizationId: string | null;
	summaryId: string;
	initialContent: string;
	initialReferences: SummaryReference[];
	onSaved: () => void;
	onCancel: () => void;
};

export function ContextSummaryEditor({
	projectId,
	organizationId,
	summaryId,
	initialContent,
	initialReferences,
	onSaved,
	onCancel,
}: Props) {
	const t = useTranslations("projects.contextSummary");

	const [content, setContent] = useState(initialContent);
	const [references, setReferences] =
		useState<SummaryReference[]>(initialReferences);
	const [pickerOpen, setPickerOpen] = useState(false);

	const sourcesQuery = useQuery(
		orpc.projects.contexts.summarySources.queryOptions({
			input: { projectId, organizationId },
			enabled: pickerOpen,
		}),
	);

	const saveMutation = useMutation({
		mutationFn: () =>
			orpc.projects.contexts.updateSummary.call({
				projectId,
				summaryId,
				content,
				references,
				organizationId,
			}),
		onSuccess: () => {
			toast.success(t("editor.saved"));
			onSaved();
		},
		onError: () => {
			toast.error(t("editor.error"));
		},
	});

	const insertReference = (candidate: SummaryCandidate) => {
		const marker = nextMarker(references, content);
		setContent((current) => `${current} [${marker}]`);
		setReferences((current) => [
			...current,
			{
				marker,
				sourceType: candidate.sourceType,
				sourceId: candidate.sourceId,
				sourceTimestamp: candidate.timestamp,
				label: candidate.label,
			},
		]);
		setPickerOpen(false);
	};

	const candidates = sourcesQuery.data?.candidates ?? [];
	const grouped = GROUP_ORDER.map((key) => ({
		key,
		items: candidates.filter(
			(candidate) => groupForSource(candidate.sourceType) === key,
		),
	})).filter((group) => group.items.length > 0);

	const isEmpty = content.trim().length === 0;
	const activeReferenceCount = references.filter((ref) =>
		content.includes(`[${ref.marker}]`),
	).length;

	return (
		<div className="space-y-4">
			<div className="space-y-1.5">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<Label htmlFor={CONTENT_FIELD_ID}>
						{t("editor.contentLabel")}
					</Label>

					<Popover open={pickerOpen} onOpenChange={setPickerOpen}>
						<PopoverTrigger asChild>
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="gap-2"
							>
								<QuoteIcon
									className="size-4"
									aria-hidden="true"
								/>
								{t("editor.insertReference")}
							</Button>
						</PopoverTrigger>
						<PopoverContent
							align="end"
							className="w-80 max-w-[min(90vw,20rem)] p-0"
						>
							<Command>
								<CommandInput
									placeholder={t(
										"editor.referencePickerPlaceholder",
									)}
								/>
								<CommandList>
									{sourcesQuery.isLoading ? (
										<div className="space-y-2 p-3">
											<Skeleton className="h-6 w-full" />
											<Skeleton className="h-6 w-3/4" />
										</div>
									) : (
										<>
											<CommandEmpty>
												{t("editor.noSources")}
											</CommandEmpty>
											{grouped.map((group) => (
												<CommandGroup
													key={group.key}
													heading={t(
														`editor.groups.${group.key}`,
													)}
												>
													{group.items.map(
														(candidate) => (
															<CommandItem
																key={`${candidate.sourceType}:${candidate.sourceId}`}
																value={`${candidate.label} ${candidate.sourceId}`}
																onSelect={() =>
																	insertReference(
																		candidate,
																	)
																}
															>
																<span className="truncate">
																	{
																		candidate.label
																	}
																</span>
															</CommandItem>
														),
													)}
												</CommandGroup>
											))}
										</>
									)}
								</CommandList>
							</Command>
						</PopoverContent>
					</Popover>
				</div>

				<p className="text-muted-foreground text-sm">
					{t("editor.description")}
				</p>
			</div>

			<Textarea
				id={CONTENT_FIELD_ID}
				value={content}
				onChange={(event) => setContent(event.target.value)}
				className="min-h-[50vh] font-mono text-sm"
				aria-invalid={isEmpty}
			/>

			{isEmpty && (
				<p role="alert" className="text-destructive text-sm">
					{t("editor.empty")}
				</p>
			)}

			<div className="flex flex-wrap items-center justify-between gap-3 border-border border-t pt-4">
				<p className="text-muted-foreground text-xs">
					{t("editor.referencesNote", {
						count: activeReferenceCount,
					})}
				</p>
				<div className="flex items-center gap-2">
					<Button type="button" variant="outline" onClick={onCancel}>
						{t("editor.cancel")}
					</Button>
					<Button
						type="button"
						onClick={() => saveMutation.mutate()}
						disabled={isEmpty || saveMutation.isPending}
					>
						{saveMutation.isPending
							? t("editor.saving")
							: t("editor.save")}
					</Button>
				</div>
			</div>
		</div>
	);
}
