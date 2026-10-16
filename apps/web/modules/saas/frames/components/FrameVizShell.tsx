"use client";

import type { FrameDocumentView } from "@saas/frames/components/FrameRenderer";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Response } from "../../../../components/ai-elements/response";
import { useFrameContentFingerprint } from "../hooks/use-frame-content-fingerprint";
import { useFrameEmbedRpc } from "../hooks/use-frame-embed-rpc";
import { useFrameExport } from "../hooks/use-frame-export";
import { useFrameRuntimeBridge } from "../hooks/use-frame-runtime-bridge";
import type { FrameSurfaceName } from "../lib/frame-tool-types";
import { frameShellLabels } from "../lib/frame-shell-labels";
import { FrameRuntimeConfirmDialog } from "./FrameRuntimeConfirmDialog";
import { FrameShellHeader, type FrameShareControl } from "./FrameShellHeader";
import { ShareFrameSheet } from "./ShareFrameSheet";

interface FrameVizShellProps {
	frameId?: string;
	title: string;
	description?: string;
	kind: "frame" | "slideshow";
	contentType?: string;
	embedUrl: string;
	frameUrl?: string;
	shareUrl?: string;
	frameDocument?: FrameDocumentView;
	headerMode?: "authenticated" | "public";
	hideHeader?: boolean;
	onPublish?: () => void;
	onRevokeShare?: () => void;
	isPublic?: boolean;
	publishPending?: boolean;
	revokePending?: boolean;
	workspaceName?: string;
	className?: string;
	presentation?: "page" | "panel";
	onClose?: () => void;
	/**
	 * The organization the page belongs to. A page runs its tools only while
	 * the viewer is looking at this organization.
	 */
	organizationId?: string | null;
	/** Frame belongs to a project (rendered through the hardened sandbox). */
	isProjectFrame?: boolean;
	/**
	 * False when the page is drawn without its scripts (one an unattended run
	 * wrote, see `isUnattendedFrame`), which the header then calls "Static"
	 * instead of "Interactive".
	 */
	interactive?: boolean;
	/**
	 * The Fabric tools the page's own script declared it calls
	 * (`window.fabric.call`). Only these run, as the viewer; absent means none.
	 */
	runtimeTools?: readonly string[];
	/** Opens Fabric Agent from where this page is, for `fabric.openAgent`. */
	onOpenAgent?: (prompt: string) => void;
	/** The surface the page is on, which names it above its title. */
	surface?: FrameSurfaceName;
	/**
	 * The viewer may manage who the page is shared with (they own it). The
	 * shell then offers the sharing sheet as its one Share control; with a
	 * `frameId` and without this, a public link or Publish is offered instead.
	 */
	canManageSharing?: boolean;
	/** The sharing sheet was closed; what it changed is worth reading again. */
	onSharingChanged?: () => void;
}

const NO_TOOLS: readonly string[] = [];

export function FrameVizShell({
	frameId,
	title,
	description,
	kind,
	embedUrl,
	shareUrl,
	frameDocument,
	headerMode = "authenticated",
	hideHeader = false,
	onPublish,
	onRevokeShare,
	isPublic = false,
	publishPending = false,
	revokePending = false,
	workspaceName,
	className,
	presentation = "page",
	onClose,
	organizationId = null,
	isProjectFrame = false,
	interactive = true,
	runtimeTools = NO_TOOLS,
	onOpenAgent,
	surface,
	canManageSharing = false,
	onSharingChanged,
}: FrameVizShellProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const fullscreenIframeRef = useRef<HTMLIFrameElement>(null);
	const [showCode, setShowCode] = useState(false);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [currentSlide, setCurrentSlide] = useState(0);
	const [shareSheetOpen, setShareSheetOpen] = useState(false);

	const isPanelPresentation = presentation === "panel";
	const totalSlides = frameDocument?.blocks.length ?? 0;
	const isSlideshow = kind === "slideshow" && totalSlides > 0;
	const effectiveSlide = isSlideshow
		? Math.min(Math.max(currentSlide, 0), totalSlides - 1)
		: 0;
	const effectiveEmbedUrl = isSlideshow
		? `${embedUrl}${embedUrl.includes("?") ? "&" : "?"}slide=${effectiveSlide}`
		: embedUrl;
	const labels = frameShellLabels({ surface, headerMode });

	const codeView = useMemo(
		() => (frameDocument ? JSON.stringify(frameDocument, null, 2) : null),
		[frameDocument],
	);

	const {
		frameHeight,
		iframeLoading,
		embedError,
		embedWindows,
		requestFromEmbed,
		onEmbedLoad,
	} = useFrameEmbedRpc({
		embedUrl,
		effectiveEmbedUrl,
		iframeRef,
		fullscreenIframeRef,
	});

	const contentFingerprint = useFrameContentFingerprint(
		frameDocument?.blocks,
		runtimeTools,
	);
	const { pendingCall, answerConfirmation } = useFrameRuntimeBridge({
		frameKey: frameId ?? embedUrl,
		frameId: frameId ?? null,
		contentFingerprint,
		organizationId,
		runtimeTools,
		embedWindows,
		embedUrl,
		openAgent: onOpenAgent,
		// The question is a dialog; the fullscreen layer sits above every dialog.
		onQuestion: () => setIsFullscreen(false),
		enabled: headerMode !== "public",
	});

	const exporter = useFrameExport({
		title,
		kind,
		codeView,
		iframeRef,
		requestFromEmbed,
		resetKey: effectiveEmbedUrl,
	});

	useEffect(() => {
		if (!isSlideshow) {
			return;
		}

		const onKeyDown = (event: KeyboardEvent) => {
			if (showCode) {
				return;
			}
			if (event.key === "ArrowRight") {
				setCurrentSlide((value) =>
					Math.min(value + 1, totalSlides - 1),
				);
			}
			if (event.key === "ArrowLeft") {
				setCurrentSlide((value) => Math.max(value - 1, 0));
			}
		};

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [isSlideshow, showCode, totalSlides]);

	useEffect(() => {
		if (!isFullscreen) {
			return;
		}
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setIsFullscreen(false);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [isFullscreen]);

	const toggleCode = () => {
		if (showCode) {
			setShowCode(false);
			return;
		}
		setShowCode(true);
		if (!iframeRef.current?.contentWindow) {
			return;
		}
		// The code view is built here; the embed is only told, and a failure
		// to tell it is not worth the viewer waiting for.
		requestFromEmbed({
			type: "fabric-frame:request-display-code",
			requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
		}).catch(() => undefined);
	};

	const canManageSharingHere = Boolean(frameId) && canManageSharing;
	const share: FrameShareControl | null = canManageSharingHere
		? { type: "sheet", onOpen: () => setShareSheetOpen(true) }
		: shareUrl
			? {
					type: "link",
					url: shareUrl,
					onRevoke: onRevokeShare,
					revokePending,
				}
			: onPublish
				? { type: "publish", onPublish, pending: publishPending }
				: null;

	return (
		<>
			<div
				className={cn(
					isPanelPresentation ? "space-y-3" : "space-y-6",
					className,
				)}
			>
				{!hideHeader && (
					<FrameShellHeader
						presentation={presentation}
						title={title}
						description={description}
						kind={kind}
						labels={labels}
						headerMode={headerMode}
						workspaceName={workspaceName}
						isPublic={isPublic}
						isProjectFrame={isProjectFrame}
						interactive={interactive}
						slide={
							isSlideshow
								? { index: effectiveSlide, total: totalSlides }
								: null
						}
						showCode={showCode}
						onToggleCode={toggleCode}
						onFullscreen={() => setIsFullscreen(true)}
						exporter={{
							available: codeView !== null,
							isExporting: exporter.isExporting,
							onPng: exporter.exportPng,
							onPdf: exporter.exportPdf,
							onJson: exporter.exportJson,
						}}
						exportNotice={exporter.exportNotice}
						share={share}
						onClose={onClose}
					/>
				)}

				{isSlideshow && !showCode ? (
					<div
						className={cn(
							"flex items-center justify-between border bg-card",
							isPanelPresentation
								? "rounded-2xl px-3 py-2 shadow-none"
								: "rounded-2xl px-4 py-3 shadow-sm",
						)}
					>
						<div>
							<p className="text-sm font-medium text-foreground">
								Slideshow
							</p>
							<p className="text-xs text-muted-foreground">
								Use the arrow keys or controls to move between
								slides.
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								disabled={effectiveSlide === 0}
								onClick={() =>
									setCurrentSlide((value) =>
										Math.max(value - 1, 0),
									)
								}
							>
								<ChevronLeft className="mr-2 h-4 w-4" />{" "}
								Previous
							</Button>
							<div className="min-w-24 text-center text-sm text-muted-foreground">
								Slide {effectiveSlide + 1} / {totalSlides}
							</div>
							<Button
								variant="outline"
								size="sm"
								disabled={effectiveSlide >= totalSlides - 1}
								onClick={() =>
									setCurrentSlide((value) =>
										Math.min(value + 1, totalSlides - 1),
									)
								}
							>
								Next <ChevronRight className="ml-2 h-4 w-4" />
							</Button>
						</div>
					</div>
				) : null}

				<div
					className={cn(
						"overflow-hidden",
						!isPanelPresentation &&
							"rounded-3xl border bg-card shadow-sm",
					)}
				>
					{showCode ? (
						<div className="max-h-[80vh] overflow-auto p-4">
							{codeView ? (
								<pre className="overflow-x-auto rounded-2xl border bg-muted p-4 text-sm">
									<code>{codeView}</code>
								</pre>
							) : (
								<div className="p-6">
									<Response>
										Code view is unavailable for this frame.
									</Response>
								</div>
							)}
						</div>
					) : (
						<div className="relative bg-muted/20">
							{iframeLoading && !isPanelPresentation ? (
								<div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b bg-background/90 px-4 py-2 text-sm text-muted-foreground backdrop-blur">
									<Loader2 className="h-4 w-4 animate-spin" />{" "}
									{labels.loading}
								</div>
							) : null}
							{embedError ? (
								<div className="border-b bg-destructive/5 px-4 py-3 text-sm text-destructive">
									{embedError}
								</div>
							) : null}
							<iframe
								ref={iframeRef}
								title={title}
								src={effectiveEmbedUrl}
								scrolling="no"
								className={cn(
									"w-full border-0 transition-opacity duration-300",
									isPanelPresentation && iframeLoading
										? "opacity-0"
										: "opacity-100",
								)}
								style={{
									height: frameHeight,
									overflow: "hidden",
								}}
								onLoad={onEmbedLoad}
							/>
						</div>
					)}
				</div>
			</div>
			{isFullscreen &&
				typeof document !== "undefined" &&
				createPortal(
					<div className="fixed inset-0 z-[9999] flex flex-col bg-background">
						<div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
							<span className="font-serif text-lg leading-tight">
								{title}
							</span>
							<Button
								variant="ghost"
								size="icon"
								className="h-8 w-8"
								onClick={() => setIsFullscreen(false)}
								aria-label="Exit fullscreen"
							>
								<X className="h-4 w-4" />
							</Button>
						</div>
						<div
							style={{
								flex: 1,
								minHeight: 0,
								position: "relative",
								overflow: "hidden",
							}}
						>
							<iframe
								ref={fullscreenIframeRef}
								title={title}
								src={effectiveEmbedUrl}
								className="border-0"
								scrolling="auto"
								style={{
									position: "absolute",
									inset: 0,
									width: "100%",
									height: "100%",
								}}
							/>
						</div>
					</div>,
					document.body,
				)}

			<FrameRuntimeConfirmDialog
				call={pendingCall}
				pageTitle={title}
				onAnswer={answerConfirmation}
			/>

			{frameId && canManageSharing ? (
				<ShareFrameSheet
					frameId={frameId}
					organizationId={organizationId}
					isProjectFrame={isProjectFrame}
					open={shareSheetOpen}
					onOpenChange={(open) => {
						setShareSheetOpen(open);
						if (!open) {
							onSharingChanged?.();
						}
					}}
				/>
			) : null}
		</>
	);
}
