"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib";
import {
	Code2,
	Copy,
	Download,
	ExternalLink,
	Eye,
	FileJson,
	Fullscreen,
	Loader2,
	PanelTop,
	Share2,
	Sparkles,
	X,
} from "lucide-react";
import { Response } from "../../../../components/ai-elements/response";
import type { frameShellLabels } from "../lib/frame-shell-labels";

/** The one way a shell lets the viewer share the page it shows. */
export type FrameShareControl =
	| { type: "sheet"; onOpen: () => void }
	| {
			type: "link";
			url: string;
			onRevoke?: () => void;
			revokePending: boolean;
	  }
	| { type: "publish"; onPublish: () => void; pending: boolean };

interface FrameShellExport {
	/** False when the frame's JSON is not known, which leaves a panel no menu. */
	available: boolean;
	isExporting: null | "png" | "pdf";
	onPng: () => void;
	onPdf: () => void;
	onJson: () => void;
}

export interface FrameShellHeaderProps {
	presentation: "page" | "panel";
	title: string;
	description?: string;
	kind: "frame" | "slideshow";
	labels: ReturnType<typeof frameShellLabels>;
	headerMode: "authenticated" | "public";
	workspaceName?: string;
	isPublic: boolean;
	isProjectFrame: boolean;
	/**
	 * Whether the page runs its scripts for the person looking at it. A page
	 * drawn without them is a static report and is labelled as one, so the
	 * header never promises buttons that will not work.
	 */
	interactive: boolean;
	/** Where a slideshow is, when it is one with slides to move between. */
	slide: { index: number; total: number } | null;
	showCode: boolean;
	onToggleCode: () => void;
	onFullscreen: () => void;
	exporter: FrameShellExport;
	exportNotice: string | null;
	share: FrameShareControl | null;
	onClose?: () => void;
}

function copyToClipboard(value: string) {
	void navigator.clipboard.writeText(value);
}

function ExportMenu({
	exporter,
	compact,
}: {
	exporter: FrameShellExport;
	compact: boolean;
}) {
	const busy = exporter.isExporting !== null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				{compact ? (
					<Button
						variant="ghost"
						size="icon"
						className="h-8 w-8"
						title="Export"
						aria-label="Export"
						disabled={busy}
					>
						{busy ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<Download className="h-4 w-4" />
						)}
					</Button>
				) : (
					<Button variant="outline" size="sm" disabled={busy}>
						{busy ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Download className="mr-2 h-4 w-4" />
						)}
						Export
					</Button>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onClick={exporter.onPng}>
					<PanelTop className="mr-2 h-4 w-4" /> Export PNG
				</DropdownMenuItem>
				<DropdownMenuItem onClick={exporter.onPdf}>
					<Download className="mr-2 h-4 w-4" /> Export PDF
				</DropdownMenuItem>
				<DropdownMenuItem onClick={exporter.onJson}>
					<FileJson className="mr-2 h-4 w-4" /> Download JSON
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ShareMenu({
	share,
	isPublic,
	compact,
}: {
	share: FrameShareControl;
	isPublic: boolean;
	compact: boolean;
}) {
	if (share.type === "sheet") {
		return compact ? (
			<Button
				variant="ghost"
				size="icon"
				className="h-8 w-8"
				onClick={share.onOpen}
				title="Share frame"
				aria-label="Share frame"
			>
				<Share2 className="h-4 w-4" />
			</Button>
		) : (
			<Button variant="outline" size="sm" onClick={share.onOpen}>
				<Share2 className="mr-2 h-4 w-4" /> Share
			</Button>
		);
	}
	if (share.type === "publish") {
		return compact ? (
			<Button
				variant="ghost"
				size="icon"
				className="h-8 w-8"
				onClick={share.onPublish}
				disabled={share.pending}
				title={share.pending ? "Publishing…" : "Publish frame"}
				aria-label={share.pending ? "Publishing…" : "Publish frame"}
			>
				<Share2 className="h-4 w-4" />
			</Button>
		) : (
			<Button
				variant="outline"
				size="sm"
				onClick={share.onPublish}
				disabled={share.pending}
			>
				<Share2 className="mr-2 h-4 w-4" />
				{share.pending ? "Publishing…" : "Publish"}
			</Button>
		);
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				{compact ? (
					<Button
						variant="ghost"
						size="icon"
						className="h-8 w-8"
						title="Share"
						aria-label="Share"
					>
						<Share2 className="h-4 w-4" />
					</Button>
				) : (
					<Button variant="outline" size="sm">
						<Share2 className="mr-2 h-4 w-4" /> Share
					</Button>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onClick={() => copyToClipboard(share.url)}>
					<Copy className="mr-2 h-4 w-4" /> Copy link
				</DropdownMenuItem>
				<DropdownMenuItem asChild>
					<a href={share.url} target="_blank" rel="noreferrer">
						<ExternalLink className="mr-2 h-4 w-4" /> Open shared
						view
					</a>
				</DropdownMenuItem>
				{!compact && isPublic && share.onRevoke ? (
					<DropdownMenuItem
						onClick={share.onRevoke}
						disabled={share.revokePending}
					>
						{share.revokePending ? "Revoking…" : "Revoke share"}
					</DropdownMenuItem>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function PanelHeader({
	title,
	description,
	showCode,
	onToggleCode,
	onFullscreen,
	exporter,
	share,
	isPublic,
	onClose,
}: FrameShellHeaderProps) {
	const codeToggleLabel = showCode
		? "Show rendered frame"
		: "Show source code";
	return (
		<div className="flex items-start justify-between gap-3">
			<div className="min-w-0 flex-1">
				<h2 className="truncate font-serif text-xl leading-tight">
					{title}
				</h2>
				{description ? (
					<p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
						{description}
					</p>
				) : null}
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<Button
					variant="ghost"
					size="icon"
					className="h-8 w-8"
					onClick={onToggleCode}
					title={codeToggleLabel}
					aria-label={codeToggleLabel}
				>
					{showCode ? (
						<Eye className="h-4 w-4" />
					) : (
						<Code2 className="h-4 w-4" />
					)}
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className="h-8 w-8"
					onClick={onFullscreen}
					title="Fullscreen"
					aria-label="Fullscreen"
				>
					<Fullscreen className="h-4 w-4" />
				</Button>
				{exporter.available ? (
					<ExportMenu exporter={exporter} compact />
				) : null}
				{share ? (
					<ShareMenu share={share} isPublic={isPublic} compact />
				) : null}
				{onClose ? (
					<Button
						variant="ghost"
						size="icon"
						className="h-8 w-8"
						onClick={onClose}
						aria-label="Close interactive content panel"
					>
						<X className="h-4 w-4" />
					</Button>
				) : null}
			</div>
		</div>
	);
}

function PageHeader({
	title,
	description,
	kind,
	labels,
	headerMode,
	workspaceName,
	isPublic,
	isProjectFrame,
	interactive,
	slide,
	showCode,
	onToggleCode,
	onFullscreen,
	exporter,
	exportNotice,
	share,
}: FrameShellHeaderProps) {
	return (
		<>
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-3">
					<div className="space-y-1">
						<p className="editorial-label">{labels.eyebrow}</p>
						<h1 className="font-serif text-4xl">{title}</h1>
						{headerMode === "public" && workspaceName ? (
							<p className="text-sm text-muted-foreground">
								Built in Fabric by{" "}
								<span className="font-medium text-foreground">
									{workspaceName}
								</span>
							</p>
						) : null}
					</div>
					{description ? (
						<div className="max-w-3xl text-sm leading-7 text-muted-foreground prose-sm prose dark:prose-invert">
							<Response>{description}</Response>
						</div>
					) : headerMode === "public" ? (
						<p className="max-w-3xl text-sm leading-7 text-muted-foreground">
							Explore a publicly shared interactive frame powered
							by Fabric.
						</p>
					) : null}
					<div className="flex flex-wrap gap-2">
						{labels.showKindBadge ? (
							<Badge variant="secondary">
								{kind === "slideshow" ? "Slideshow" : "Frame"}
							</Badge>
						) : null}
						{isPublic ? <Badge>Shared</Badge> : null}
						{isProjectFrame ? (
							<Badge variant="outline">Project</Badge>
						) : null}
						{interactive ? (
							<Badge variant="outline">
								<Sparkles className="mr-1 h-3 w-3" />{" "}
								Interactive
							</Badge>
						) : (
							<Badge variant="outline">Static</Badge>
						)}
						{slide ? (
							<Badge variant="outline">
								Slide {slide.index + 1} of {slide.total}
							</Badge>
						) : null}
					</div>
				</div>
				<div className="flex flex-wrap items-start gap-2">
					<Button variant="outline" size="sm" onClick={onToggleCode}>
						{showCode ? (
							<>
								<Eye className="mr-2 h-4 w-4" /> Render
							</>
						) : (
							<>
								<Code2 className="mr-2 h-4 w-4" /> Code
							</>
						)}
					</Button>
					<Button variant="outline" size="sm" onClick={onFullscreen}>
						<Fullscreen className="mr-2 h-4 w-4" /> Fullscreen
					</Button>
					<ExportMenu exporter={exporter} compact={false} />
					{share ? (
						<ShareMenu
							share={share}
							isPublic={isPublic}
							compact={false}
						/>
					) : null}
				</div>
			</div>
			{exportNotice ? (
				<p className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
					{exportNotice}
				</p>
			) : null}
		</>
	);
}

/**
 * The header above a page in a frame shell: its title and what it is, and the
 * controls around it - the code view, fullscreen, export and the one way to
 * share it. A page is drawn in full; a panel in a chat gets a compact row.
 */
export function FrameShellHeader(props: FrameShellHeaderProps) {
	const panel = props.presentation === "panel";
	return (
		<div
			className={cn(
				"border bg-card",
				panel
					? "rounded-2xl px-4 py-3 shadow-none"
					: "rounded-3xl p-6 shadow-sm",
			)}
		>
			{panel ? <PanelHeader {...props} /> : <PageHeader {...props} />}
		</div>
	);
}
