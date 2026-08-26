"use client";

/**
 * DiagramsList — Grid view of all Excalidraw diagrams in a project.
 * Supports inline rename, delete, and opening the full Excalidraw editor.
 */

import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { DestructiveTooltip } from "@ui/components/destructive-tooltip";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

// Lazy-load the full Excalidraw editor
const ExcalidrawEditor = dynamic(
	() =>
		import("../../../../components/ai-elements/ExcalidrawEditor").then(
			(m) => m.ExcalidrawEditor,
		),
	{ ssr: false },
);

interface DiagramsListProps {
	projectId: string;
}

function formatRelativeTime(date: Date | string) {
	const d = new Date(date);
	const now = Date.now();
	const diff = now - d.getTime();
	if (diff < 60_000) {
		return "just now";
	}
	if (diff < 3_600_000) {
		return `${Math.floor(diff / 60_000)}m ago`;
	}
	if (diff < 86_400_000) {
		return `${Math.floor(diff / 3_600_000)}h ago`;
	}
	return d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function InlineRename({
	initialTitle,
	onSave,
}: {
	initialTitle?: string;
	onSave: (title: string) => void;
}) {
	const tTooltips = useTranslations("tooltips.common");
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(initialTitle ?? "");
	const inputRef = useRef<HTMLInputElement>(null);

	function startEdit(e: React.MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		setValue(initialTitle ?? "");
		setEditing(true);
		setTimeout(() => inputRef.current?.focus(), 0);
	}

	function commit() {
		setEditing(false);
		const trimmed = value.trim();
		if (trimmed !== (initialTitle ?? "")) {
			onSave(trimmed);
		}
	}

	if (editing) {
		return (
			<input
				ref={inputRef}
				className="text-sm font-medium text-foreground bg-background border border-primary/40 rounded px-1 py-0 w-full outline-none focus:border-primary"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						commit();
					}
					if (e.key === "Escape") {
						setEditing(false);
					}
				}}
				onClick={(e) => e.stopPropagation()}
				placeholder="Untitled diagram"
			/>
		);
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={startEdit}
					className="flex items-center gap-1 text-left max-w-full cursor-pointer group"
				>
					{initialTitle ? (
						<span className="text-sm font-medium text-foreground truncate">
							{initialTitle}
						</span>
					) : (
						<span className="text-sm text-muted-foreground italic">
							Untitled diagram
						</span>
					)}
					<PencilIcon className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
				</button>
			</TooltipTrigger>
			<TooltipContent>
				{tTooltips("clickToRename", { subject: "diagram" })}
			</TooltipContent>
		</Tooltip>
	);
}

export function DiagramsList({ projectId }: DiagramsListProps) {
	const tTooltips = useTranslations("tooltips.common");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const [editorDiagram, setEditorDiagram] = useState<{
		id: string;
		elements: any[];
		appState?: any;
		checkpointId?: string;
		mcpConfigId?: string;
	} | null>(null);

	const queryKey = ["diagrams", projectId, organizationId];

	const { data: diagrams, isLoading } = useQuery({
		queryKey,
		queryFn: () =>
			orpcClient.projects.diagrams.list({
				projectId,
				organizationId: organizationId ?? null,
			}),
	});

	const createMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.diagrams.create({
				projectId,
				organizationId: organizationId ?? null,
				title: "Untitled diagram",
				elements: [],
			}),
		onSuccess: (diagram) => {
			queryClient.invalidateQueries({ queryKey });
			setEditorDiagram({
				id: diagram.id,
				elements: [],
			});
		},
		onError: () => toast.error("Failed to create diagram"),
	});

	const updateMutation = useMutation({
		mutationFn: (params: {
			diagramId: string;
			title?: string;
			elements?: any;
		}) =>
			orpcClient.projects.diagrams.update({
				projectId,
				diagramId: params.diagramId,
				organizationId: organizationId ?? null,
				title: params.title,
				elements: params.elements,
			}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey }),
	});

	const deleteMutation = useMutation({
		mutationFn: (diagramId: string) =>
			orpcClient.projects.diagrams.delete({
				projectId,
				diagramId,
				organizationId: organizationId ?? null,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey });
			toast.success("Diagram deleted");
		},
		onError: () => toast.error("Failed to delete diagram"),
	});

	const handleOpenDiagram = useCallback((diagram: any) => {
		setEditorDiagram({
			id: diagram.id,
			elements: Array.isArray(diagram.elements) ? diagram.elements : [],
			appState: diagram.appState ?? undefined,
			checkpointId: diagram.checkpointId ?? undefined,
			mcpConfigId: diagram.mcpConfigId ?? undefined,
		});
	}, []);

	const handleEditorClose = useCallback(() => {
		setEditorDiagram(null);
	}, []);

	const handleEditorElementsChange = useCallback(
		(elements: any[]) => {
			if (editorDiagram) {
				updateMutation.mutate({
					diagramId: editorDiagram.id,
					elements,
				});
			}
		},
		[editorDiagram, updateMutation],
	);

	if (editorDiagram) {
		return (
			<ExcalidrawEditor
				elements={editorDiagram.elements}
				appState={editorDiagram.appState}
				checkpointId={editorDiagram.checkpointId}
				configId={editorDiagram.mcpConfigId}
				organizationId={organizationId}
				onClose={handleEditorClose}
				onElementsChange={handleEditorElementsChange}
			/>
		);
	}

	return (
		<div>
			<div className="flex items-center justify-between mb-6">
				<div className="flex items-center gap-1.5">
					<h2
						data-onboarding-target="diagrams-header"
						className="text-lg font-semibold"
					>
						Diagrams
					</h2>
					<PageTourButton pageId="diagrams" />
				</div>
				<Button
					data-onboarding-target="diagrams-new"
					size="sm"
					onClick={() => createMutation.mutate()}
					disabled={createMutation.isPending}
				>
					<PlusIcon className="size-4 mr-1" />
					New Diagram
				</Button>
			</div>

			{isLoading && (
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<div className="size-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
					Loading diagrams...
				</div>
			)}

			{!isLoading && (!diagrams || diagrams.length === 0) && (
				<div className="text-center py-16 text-muted-foreground">
					<svg
						role="img"
						aria-label="No diagrams"
						className="mx-auto mb-3 opacity-40"
						width="32"
						height="32"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
					>
						<rect x="3" y="3" width="18" height="18" rx="2" />
						<path d="M9 9h6M9 13h4" strokeLinecap="round" />
					</svg>
					<p className="text-sm">No diagrams yet.</p>
					<p className="text-xs mt-1">
						Create one or ask AI to draw a diagram in chat.
					</p>
				</div>
			)}

			{diagrams && diagrams.length > 0 && (
				<div className="grid gap-2">
					{diagrams.map((diagram: any) => (
						// biome-ignore lint/a11y/useSemanticElements: list item acts as interactive row; contains nested SVG/content; cannot use <button>
						<div
							key={diagram.id}
							role="button"
							tabIndex={0}
							className="relative flex items-center gap-4 px-5 py-4 rounded-lg border hover:border-primary/30 hover:bg-primary/[0.03] transition-colors cursor-pointer text-left w-full"
							onClick={() => handleOpenDiagram(diagram)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									handleOpenDiagram(diagram);
								}
							}}
						>
							<div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
								<svg
									role="img"
									aria-label="Diagram"
									width="16"
									height="16"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
									className="text-primary"
								>
									<rect
										x="3"
										y="3"
										width="18"
										height="18"
										rx="2"
									/>
									<path d="M8 12l3 3 5-5" />
								</svg>
							</div>
							<div className="flex-1 min-w-0">
								<InlineRename
									initialTitle={diagram.title}
									onSave={(title) =>
										updateMutation.mutate({
											diagramId: diagram.id,
											title,
										})
									}
								/>
								<p className="text-xs text-muted-foreground mt-0.5">
									Updated{" "}
									{formatRelativeTime(diagram.updatedAt)}
								</p>
							</div>
							<DestructiveTooltip copy={tTooltips.raw("delete")}>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										deleteMutation.mutate(diagram.id);
									}}
									aria-label="Delete diagram"
									className="text-muted-foreground hover:text-destructive transition-colors p-1"
								>
									<Trash2Icon className="size-4" />
								</button>
							</DestructiveTooltip>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
