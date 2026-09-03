"use client";

import { cn } from "@ui/lib";
import html2canvas from "html2canvas";
import DOMPurify from "isomorphic-dompurify";
import { useEffect, useMemo, useRef } from "react";
import { Response } from "../../../../components/ai-elements/response";
import { Mermaid } from "../../../marketing/blog/components/Mermaid";
import {
	type FrameEmbedToHostMessage,
	isFrameHostToEmbedMessage,
} from "../lib/frame-embed-protocol";

/**
 * Sanitizes HTML content for safe iframe rendering.
 * Allows styles, scripts (for charts), and common HTML elements.
 */
function sanitizeHtmlContent(dirty: string): string {
	return DOMPurify.sanitize(dirty, {
		ALLOWED_TAGS: [
			"!doctype",
			"html",
			"head",
			"body",
			"title",
			"meta",
			"link",
			"style",
			"script",
			"div",
			"span",
			"p",
			"h1",
			"h2",
			"h3",
			"h4",
			"h5",
			"h6",
			"br",
			"hr",
			"a",
			"img",
			"svg",
			"path",
			"circle",
			"rect",
			"line",
			"polyline",
			"polygon",
			"g",
			"defs",
			"use",
			"text",
			"tspan",
			"table",
			"thead",
			"tbody",
			"tr",
			"th",
			"td",
			"ul",
			"ol",
			"li",
			"dl",
			"dt",
			"dd",
			"b",
			"i",
			"strong",
			"em",
			"small",
			"big",
			"sub",
			"sup",
			"code",
			"pre",
			"kbd",
			"samp",
			"var",
			"mark",
			"ins",
			"del",
			"blockquote",
			"q",
			"cite",
			"abbr",
			"address",
			"time",
			"progress",
			"meter",
			"details",
			"summary",
			"figure",
			"figcaption",
			"canvas",
			"button",
			"input",
			"label",
			"select",
			"option",
			"textarea",
			"form",
			"fieldset",
			"legend",
			"header",
			"footer",
			"main",
			"section",
			"article",
			"aside",
			"nav",
			"template",
		],
		ALLOWED_ATTR: [
			"class",
			"id",
			"style",
			"title",
			"alt",
			"src",
			"href",
			"target",
			"rel",
			"width",
			"height",
			"viewBox",
			"fill",
			"stroke",
			"stroke-width",
			"d",
			"cx",
			"cy",
			"r",
			"x",
			"y",
			"x1",
			"y1",
			"x2",
			"y2",
			"points",
			"transform",
			"xmlns",
			"version",
			"lang",
			"charset",
			"name",
			"content",
			"type",
			"media",
			"defer",
			"async",
			"crossorigin",
			"integrity",
			"role",
			"aria-*",
			"data-*",
			"for",
			"value",
			"placeholder",
			"checked",
			"selected",
			"disabled",
			"readonly",
			"multiple",
			"min",
			"max",
			"step",
			"pattern",
			"required",
			"dir",
			"lang",
		],
		ALLOW_DATA_ATTR: true,
		SANITIZE_DOM: true,
		ADD_ATTR: ["target", "rel"],
		ADD_TAGS: ["iframe"],
	});
}

interface FrameBlockView {
	id: string;
	type: "html" | "json" | "mermaid" | "markdown";
	title?: string;
	content: string;
	language?: string;
}

export interface FrameDocumentView {
	version: 1;
	kind: "frame" | "slideshow";
	title: string;
	description?: string;
	blocks: FrameBlockView[];
	theme?: {
		mode?: "light" | "dark" | "system";
		accentColor?: string;
	};
	metadata?: {
		format?: "html" | "json" | "mermaid" | "markdown";
		generatedByTool?: string;
		conversationId?: string;
		authoritySessionId?: string;
		providerKeys?: string[];
		sourceRunType?: string;
		sourceRunId?: string;
	};
}

export function FrameRenderer({
	frame,
	embedded = false,
	className,
	slideIndex,
}: {
	frame: FrameDocumentView;
	embedded?: boolean;
	className?: string;
	slideIndex?: number;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const visibleBlocks = useMemo(() => {
		if (
			frame.kind === "slideshow" &&
			typeof slideIndex === "number" &&
			slideIndex >= 0 &&
			slideIndex < frame.blocks.length
		) {
			return [frame.blocks[slideIndex]];
		}
		return frame.blocks;
	}, [frame, slideIndex]);

	useEffect(() => {
		if (!embedded || typeof window === "undefined" || !rootRef.current) {
			return;
		}

		const postToHost = (message: FrameEmbedToHostMessage) => {
			window.parent.postMessage(message, "*");
		};

		const notifyHeight = () => {
			const height = rootRef.current?.scrollHeight ?? 0;
			postToHost({
				type: "fabric-frame:set-height",
				height,
				frameTitle: frame.title,
			});
		};

		const handleMessage = async (event: MessageEvent) => {
			// The embed view is deliberately framable by any origin (proxy.ts
			// exempts `.../embed` from `frame-ancestors 'self'`), so any page
			// that frames it can post to it. Only this app drives the RPC —
			// `request-export-png` answers with a PNG of the rendered frame,
			// which a foreign framing page must not be able to ask for. The
			// outbound `ready` / `set-height` notices below stay broadcast, so
			// third-party auto-sizing keeps working.
			if (event.origin !== window.location.origin) {
				return;
			}
			if (!isFrameHostToEmbedMessage(event.data)) {
				return;
			}

			if (event.data.type === "fabric-frame:request-display-code") {
				postToHost({
					type: "fabric-frame:display-code",
					requestId: event.data.requestId,
				});
				return;
			}

			if (event.data.type === "fabric-frame:request-export-png") {
				try {
					if (!rootRef.current) {
						throw new Error("Frame root is unavailable");
					}
					const canvas = await html2canvas(rootRef.current, {
						backgroundColor: "#ffffff",
						useCORS: true,
						scale: window.devicePixelRatio > 1 ? 2 : 1,
					});
					postToHost({
						type: "fabric-frame:export-png-result",
						requestId: event.data.requestId,
						dataUrl: canvas.toDataURL("image/png"),
					});
				} catch (error) {
					postToHost({
						type: "fabric-frame:export-png-result",
						requestId: event.data.requestId,
						error:
							error instanceof Error
								? error.message
								: "Failed to export frame as PNG",
					});
				}
			}
		};

		const observer = new ResizeObserver(() => notifyHeight());
		observer.observe(rootRef.current);
		window.addEventListener("message", handleMessage);
		window.addEventListener("load", notifyHeight);
		window.requestAnimationFrame(() => {
			postToHost({ type: "fabric-frame:ready", frameTitle: frame.title });
			notifyHeight();
		});

		return () => {
			observer.disconnect();
			window.removeEventListener("message", handleMessage);
			window.removeEventListener("load", notifyHeight);
		};
	}, [embedded, frame.title]);

	return (
		<div
			ref={rootRef}
			className={cn(
				"space-y-6",
				embedded && "min-h-full bg-background p-4 md:p-6",
				className,
			)}
		>
			{visibleBlocks.map((block, index) => (
				<section
					key={block.id}
					className={cn(
						"overflow-hidden",
						!embedded && "rounded-2xl border bg-card shadow-sm",
						frame.kind === "slideshow" &&
							"min-h-[70vh] rounded-3xl p-0",
						frame.kind !== "slideshow" &&
							(embedded ? "" : "p-4 md:p-5"),
					)}
				>
					<div
						className={cn(
							frame.kind === "slideshow"
								? "border-b px-6 py-4"
								: block.title
									? "mb-3"
									: "hidden",
						)}
					>
						{block.title ? (
							<h2
								className={cn(
									frame.kind === "slideshow"
										? "font-serif text-2xl md:text-3xl"
										: "font-semibold text-lg",
								)}
							>
								{block.title}
							</h2>
						) : frame.kind === "slideshow" ? (
							<p className="editorial-label">
								Slide{" "}
								{slideIndex !== undefined
									? slideIndex + 1
									: index + 1}
							</p>
						) : null}
					</div>
					<div
						className={cn(
							frame.kind === "slideshow" &&
								"px-6 py-6 md:px-8 md:py-8",
						)}
					>
						<FrameBlockRenderer block={block} />
					</div>
				</section>
			))}
		</div>
	);
}

function HtmlBlockFrame({ block }: { block: FrameBlockView }) {
	const iframeRef = useRef<HTMLIFrameElement>(null);

	// Sanitize HTML content before rendering
	const sanitizedContent = useMemo(() => {
		return sanitizeHtmlContent(block.content);
	}, [block.content]);

	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe) {
			return;
		}

		const resize = () => {
			try {
				const doc = iframe.contentDocument;
				if (!doc?.body) {
					return;
				}
				const html = doc.documentElement;
				const body = doc.body;

				// Temporarily remove height/overflow constraints that could clamp scrollHeight
				const prevHtmlHeight = html.style.height;
				const prevHtmlOverflow = html.style.overflow;
				const prevBodyHeight = body.style.height;
				const prevBodyOverflow = body.style.overflow;
				const prevBodyMinHeight = body.style.minHeight;

				html.style.height = "auto";
				html.style.overflow = "visible";
				body.style.height = "auto";
				body.style.overflow = "visible";
				body.style.minHeight = "0";

				const h = Math.max(
					html.scrollHeight,
					body.scrollHeight,
					body.offsetHeight,
				);

				// Restore
				html.style.height = prevHtmlHeight;
				html.style.overflow = prevHtmlOverflow;
				body.style.height = prevBodyHeight;
				body.style.overflow = prevBodyOverflow;
				body.style.minHeight = prevBodyMinHeight;

				if (h > 0) {
					iframe.style.height = `${h}px`;
				}
			} catch {
				// cross-origin — leave height unchanged
			}
		};

		const onLoad = () => {
			resize();
			// Retry after dynamic content (charts, fonts, images) finishes rendering
			setTimeout(resize, 400);
			setTimeout(resize, 1200);
		};

		iframe.addEventListener("load", onLoad);
		return () => iframe.removeEventListener("load", onLoad);
	}, [sanitizedContent]);

	return (
		<iframe
			ref={iframeRef}
			title={block.title || block.id}
			sandbox="allow-scripts allow-same-origin"
			srcDoc={sanitizedContent}
			scrolling="no"
			className="w-full"
			style={{ height: 480, border: "none", overflow: "hidden" }}
		/>
	);
}

function FrameBlockRenderer({ block }: { block: FrameBlockView }) {
	switch (block.type) {
		case "html":
			return <HtmlBlockFrame block={block} />;
		case "mermaid":
			return <Mermaid chart={block.content} />;
		case "json":
			return (
				<pre className="overflow-x-auto rounded-xl border bg-muted p-4 text-sm">
					<code>{block.content}</code>
				</pre>
			);
		case "markdown":
			return (
				<div className="p-4 md:p-6">
					<Response>{block.content}</Response>
				</div>
			);
		default:
			return (
				<pre className="overflow-x-auto rounded-xl border bg-muted p-4 text-sm">
					<code>{block.content}</code>
				</pre>
			);
	}
}
