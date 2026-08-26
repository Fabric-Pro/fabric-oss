"use client";

import { useIsOverflowing } from "@shared/hooks/use-is-overflowing";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Input } from "@ui/components/input";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Loader2Icon, PencilIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Props = {
	projectId: string;
	documentId: string;
	organizationId: string | null | undefined;
	title: string;
	canEdit: boolean;
	inputClassName?: string;
	/**
	 * Class for the read-only / display state. Defaults to `"text-sm"` so the
	 * documents-list usage stays compact, but the document editor page passes
	 * its own large editorial-heading class to match the feature-editor title.
	 */
	displayClassName?: string;
	/** Called when edit mode changes – use to prevent parent navigation during edit */
	onEditingChange?: (editing: boolean) => void;
	/**
	 * When true, render the title as an always-editable Input (no click-to-
	 * edit pencil pattern). Used by the document editor page to match the
	 * feature editor's always-editable title — borderless until hover/focus,
	 * with a smart tooltip that only opens when the title is truncated.
	 */
	alwaysEditable?: boolean;
};

export function DocumentTitleInlineEdit({
	projectId,
	documentId,
	organizationId,
	title,
	canEdit,
	inputClassName = "h-6 text-sm",
	displayClassName = "text-sm",
	onEditingChange,
	alwaysEditable = false,
}: Props) {
	const tTooltips = useTranslations("tooltips.common");
	const [isEditing, setIsEditing] = useState(false);
	const [value, setValue] = useState(title);
	const inputRef = useRef<HTMLInputElement>(null);
	const queryClient = useQueryClient();

	useEffect(() => {
		if (!isEditing) {
			setValue(title);
		}
	}, [title, isEditing]);

	useEffect(() => {
		if (isEditing && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isEditing]);

	const { mutate, isPending } = useMutation(
		orpc.projects.documents.update.mutationOptions({
			onSuccess: (_data, variables) => {
				const newTitle = variables.title ?? title;
				toast.success("Document renamed");

				// Optimistically update documents list cache for instant UI update
				queryClient.setQueriesData(
					{
						predicate: (query) => {
							const data = query.state.data as
								| { documents?: { id: string }[] }
								| undefined;
							return !!data?.documents?.some(
								(d) => d.id === documentId,
							);
						},
					},
					(
						old:
							| { documents?: { id: string; title: string }[] }
							| undefined,
					) => {
						if (!old?.documents) {
							return old;
						}
						return {
							...old,
							documents: old.documents.map((doc) =>
								doc.id === documentId
									? { ...doc, title: newTitle }
									: doc,
							),
						};
					},
				);

				// Invalidate to refetch and sync with server
				queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.get.queryKey({
						input: { id: documentId, projectId },
					}),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.list.queryKey({
						input: { projectId, organizationId },
					}),
				});
				setIsEditing(false);
				onEditingChange?.(false);
			},
			onError: (error) => {
				toast.error("Failed to rename document", {
					description:
						error instanceof Error ? error.message : String(error),
				});
				setValue(title);
				setIsEditing(false);
				onEditingChange?.(false);
			},
		}),
	);

	function handleSave() {
		const trimmed = value.trim();
		if (!trimmed) {
			toast.error("Document title cannot be empty");
			setValue(title);
			setIsEditing(false);
			onEditingChange?.(false);
			return;
		}
		if (trimmed === title) {
			setIsEditing(false);
			onEditingChange?.(false);
			return;
		}
		mutate({
			id: documentId,
			projectId,
			organizationId: organizationId ?? null,
			title: trimmed,
		});
	}

	function handleCancel() {
		setValue(title);
		setIsEditing(false);
		onEditingChange?.(false);
	}

	function handleBlur() {
		const trimmed = value.trim();
		if (!trimmed || trimmed === title) {
			handleCancel();
			return;
		}
		if (trimmed.length > 255) {
			handleCancel();
			return;
		}
		handleSave();
	}

	// Smart truncation tooltip — only relevant in the always-editable branch
	// (the document editor's masthead). `useIsOverflowing` attaches its
	// ResizeObserver inside a callback ref so the observer survives the
	// first render even when the element materialises late, and it re-measures
	// after web fonts load so the tooltip flips on after the fallback-font
	// metrics are replaced. The compact list usage doesn't pass a ref, so it
	// skips the measurement entirely.
	const [isTitleFocused, setIsTitleFocused] = useState(false);
	const [overflowRef, isTitleTruncated] =
		useIsOverflowing<HTMLInputElement>(value);
	const titleInputRef = useCallback(
		(el: HTMLInputElement | null) => {
			inputRef.current = el;
			overflowRef(el);
		},
		[overflowRef],
	);
	const showTitleTooltip =
		alwaysEditable && !!value && isTitleTruncated && !isTitleFocused;

	if (!canEdit) {
		return <span className={displayClassName}>{title}</span>;
	}

	if (alwaysEditable) {
		return (
			<TooltipProvider>
				<Tooltip open={showTitleTooltip ? undefined : false}>
					<TooltipTrigger asChild>
						<Input
							ref={titleInputRef}
							value={value}
							onChange={(e) =>
								setValue(e.target.value.slice(0, 255))
							}
							onFocus={() => setIsTitleFocused(true)}
							onBlur={() => {
								setIsTitleFocused(false);
								handleBlur();
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									(e.target as HTMLInputElement).blur();
								} else if (e.key === "Escape") {
									setValue(title);
									(e.target as HTMLInputElement).blur();
								}
							}}
							maxLength={255}
							disabled={isPending}
							placeholder="Document title..."
							className={inputClassName}
						/>
					</TooltipTrigger>
					<TooltipContent
						side="bottom"
						className="max-w-[min(90vw,640px)] break-words text-wrap"
					>
						<p>{value}</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		);
	}

	if (isEditing) {
		return (
			<div className="flex items-center gap-2">
				<Input
					ref={inputRef}
					value={value}
					onChange={(e) => setValue(e.target.value.slice(0, 255))}
					onBlur={handleBlur}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							handleSave();
						} else if (e.key === "Escape") {
							handleCancel();
						}
					}}
					maxLength={255}
					disabled={isPending}
					className={inputClassName}
				/>
				{isPending && (
					<Loader2Icon className="size-4 animate-spin shrink-0" />
				)}
			</div>
		);
	}

	return (
		<span
			className={`group inline-flex items-center gap-2 text-left min-w-0 ${displayClassName}`}
		>
			<span className="break-words text-left truncate">{title}</span>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						onClick={() => {
							setIsEditing(true);
							onEditingChange?.(true);
						}}
						className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
						aria-label="Rename document"
					>
						<PencilIcon className="size-3.5" />
					</button>
				</TooltipTrigger>
				<TooltipContent>
					{tTooltips("clickToRename", { subject: "document" })}
				</TooltipContent>
			</Tooltip>
		</span>
	);
}
