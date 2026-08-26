"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import { ChevronRightIcon, Loader2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { ComposedContentPreview } from "./ComposedContentPreview";
import type {
	PmFieldCatalogEntry,
	SelectedField,
} from "./field-mapping-helpers";
import { getOrpcCode } from "./orpc-error";

type PreviewField = {
	id: string;
	displayName: string;
	value: string | null;
	isEmpty: boolean;
	renderedPreview: string;
};

type FieldSuggestion = {
	id: string;
	label: string;
	controlType?: string;
	isContentControl: boolean;
	populatedOnExample: boolean;
	charCount: number;
	examplePreview: string;
	score: number;
};

type Props = {
	projectId: string;
	catalog: PmFieldCatalogEntry[];
	selected: SelectedField[];
	onAddFields: (fields: SelectedField[]) => void;
};

/**
 * A field catalog runs to several hundred entries on a mature process, and the
 * display names give no hint which ones carry the story — so the primary path
 * here is "suggest": the admin names ONE representative ticket, and the server
 * samples recent items of that same type and ranks fields by how consistently
 * they hold content. "Preview" stays available to spot-check what the currently
 * selected fields hold on that same ticket. Both are on-demand, never cached.
 */
export function ExampleTicketPreview({
	projectId,
	catalog,
	selected,
	onAddFields,
}: Props) {
	const [ticket, setTicket] = useState("");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	// Friendly-name lookup: the procedure echoes `id` into `displayName`, so we
	// substitute the catalog `name` we already hold before rendering.
	const nameByRef = useMemo(
		() => new Map(catalog.map((f) => [f.referenceName, f.name])),
		[catalog],
	);

	const preview = useMutation({
		mutationFn: async (workItemId: string) => {
			const fieldIds = selected.map((f) => f.id);
			return orpcClient.projects.pm.previewTicketFields({
				projectId,
				workItemId,
				fieldIds: fieldIds.length > 0 ? fieldIds : undefined,
			});
		},
		onError: (error) => {
			const code = getOrpcCode(error);
			if (code === "NOT_FOUND") {
				setErrorMessage(
					`Couldn't load ticket #${ticket.trim()}. Check the number and your access.`,
				);
			} else {
				setErrorMessage(
					error instanceof Error
						? error.message
						: "Couldn't load ticket field values.",
				);
			}
		},
	});

	const suggest = useMutation({
		mutationFn: async (workItemId: string) =>
			orpcClient.projects.pm.suggestFieldMapping({
				projectId,
				exampleWorkItemId: workItemId,
			}),
		onError: (error) => {
			const code = getOrpcCode(error);
			setErrorMessage(
				code === "NOT_FOUND"
					? `Couldn't load ticket #${ticket.trim()}. Check the number and your access.`
					: error instanceof Error
						? error.message
						: "Couldn't suggest fields from that ticket.",
			);
		},
	});

	const handleSubmit = () => {
		const trimmed = ticket.trim();
		if (!trimmed) {
			return;
		}
		setErrorMessage(null);
		preview.mutate(trimmed);
	};

	const handleSuggest = () => {
		const trimmed = ticket.trim();
		if (!trimmed) {
			return;
		}
		setErrorMessage(null);
		suggest.mutate(trimmed);
	};

	const results: PreviewField[] = preview.data?.fields ?? [];
	const allSuggestions: FieldSuggestion[] = suggest.data?.suggestions ?? [];
	const fromForm = suggest.data?.source === "form";

	// Search across the VALUE as well as the names. An admin looking at the work
	// item knows the text they can see far better than any identifier, and on a
	// classic process the on-screen heading is a group label that matches neither
	// the reference name nor the catalogued name.
	const [valueQuery, setValueQuery] = useState("");
	const suggestions = useMemo(() => {
		const q = valueQuery.trim().toLowerCase();
		if (!q) {
			return allSuggestions;
		}
		return allSuggestions.filter(
			(s) =>
				s.label.toLowerCase().includes(q) ||
				s.id.toLowerCase().includes(q) ||
				s.examplePreview.toLowerCase().includes(q),
		);
	}, [allSuggestions, valueQuery]);
	const selectedIds = useMemo(
		() => new Set(selected.map((f) => f.id)),
		[selected],
	);

	/**
	 * "Confident" = long-form text present on at least half the sampled items of
	 * this type. That is the set worth adding in one click; everything else stays
	 * individually addable with its evidence on screen.
	 */
	const confident = useMemo(
		() =>
			allSuggestions.filter(
				(s) =>
					s.isContentControl &&
					s.populatedOnExample &&
					!selectedIds.has(s.id),
			),
		[allSuggestions, selectedIds],
	);

	// Prefer the form heading as the section title: it is what the admin reads on
	// the work item, and it becomes the `## heading` in the composed content.
	const toSelectedField = (suggestion: FieldSuggestion): SelectedField => ({
		id: suggestion.id,
		displayName:
			suggestion.label || nameByRef.get(suggestion.id) || suggestion.id,
	});

	return (
		<div className="space-y-3 rounded-lg border bg-muted/30 p-3">
			<div>
				<Label
					htmlFor="field-mapping-preview-ticket"
					className="font-medium text-foreground text-sm"
				>
					Start from a real ticket
				</Label>
				<p className="mt-0.5 text-muted-foreground text-xs">
					Enter one representative work-item number. We'll read recent
					items of the same type and rank fields by how consistently
					they carry content, so you don't have to hunt through the
					full catalog.
				</p>
			</div>
			<div className="flex items-center gap-2">
				<Input
					id="field-mapping-preview-ticket"
					value={ticket}
					onChange={(e) => setTicket(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							// Enter follows the primary action, which is now
							// "Suggest fields", not the secondary preview.
							handleSuggest();
						}
					}}
					placeholder="e.g. 1234"
					inputMode="numeric"
					className="max-w-40"
				/>
				<Button
					type="button"
					onClick={handleSuggest}
					disabled={suggest.isPending || !ticket.trim()}
				>
					{suggest.isPending ? (
						<>
							<Loader2Icon
								className="mr-2 size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
							Analyzing...
						</>
					) : (
						"Suggest fields"
					)}
				</Button>
				<Button
					type="button"
					variant="outline"
					onClick={handleSubmit}
					disabled={preview.isPending || !ticket.trim()}
				>
					{preview.isPending ? (
						<>
							<Loader2Icon
								className="mr-2 size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
							Loading...
						</>
					) : (
						"Preview selected"
					)}
				</Button>
			</div>

			{errorMessage && (
				<p className="text-destructive text-sm" role="alert">
					{errorMessage}
				</p>
			)}

			{!suggest.isPending && !errorMessage && suggestions.length > 0 && (
				<div className="space-y-2">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<p className="text-muted-foreground text-xs">
							{fromForm ? (
								<>
									Content fields on the{" "}
									<span className="font-medium text-foreground">
										{suggest.data?.workItemType ??
											"work item"}
									</span>{" "}
									form
								</>
							) : (
								<>
									This process exposes no form definition —
									ranked by content on this ticket
								</>
							)}
						</p>
						{confident.length > 0 && (
							<Button
								type="button"
								size="sm"
								variant="secondary"
								onClick={() =>
									onAddFields(confident.map(toSelectedField))
								}
							>
								Add {confident.length} suggested
							</Button>
						)}
					</div>
					<Input
						value={valueQuery}
						onChange={(e) => setValueQuery(e.target.value)}
						placeholder="Filter by heading, identifier, or text you can see in the ticket..."
						aria-label="Filter suggested fields"
						className="h-8 text-xs"
					/>
					{suggestions.length === 0 && (
						<p className="text-muted-foreground text-xs italic">
							No suggested field matches that text.
						</p>
					)}
					<ul className="space-y-1.5">
						{suggestions.map((suggestion) => (
							<SuggestionRow
								key={suggestion.id}
								suggestion={suggestion}
								friendlyName={nameByRef.get(suggestion.id)}
								isSelected={selectedIds.has(suggestion.id)}
								onAdd={() =>
									onAddFields([toSelectedField(suggestion)])
								}
							/>
						))}
					</ul>
				</div>
			)}

			{!preview.isPending && !errorMessage && results.length > 0 && (
				<ul className="space-y-1.5">
					{results.map((field) => (
						<PreviewRow
							key={field.id}
							field={field}
							friendlyName={nameByRef.get(field.id)}
						/>
					))}
				</ul>
			)}

			<ComposedContentPreview
				projectId={projectId}
				workItemId={ticket}
				selected={selected}
			/>
		</div>
	);
}

/**
 * One ranked candidate. The evidence line is the point: it lets the admin see
 * WHY a field is suggested, and it makes a placeholder legible — "present here,
 * empty in 18 of 20" is a judgment call worth surfacing rather than silently
 * ranking away.
 */
function SuggestionRow({
	suggestion,
	friendlyName,
	isSelected,
	onAdd,
}: {
	suggestion: FieldSuggestion;
	friendlyName?: string;
	isSelected: boolean;
	onAdd: () => void;
}) {
	const [open, setOpen] = useState(false);
	const label = suggestion.label || friendlyName || suggestion.id;
	const evidence = suggestion.populatedOnExample
		? `${suggestion.charCount.toLocaleString()} chars on this ticket`
		: "empty on this ticket";

	return (
		<li className="rounded-md border bg-card">
			<Collapsible open={open} onOpenChange={setOpen}>
				<div className="flex items-center gap-1 pr-2">
					<CollapsibleTrigger asChild>
						<button
							type="button"
							className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left motion-safe:transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-hidden"
						>
							<ChevronRightIcon
								className={cn(
									"size-4 shrink-0 text-muted-foreground motion-safe:transition-transform",
									open && "rotate-90",
								)}
								aria-hidden="true"
							/>
							<span className="min-w-0 flex-1">
								<span className="block truncate font-medium text-foreground text-sm">
									{label}
								</span>
								<span className="block truncate text-muted-foreground text-xs">
									<span className="font-mono">
										{suggestion.id}
									</span>
									{" · "}
									{evidence}
								</span>
							</span>
						</button>
					</CollapsibleTrigger>
					{isSelected ? (
						<span className="shrink-0 text-muted-foreground text-xs">
							Added
						</span>
					) : (
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={onAdd}
							aria-label={`Add ${label} to the mapping`}
						>
							Add
						</Button>
					)}
				</div>
				<CollapsibleContent>
					<div className="space-y-1 border-t px-2.5 py-2">
						{suggestion.examplePreview ? (
							<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-foreground text-sm">
								{suggestion.examplePreview}
							</pre>
						) : (
							<p className="text-muted-foreground text-sm italic">
								This field is empty on the ticket you entered.
							</p>
						)}
					</div>
				</CollapsibleContent>
			</Collapsible>
		</li>
	);
}

function PreviewRow({
	field,
	friendlyName,
}: {
	field: PreviewField;
	friendlyName?: string;
}) {
	const [open, setOpen] = useState(false);
	const label = friendlyName ?? field.displayName;

	return (
		<li className="rounded-md border bg-card">
			<Collapsible open={open} onOpenChange={setOpen}>
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="flex w-full items-center gap-2 px-2.5 py-2 text-left motion-safe:transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-hidden"
					>
						<ChevronRightIcon
							className={cn(
								"size-4 shrink-0 text-muted-foreground motion-safe:transition-transform",
								open && "rotate-90",
							)}
							aria-hidden="true"
						/>
						<span className="min-w-0 flex-1">
							<span className="block truncate font-medium text-foreground text-sm">
								{label}
							</span>
							<span className="block truncate font-mono text-muted-foreground text-xs">
								{field.id}
							</span>
						</span>
						{field.isEmpty ? (
							<span className="shrink-0 text-muted-foreground text-xs italic">
								(empty)
							</span>
						) : (
							<span className="shrink-0 font-medium text-secondary text-xs">
								has content
							</span>
						)}
					</button>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="border-t px-2.5 py-2">
						{field.isEmpty ? (
							<p className="text-muted-foreground text-sm italic">
								This field is empty on this ticket.
							</p>
						) : (
							<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans text-foreground text-sm">
								{field.renderedPreview || field.value}
							</pre>
						)}
					</div>
				</CollapsibleContent>
			</Collapsible>
		</li>
	);
}
