"use client";

import type { FrameDocumentView } from "@saas/frames/components/FrameRenderer";
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
	ChevronLeft,
	ChevronRight,
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
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Response } from "../../../../components/ai-elements/response";
import {
	type FrameEmbedToHostMessage,
	type FrameHostToEmbedMessage,
	isFrameEmbedToHostMessage,
} from "../lib/frame-embed-protocol";
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
	organizationId?: string | null;
}

const RPC_TIMEOUT_MS = 5000;

export function FrameVizShell({
	frameId,
	title,
	description,
	kind,
	contentType: _contentType,
	embedUrl,
	frameUrl: _frameUrl,
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
	organizationId,
}: FrameVizShellProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const pendingRequestsRef = useRef<
		Map<string, (message: FrameEmbedToHostMessage) => void>
	>(new Map());
	const [showCode, setShowCode] = useState(false);
	const [frameHeight, setFrameHeight] = useState(720);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [iframeLoading, setIframeLoading] = useState(true);
	const [isExporting, setIsExporting] = useState<null | "png" | "pdf">(null);
	const [currentSlide, setCurrentSlide] = useState(0);
	const [embedError, setEmbedError] = useState<string | null>(null);
	const [exportNotice, setExportNotice] = useState<string | null>(null);
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

	useEffect(() => {
		// Only the embed this shell framed may drive it. Without the check any
		// window with a handle on this one — an opener, another frame — could
		// post a `set-height` or resolve a pending export/code RPC with its own
		// payload. `embedUrl` is app-relative today, so this resolves to this
		// app's own origin; resolving it rather than hardcoding keeps the check
		// correct if the embed is ever served from elsewhere.
		let expectedOrigin = window.location.origin;
		try {
			expectedOrigin = new URL(embedUrl, window.location.href).origin;
		} catch {
			// Unparseable embed URL — fall back to this app's own origin.
		}

		const onMessage = (event: MessageEvent) => {
			if (event.origin !== expectedOrigin) {
				return;
			}
			if (!isFrameEmbedToHostMessage(event.data)) {
				return;
			}

			if (event.data.type === "fabric-frame:ready") {
				setIframeLoading(false);
				setEmbedError(null);
				return;
			}

			if (event.data.type === "fabric-frame:set-height") {
				const nextHeight = Number(event.data.height ?? 0);
				if (Number.isFinite(nextHeight) && nextHeight > 0) {
					setFrameHeight(
						Math.max(480, Math.min(nextHeight + 24, 12000)),
					);
					setIframeLoading(false);
				}
				return;
			}

			if (event.data.type === "fabric-frame:error") {
				setEmbedError(event.data.error);
				setIframeLoading(false);
				return;
			}

			if (
				event.data.type === "fabric-frame:export-png-result" ||
				event.data.type === "fabric-frame:display-code"
			) {
				const resolve = pendingRequestsRef.current.get(
					event.data.requestId,
				);
				if (resolve) {
					pendingRequestsRef.current.delete(event.data.requestId);
					resolve(event.data);
				}
			}
		};

		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [embedUrl]);

	useEffect(() => {
		setIframeLoading(true);
		setEmbedError(null);
		setExportNotice(null);
	}, [effectiveEmbedUrl]);

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

	const codeView = useMemo(() => {
		if (!frameDocument) {
			return null;
		}
		return JSON.stringify(frameDocument, null, 2);
	}, [frameDocument]);

	const handleCopy = async (value?: string) => {
		if (!value) {
			return;
		}
		await navigator.clipboard.writeText(value);
	};

	const sendMessageToEmbed = (message: FrameHostToEmbedMessage) => {
		iframeRef.current?.contentWindow?.postMessage(message, "*");
	};

	const requestFromEmbed = <T extends FrameEmbedToHostMessage>(
		message: FrameHostToEmbedMessage,
	) => {
		return new Promise<T>((resolve, reject) => {
			const timeout = window.setTimeout(() => {
				pendingRequestsRef.current.delete(message.requestId);
				reject(new Error("Frame embed did not respond in time."));
			}, RPC_TIMEOUT_MS);

			pendingRequestsRef.current.set(message.requestId, (response) => {
				window.clearTimeout(timeout);
				resolve(response as T);
			});
			sendMessageToEmbed(message);
		});
	};

	const captureIframeFallback = async () => {
		const doc = iframeRef.current?.contentDocument;
		if (!doc?.body) {
			throw new Error("Frame content is not ready yet.");
		}
		const { default: html2canvasLib } = await import("html2canvas");
		const canvas = await html2canvasLib(doc.body, {
			backgroundColor: "#ffffff",
			useCORS: true,
			scale: window.devicePixelRatio > 1 ? 2 : 1,
		});
		return canvas.toDataURL("image/png");
	};

	const requestPngExport = async () => {
		const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		try {
			const result = await requestFromEmbed<
				Extract<
					FrameEmbedToHostMessage,
					{ type: "fabric-frame:export-png-result" }
				>
			>({
				type: "fabric-frame:request-export-png",
				requestId,
			});
			if (result.error || !result.dataUrl) {
				throw new Error(result.error || "Frame export failed");
			}
			setExportNotice(null);
			return result.dataUrl;
		} catch {
			setExportNotice(
				"Used local fallback export because the embed RPC did not respond.",
			);
			return await captureIframeFallback();
		}
	};

	const handleExportJson = () => {
		if (!codeView) {
			return;
		}
		const blob = new Blob([codeView], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `${title || "frame"}.frame.json`;
		link.click();
		URL.revokeObjectURL(url);
	};

	const handleExportPng = async () => {
		setIsExporting("png");
		try {
			const dataUrl = await requestPngExport();
			const link = document.createElement("a");
			link.href = dataUrl;
			link.download = `${title || "frame"}.png`;
			link.click();
		} finally {
			setIsExporting(null);
		}
	};

	const handleExportPdf = async () => {
		setIsExporting("pdf");
		try {
			const dataUrl = await requestPngExport();
			const image = new Image();
			await new Promise((resolve, reject) => {
				image.onload = resolve;
				image.onerror = reject;
				image.src = dataUrl;
			});
			const { default: JsPDF } = await import("jspdf");
			const pdf = new JsPDF({
				orientation: kind === "slideshow" ? "landscape" : "portrait",
				unit: "px",
				format: [image.width, image.height],
			});
			pdf.addImage(dataUrl, "PNG", 0, 0, image.width, image.height);
			pdf.save(`${title || "frame"}.pdf`);
		} finally {
			setIsExporting(null);
		}
	};

	const handleFullscreen = () => {
		setIsFullscreen(true);
	};

	const handleDisplayCode = async () => {
		setShowCode(true);
		if (!iframeRef.current?.contentWindow) {
			return;
		}
		const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		try {
			await requestFromEmbed<
				Extract<
					FrameEmbedToHostMessage,
					{ type: "fabric-frame:display-code" }
				>
			>({
				type: "fabric-frame:request-display-code",
				requestId,
			});
		} catch {
			// Local code view is already available, so failure here is non-fatal.
		}
	};

	return (
		<>
			<div
				className={cn(
					isPanelPresentation ? "space-y-3" : "space-y-6",
					className,
				)}
			>
				{!hideHeader && (
					<div
						className={cn(
							"border bg-card",
							isPanelPresentation
								? "rounded-2xl px-4 py-3 shadow-none"
								: "rounded-3xl p-6 shadow-sm",
						)}
					>
						{isPanelPresentation ? (
							/* ── Panel mode: compact single-row header ── */
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
									{/* Code / Render toggle */}
									<Button
										variant="ghost"
										size="icon"
										className="h-8 w-8"
										onClick={
											showCode
												? () => setShowCode(false)
												: handleDisplayCode
										}
										title={
											showCode
												? "Show rendered frame"
												: "Show source code"
										}
									>
										{showCode ? (
											<Eye className="h-4 w-4" />
										) : (
											<Code2 className="h-4 w-4" />
										)}
									</Button>
									{/* Fullscreen */}
									<Button
										variant="ghost"
										size="icon"
										className="h-8 w-8"
										onClick={handleFullscreen}
										title="Fullscreen"
									>
										<Fullscreen className="h-4 w-4" />
									</Button>
									{/* Export dropdown */}
									{codeView ? (
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													className="h-8 w-8"
													title="Export"
													disabled={
														isExporting !== null
													}
												>
													{isExporting ? (
														<Loader2 className="h-4 w-4 animate-spin" />
													) : (
														<Download className="h-4 w-4" />
													)}
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuItem
													onClick={handleExportPng}
												>
													<PanelTop className="mr-2 h-4 w-4" />{" "}
													Export PNG
												</DropdownMenuItem>
												<DropdownMenuItem
													onClick={handleExportPdf}
												>
													<Download className="mr-2 h-4 w-4" />{" "}
													Export PDF
												</DropdownMenuItem>
												<DropdownMenuItem
													onClick={handleExportJson}
												>
													<FileJson className="mr-2 h-4 w-4" />{" "}
													Download JSON
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
									) : null}
									{/* Share dropdown */}
									{shareUrl ? (
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													className="h-8 w-8"
													title="Share"
												>
													<Share2 className="h-4 w-4" />
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuItem
													onClick={() =>
														handleCopy(shareUrl)
													}
												>
													<Copy className="mr-2 h-4 w-4" />{" "}
													Copy link
												</DropdownMenuItem>
												<DropdownMenuItem asChild>
													<a
														href={shareUrl}
														target="_blank"
														rel="noreferrer"
													>
														<ExternalLink className="mr-2 h-4 w-4" />{" "}
														Open shared view
													</a>
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
									) : frameId ? (
										<Button
											variant="ghost"
											size="icon"
											className="h-8 w-8"
											onClick={() =>
												setShareSheetOpen(true)
											}
											title="Share frame"
										>
											<Share2 className="h-4 w-4" />
										</Button>
									) : onPublish ? (
										<Button
											variant="ghost"
											size="icon"
											className="h-8 w-8"
											onClick={onPublish}
											disabled={publishPending}
											title={
												publishPending
													? "Publishing…"
													: "Publish frame"
											}
										>
											<Share2 className="h-4 w-4" />
										</Button>
									) : null}
									{/* Close */}
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
						) : (
							/* ── Page mode: full header with all controls ── */
							<>
								<div className="flex flex-wrap items-start justify-between gap-4">
									<div className="space-y-3">
										<div className="space-y-1">
											<p className="editorial-label">
												{headerMode === "public"
													? "Shared Frame"
													: "Interactive content"}
											</p>
											<h1 className="font-serif text-4xl">
												{title}
											</h1>
											{headerMode === "public" &&
											workspaceName ? (
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
												<Response>
													{description}
												</Response>
											</div>
										) : headerMode === "public" ? (
											<p className="max-w-3xl text-sm leading-7 text-muted-foreground">
												Explore a publicly shared
												interactive frame powered by
												Fabric.
											</p>
										) : null}
										<div className="flex flex-wrap gap-2">
											<Badge variant="secondary">
												{kind === "slideshow"
													? "Slideshow"
													: "Frame"}
											</Badge>
											{isPublic ? (
												<Badge>Shared</Badge>
											) : null}
											<Badge variant="outline">
												<Sparkles className="mr-1 h-3 w-3" />{" "}
												Interactive
											</Badge>
											{isSlideshow ? (
												<Badge variant="outline">
													Slide {effectiveSlide + 1}{" "}
													of {totalSlides}
												</Badge>
											) : null}
										</div>
									</div>
									<div className="flex flex-wrap items-start gap-2">
										<Button
											variant="outline"
											size="sm"
											onClick={
												showCode
													? () => setShowCode(false)
													: handleDisplayCode
											}
										>
											{showCode ? (
												<>
													<Eye className="mr-2 h-4 w-4" />{" "}
													Render
												</>
											) : (
												<>
													<Code2 className="mr-2 h-4 w-4" />{" "}
													Code
												</>
											)}
										</Button>
										<Button
											variant="outline"
											size="sm"
											onClick={handleFullscreen}
										>
											<Fullscreen className="mr-2 h-4 w-4" />{" "}
											Fullscreen
										</Button>
										{/* Export dropdown */}
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button
													variant="outline"
													size="sm"
													disabled={
														isExporting !== null
													}
												>
													{isExporting ? (
														<Loader2 className="mr-2 h-4 w-4 animate-spin" />
													) : (
														<Download className="mr-2 h-4 w-4" />
													)}
													Export
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuItem
													onClick={handleExportPng}
												>
													<PanelTop className="mr-2 h-4 w-4" />{" "}
													Export PNG
												</DropdownMenuItem>
												<DropdownMenuItem
													onClick={handleExportPdf}
												>
													<Download className="mr-2 h-4 w-4" />{" "}
													Export PDF
												</DropdownMenuItem>
												<DropdownMenuItem
													onClick={handleExportJson}
												>
													<FileJson className="mr-2 h-4 w-4" />{" "}
													Download JSON
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
										{/* Share dropdown or publish */}
										{shareUrl ? (
											<DropdownMenu>
												<DropdownMenuTrigger asChild>
													<Button
														variant="outline"
														size="sm"
													>
														<Share2 className="mr-2 h-4 w-4" />{" "}
														Share
													</Button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end">
													<DropdownMenuItem
														onClick={() =>
															handleCopy(shareUrl)
														}
													>
														<Copy className="mr-2 h-4 w-4" />{" "}
														Copy link
													</DropdownMenuItem>
													<DropdownMenuItem asChild>
														<a
															href={shareUrl}
															target="_blank"
															rel="noreferrer"
														>
															<ExternalLink className="mr-2 h-4 w-4" />{" "}
															Open shared view
														</a>
													</DropdownMenuItem>
													{isPublic &&
													onRevokeShare ? (
														<DropdownMenuItem
															onClick={
																onRevokeShare
															}
															disabled={
																revokePending
															}
														>
															{revokePending
																? "Revoking…"
																: "Revoke share"}
														</DropdownMenuItem>
													) : null}
												</DropdownMenuContent>
											</DropdownMenu>
										) : onPublish ? (
											<Button
												variant="outline"
												size="sm"
												onClick={onPublish}
												disabled={publishPending}
											>
												<Share2 className="mr-2 h-4 w-4" />
												{publishPending
													? "Publishing…"
													: "Publish"}
											</Button>
										) : null}
									</div>
								</div>
								{exportNotice ? (
									<p className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
										{exportNotice}
									</p>
								) : null}
							</>
						)}
					</div>
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
									Loading interactive frame…
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
								onLoad={() => {
									window.setTimeout(
										() => setIframeLoading(false),
										350,
									);
									const iframe = iframeRef.current;
									if (!iframe) {
										return;
									}
									const measure = () => {
										try {
											const doc = iframe.contentDocument;
											if (!doc?.body) {
												return;
											}
											const html = doc.documentElement;
											const body = doc.body;
											const prevHtmlH = html.style.height;
											const prevBodyH = body.style.height;
											html.style.height = "auto";
											body.style.height = "auto";
											const h = Math.max(
												html.scrollHeight,
												body.scrollHeight,
											);
											html.style.height = prevHtmlH;
											body.style.height = prevBodyH;
											if (h > 200) {
												setFrameHeight((prev) =>
													Math.max(
														prev,
														Math.min(h + 24, 6000),
													),
												);
											}
										} catch {
											/* cross-origin */
										}
									};
									for (const delay of [300, 900, 2000]) {
										window.setTimeout(measure, delay);
									}
								}}
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

			{/* Share Sheet */}
			{frameId && (
				<ShareFrameSheet
					frameId={frameId}
					organizationId={organizationId}
					open={shareSheetOpen}
					onOpenChange={setShareSheetOpen}
				/>
			)}
		</>
	);
}
