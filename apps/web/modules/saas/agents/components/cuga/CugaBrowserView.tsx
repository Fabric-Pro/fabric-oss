"use client";

/**
 * CugaBrowserView
 *
 * Displays browser state from CUGA's browser agent including:
 * - Screenshot of the current page
 * - DOM element overlays with BID markers
 * - Current browser action indicator
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { ScrollArea } from "@ui/components/scroll-area";
import { cn } from "@ui/lib";
import {
	ArrowLeft,
	ChevronDown,
	ChevronRight,
	Globe,
	Maximize2,
	Minimize2,
	MousePointer,
	RefreshCw,
	Type,
} from "lucide-react";
import Image from "next/image";
import { useMemo, useState } from "react";

/** Browser element with BID marker */
interface BrowserElement {
	bid: string;
	tag: string;
	text?: string;
	bbox?: { x: number; y: number; width: number; height: number };
	isActive?: boolean;
}

/** Browser action being performed */
interface BrowserAction {
	type:
		| "click"
		| "type"
		| "select_option"
		| "scroll"
		| "go_back"
		| "navigate";
	bid?: string;
	value?: string;
	status: "pending" | "executing" | "complete" | "failed";
	error?: string;
}

/** Browser state snapshot */
interface BrowserState {
	screenshot: string;
	url: string;
	elements?: BrowserElement[];
	viewport?: { width: number; height: number };
}

interface CugaBrowserViewProps {
	browserState?: BrowserState;
	browserAction?: BrowserAction;
	className?: string;
}

const ACTION_ICONS: Record<BrowserAction["type"], React.ReactNode> = {
	click: <MousePointer className="h-3 w-3" />,
	type: <Type className="h-3 w-3" />,
	select_option: <ChevronDown className="h-3 w-3" />,
	scroll: <ChevronDown className="h-3 w-3" />,
	go_back: <ArrowLeft className="h-3 w-3" />,
	navigate: <Globe className="h-3 w-3" />,
};

const ACTION_LABELS: Record<BrowserAction["type"], string> = {
	click: "Click",
	type: "Type",
	select_option: "Select",
	scroll: "Scroll",
	go_back: "Go Back",
	navigate: "Navigate",
};

export function CugaBrowserView({
	browserState,
	browserAction,
	className,
}: CugaBrowserViewProps) {
	const [isExpanded, setIsExpanded] = useState(true);
	const [showOverlays, setShowOverlays] = useState(true);

	// Find the active element for highlighting
	const _activeElement = useMemo(() => {
		if (!browserAction?.bid || !browserState?.elements) {
			return null;
		}
		return browserState.elements.find((el) => el.bid === browserAction.bid);
	}, [browserAction?.bid, browserState?.elements]);

	if (!browserState?.screenshot) {
		return null;
	}

	return (
		<div
			className={cn(
				"rounded-lg border bg-card overflow-hidden",
				className,
			)}
		>
			{/* Header */}
			<div className="flex items-center justify-between p-3 border-b bg-muted/50">
				<div className="flex items-center gap-2">
					<Globe className="h-4 w-4 text-muted-foreground" />
					<span className="text-sm font-medium">Browser View</span>
					{browserAction && (
						<Badge
							variant="secondary"
							className={cn(
								"text-xs",
								browserAction.status === "executing" &&
									"bg-blue-100 text-blue-700",
								browserAction.status === "complete" &&
									"bg-green-100 text-green-700",
								browserAction.status === "failed" &&
									"bg-red-100 text-red-700",
							)}
						>
							{ACTION_ICONS[browserAction.type]}
							<span className="ml-1">
								{ACTION_LABELS[browserAction.type]}
							</span>
							{browserAction.bid && (
								<span className="ml-1 opacity-70">
									#{browserAction.bid}
								</span>
							)}
						</Badge>
					)}
				</div>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="sm"
						className="h-7 w-7 p-0"
						onClick={() => setShowOverlays(!showOverlays)}
						title={showOverlays ? "Hide overlays" : "Show overlays"}
					>
						{showOverlays ? (
							<Minimize2 className="h-3 w-3" />
						) : (
							<Maximize2 className="h-3 w-3" />
						)}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 w-7 p-0"
						onClick={() => setIsExpanded(!isExpanded)}
					>
						{isExpanded ? (
							<ChevronDown className="h-4 w-4" />
						) : (
							<ChevronRight className="h-4 w-4" />
						)}
					</Button>
				</div>
			</div>

			{isExpanded && (
				<>
					{/* URL Bar */}
					{browserState.url && (
						<div className="px-3 py-2 border-b bg-muted/30 flex items-center gap-2">
							<RefreshCw className="h-3 w-3 text-muted-foreground" />
							<code className="text-xs text-muted-foreground truncate flex-1">
								{browserState.url}
							</code>
						</div>
					)}

					{/* Screenshot with Overlays */}
					<div className="relative">
						<ScrollArea className="max-h-96">
							<Image
								src={`data:image/png;base64,${browserState.screenshot}`}
								alt="Browser screenshot"
								width={1200}
								height={800}
								unoptimized
								className="w-full h-auto"
							/>
						</ScrollArea>
					</div>
				</>
			)}
		</div>
	);
}
