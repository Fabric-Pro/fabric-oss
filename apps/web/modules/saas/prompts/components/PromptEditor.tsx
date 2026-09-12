"use client";

import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { ChevronDownIcon, Loader2, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

type PromptFormat =
	| "PLAIN_TEXT"
	| "MARKDOWN"
	| "HANDLEBARS"
	| "MUSTACHE"
	| "LIQUID"
	| "JINJA2";
type PromptScope = "SYSTEM" | "ORG" | "USER";

const FORMAT_LABELS: Record<PromptFormat, string> = {
	PLAIN_TEXT: "Plain text",
	MARKDOWN: "Markdown",
	HANDLEBARS: "Handlebars",
	MUSTACHE: "Mustache",
	LIQUID: "Liquid",
	JINJA2: "Jinja2",
};

const SCOPE_LABELS: Record<PromptScope, string> = {
	USER: "Personal",
	ORG: "Organization",
	SYSTEM: "System",
};

type Props = {
	initialData: {
		name: string;
		description?: string;
		scope: PromptScope;
		format: PromptFormat;
		category?: string;
		tags: string[];
		isPublic: boolean;
		content: string;
	};
	onSave: (data: {
		name: string;
		description?: string;
		scope: PromptScope;
		format: PromptFormat;
		category?: string;
		tags: string[];
		isPublic: boolean;
		content: string;
		changeNote?: string;
	}) => void;
	onCancel: () => void;
	isLoading?: boolean;
	canEditScope?: boolean;
};

/**
 * Editing a prompt is editing its text. The page header above already shows
 * the name, description, category and tags, so the editor gives the content
 * the height and keeps the metadata behind a "Details" disclosure that opens
 * only when one of those needs to change. The bar at the bottom carries the
 * change note and the actions, and stays in view while a long prompt scrolls.
 */
export function PromptEditor({
	initialData,
	onSave,
	onCancel,
	isLoading = false,
	canEditScope = true,
}: Props) {
	const [name, setName] = useState(initialData.name);
	const [description, setDescription] = useState(
		initialData.description ?? "",
	);
	const [scope, setScope] = useState<PromptScope>(initialData.scope);
	const [format, setFormat] = useState<PromptFormat>(initialData.format);
	const [category, setCategory] = useState(initialData.category ?? "");
	const [tags, setTags] = useState<string[]>(initialData.tags);
	const [tagInput, setTagInput] = useState("");
	const [isPublic] = useState(initialData.isPublic);
	const [content, setContent] = useState(initialData.content);
	const [changeNote, setChangeNote] = useState("");
	const [detailsOpen, setDetailsOpen] = useState(false);
	const detailsId = useId();
	const contentRef = useRef<HTMLTextAreaElement>(null);

	// The prompt is the point of the page: focus it on open, and size the box
	// to the text so nothing has to be scrolled inside a scrolling page.
	useEffect(() => {
		const el = contentRef.current;
		if (!el) {
			return;
		}
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, []);

	const dirty =
		content !== initialData.content ||
		name !== initialData.name ||
		description !== (initialData.description ?? "") ||
		format !== initialData.format ||
		scope !== initialData.scope ||
		category !== (initialData.category ?? "") ||
		JSON.stringify(tags) !== JSON.stringify(initialData.tags);
	const canSave = !isLoading && name.trim().length > 0 && content.length > 0;

	const handleAddTag = () => {
		const trimmedTag = tagInput.trim();
		if (trimmedTag && !tags.includes(trimmedTag)) {
			setTags([...tags, trimmedTag]);
		}
		setTagInput("");
	};

	const handleRemoveTag = (tagToRemove: string) => {
		setTags(tags.filter((tag) => tag !== tagToRemove));
	};

	const submit = () => {
		if (!canSave) {
			return;
		}
		onSave({
			name,
			description: description || undefined,
			scope,
			format,
			category: category || undefined,
			tags,
			isPublic,
			content,
			changeNote: changeNote || undefined,
		});
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		submit();
	};

	const lineCount = content.length === 0 ? 0 : content.split("\n").length;

	return (
		<form
			onSubmit={handleSubmit}
			onKeyDown={(e) => {
				// The editor's own shortcut; Enter inside inputs still submits.
				if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
					e.preventDefault();
					submit();
				}
			}}
			className="space-y-4"
		>
			{/* Editor bar: what is being edited, in what format, how long. */}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-3">
					<p className="app-editorial-label">Editing</p>
					<p className="fab-label">
						{FORMAT_LABELS[format]} · {lineCount}{" "}
						{lineCount === 1 ? "line" : "lines"} · {content.length}{" "}
						characters
					</p>
				</div>
				<button
					type="button"
					onClick={() => setDetailsOpen((open) => !open)}
					aria-expanded={detailsOpen}
					aria-controls={detailsId}
					className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
				>
					Details
					<ChevronDownIcon
						aria-hidden="true"
						className={cn(
							"size-3.5 transition-transform",
							detailsOpen && "rotate-180",
						)}
					/>
				</button>
			</div>

			{/* The prompt. Same surface as the read view, but tall. */}
			<Textarea
				ref={contentRef}
				value={content}
				onChange={(e) => {
					setContent(e.target.value);
					e.target.style.height = "auto";
					e.target.style.height = `${e.target.scrollHeight}px`;
				}}
				placeholder="Write the prompt here"
				aria-label="Prompt content"
				className="min-h-[60vh] resize-y rounded-xl border-border bg-muted/30 px-5 py-4 font-mono text-sm leading-7 shadow-none focus-visible:ring-1"
				required
			/>

			{/* Details: name, description and the rest, only when asked for.
			    The header above the editor already says what they are. */}
			{detailsOpen ? (
				<div
					id={detailsId}
					className="app-surface grid gap-4 rounded-xl p-5 sm:grid-cols-2"
				>
					<div className="space-y-1.5">
						<Label htmlFor="prompt-name">Name</Label>
						<Input
							id="prompt-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Prompt name"
							required
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="prompt-description">Description</Label>
						<Input
							id="prompt-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="What this prompt does"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="prompt-format">Format</Label>
						<Select
							value={format}
							onValueChange={(value) =>
								setFormat(value as PromptFormat)
							}
						>
							<SelectTrigger id="prompt-format">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{(
									Object.keys(FORMAT_LABELS) as PromptFormat[]
								).map((value) => (
									<SelectItem key={value} value={value}>
										{FORMAT_LABELS[value]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="prompt-scope">Scope</Label>
						{canEditScope ? (
							<Select
								value={scope}
								onValueChange={(value) =>
									setScope(value as PromptScope)
								}
							>
								<SelectTrigger id="prompt-scope">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{(
										Object.keys(
											SCOPE_LABELS,
										) as PromptScope[]
									).map((value) => (
										<SelectItem key={value} value={value}>
											{SCOPE_LABELS[value]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : (
							// Scope is fixed after creation: say so, rather than
							// offering a disabled control that looks like a field.
							<p
								id="prompt-scope"
								className="flex h-9 items-center text-sm text-muted-foreground"
							>
								{SCOPE_LABELS[scope]}, set at creation
							</p>
						)}
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="prompt-category">Category</Label>
						<Input
							id="prompt-category"
							value={category}
							onChange={(e) => setCategory(e.target.value)}
							placeholder="e.g. document-generation"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="prompt-tags">Tags</Label>
						<div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1">
							{tags.map((tag) => (
								<span
									key={tag}
									className="app-soft-badge inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
								>
									{tag}
									<button
										type="button"
										onClick={() => handleRemoveTag(tag)}
										aria-label={`Remove tag ${tag}`}
										className="text-muted-foreground hover:text-foreground"
									>
										<XIcon className="size-3" />
									</button>
								</span>
							))}
							<input
								id="prompt-tags"
								value={tagInput}
								onChange={(e) => setTagInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										handleAddTag();
									}
									if (
										e.key === "Backspace" &&
										tagInput === "" &&
										tags.length > 0
									) {
										handleRemoveTag(tags[tags.length - 1]);
									}
								}}
								onBlur={handleAddTag}
								placeholder={
									tags.length === 0 ? "Add a tag" : ""
								}
								className="min-w-[6rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
							/>
						</div>
					</div>
				</div>
			) : null}

			{/* Save bar: stays at the bottom of the viewport while the prompt
			    scrolls, with the change note beside the actions. */}
			<div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-border bg-background py-3">
				<Input
					id="changeNote"
					value={changeNote}
					onChange={(e) => setChangeNote(e.target.value)}
					placeholder="Change note (optional)"
					aria-label="Change note"
					className="min-w-[200px] flex-1"
				/>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={onCancel}
						disabled={isLoading}
					>
						Cancel
					</Button>
					<Button type="submit" disabled={!canSave || !dirty}>
						{isLoading ? (
							<>
								<Loader2 className="mr-2 size-4 animate-spin" />
								Saving
							</>
						) : (
							"Save changes"
						)}
					</Button>
				</div>
			</div>
		</form>
	);
}
