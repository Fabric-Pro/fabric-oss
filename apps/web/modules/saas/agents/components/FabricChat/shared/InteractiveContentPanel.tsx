"use client";

import type { FrameDocumentView } from "@saas/frames/components/FrameRenderer";
import { FrameVizShell } from "@saas/frames/components/FrameVizShell";
import type { FrameToolResult } from "@saas/frames/lib/frame-result";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const DEFAULT_PANEL_WIDTH = 520;
const MIN_PANEL_WIDTH = 360;
const MAX_PANEL_WIDTH = 860;
const PANEL_WIDTH_STORAGE_KEY = "fabric-interactive-content-panel-width";

function clampPanelWidth(value: number) {
	return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, value));
}

export function InteractiveContentPanel({
	frame,
	onClose,
	organizationId,
}: {
	frame: FrameToolResult;
	onClose: () => void;
	organizationId?: string | null;
}) {
	const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
	const [isCollapsed, setIsCollapsed] = useState(false);
	const resizingRef = useRef(false);
	// Only open the Sheet on small screens (below lg breakpoint = 1024px).
	// On large screens the sidebar panel is used and the Sheet overlay must NOT
	// be mounted — it would blur the entire page even when hidden via lg:hidden.
	const [isSmallScreen, setIsSmallScreen] = useState(false);

	useEffect(() => {
		const mq = window.matchMedia("(max-width: 1023px)");
		setIsSmallScreen(mq.matches);
		const handler = (e: MediaQueryListEvent) => setIsSmallScreen(e.matches);
		mq.addEventListener("change", handler);
		return () => mq.removeEventListener("change", handler);
	}, []);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		const storedWidth = window.localStorage.getItem(
			PANEL_WIDTH_STORAGE_KEY,
		);
		if (!storedWidth) {
			return;
		}
		const parsedWidth = Number(storedWidth);
		if (Number.isFinite(parsedWidth)) {
			setPanelWidth(clampPanelWidth(parsedWidth));
		}
	}, []);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		window.localStorage.setItem(
			PANEL_WIDTH_STORAGE_KEY,
			String(panelWidth),
		);
	}, [panelWidth]);

	useEffect(() => {
		const handlePointerMove = (event: MouseEvent) => {
			if (!resizingRef.current) {
				return;
			}
			setPanelWidth(clampPanelWidth(window.innerWidth - event.clientX));
		};

		const handlePointerUp = () => {
			resizingRef.current = false;
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
		};

		window.addEventListener("mousemove", handlePointerMove);
		window.addEventListener("mouseup", handlePointerUp);
		return () => {
			window.removeEventListener("mousemove", handlePointerMove);
			window.removeEventListener("mouseup", handlePointerUp);
		};
	}, []);

	const frameQuery = useQuery({
		queryKey: ["interactive-frame", frame.frameId, organizationId ?? null],
		queryFn: () =>
			orpcClient.frames.get({
				id: frame.frameId,
				organizationId: organizationId ?? null,
			}),
		enabled: Boolean(frame.frameId),
	});

	const frameDocument = frameQuery.data?.document as
		| FrameDocumentView
		| undefined;
	const resolvedTitle = frameQuery.data?.title || frame.title || "Frame";
	const resolvedDescription =
		frameQuery.data?.description || frame.description || frame.response;
	const resolvedKind = frameQuery.data?.kind || frame.kind || "frame";
	const resolvedContentType =
		frameQuery.data?.contentType || frame.contentType || undefined;
	const embedUrl = frame.embedUrl ?? frame.frameUrl;

	const panelBody = (
		<div className="h-full overflow-y-auto bg-muted/20 p-2 sm:p-3">
			{embedUrl ? (
				<FrameVizShell
					title={resolvedTitle}
					description={resolvedDescription}
					kind={resolvedKind}
					contentType={resolvedContentType}
					embedUrl={embedUrl}
					frameUrl={frame.frameUrl}
					shareUrl={frame.shareUrl}
					frameDocument={frameDocument}
					presentation="panel"
					onClose={onClose}
					className="pb-4"
				/>
			) : (
				<div className="flex h-full min-h-[240px] items-center justify-center rounded-2xl border bg-card px-6 text-center text-sm text-muted-foreground">
					Interactive preview unavailable for this frame.
				</div>
			)}
		</div>
	);

	return (
		<>
			<div
				className="relative hidden h-full shrink-0 border-l border-border/70 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:flex lg:flex-row"
				style={{ width: isCollapsed ? 32 : panelWidth }}
			>
				{/* Collapse toggle — always visible on the left edge */}
				<div className="absolute left-0 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2">
					<Button
						variant="outline"
						size="icon"
						className="h-6 w-6 rounded-full border bg-background shadow-md"
						onClick={() => setIsCollapsed((v) => !v)}
						aria-label={
							isCollapsed ? "Expand panel" : "Collapse panel"
						}
					>
						{isCollapsed ? (
							<ChevronLeft className="h-3 w-3" />
						) : (
							<ChevronRight className="h-3 w-3" />
						)}
					</Button>
				</div>
				{!isCollapsed && (
					<>
						<button
							type="button"
							onMouseDown={() => {
								resizingRef.current = true;
								document.body.style.cursor = "col-resize";
								document.body.style.userSelect = "none";
							}}
							className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-border/80"
							aria-label="Resize interactive content panel"
						/>
						<div className="pointer-events-none absolute bottom-0 left-0 top-0 w-px bg-border/80" />
						{panelBody}
					</>
				)}
			</div>
			<Sheet
				open={isSmallScreen}
				onOpenChange={(open) => !open && onClose()}
			>
				<SheetContent className="w-full p-0 sm:max-w-4xl lg:hidden">
					<SheetHeader className="sr-only">
						<SheetTitle>{resolvedTitle}</SheetTitle>
					</SheetHeader>
					{panelBody}
				</SheetContent>
			</Sheet>
		</>
	);
}
