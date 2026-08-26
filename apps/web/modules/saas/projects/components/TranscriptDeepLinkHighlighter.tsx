"use client";

/**
 * #1896 — deep-link scroll-to-line for the full-screen transcript reader.
 *
 * The reader (`MeetingTranscriptPageView`) renders the transcript as one
 * ReactMarkdown blob, so a stored 1-based line number isn't a distinct DOM
 * node. Given the raw `content`, this resolves `#t-<line>` to that line's text
 * and finds it inside the rendered article via a TreeWalker text search, then
 * scrolls it into view, flashes a highlight, and announces the landing to
 * assistive tech. Any failure (bad hash, out-of-range line, text not found
 * after hydration retries) is a silent no-op — the page just stays at the top.
 */
import { useEffect, useState } from "react";

const CONTAINER_SELECTOR = '[data-testid="meeting-transcript-markdown"]';
const MAX_RETRIES = 10; // ~2s hydration window.

export function TranscriptDeepLinkHighlighter({
	content,
}: {
	content: string;
}) {
	const [announcement, setAnnouncement] = useState("");

	useEffect(() => {
		const match = /^#t-(\d{1,6})$/.exec(window.location.hash);
		if (!match) {
			return;
		}
		const rawLine = content.split("\n")[Number(match[1]) - 1]?.trim();
		if (!rawLine) {
			return;
		}
		// Markdown may restyle the "Speaker:" prefix, so search for the
		// utterance text itself, falling back to the whole line.
		const needle =
			rawLine.replace(/^[^:\n]{1,80}:\s*/, "").trim() || rawLine;

		let cancelled = false;
		let retries = 0;
		let announceTimer: ReturnType<typeof setTimeout> | undefined;

		const tryScroll = () => {
			if (cancelled) {
				return;
			}
			const container = document.querySelector(CONTAINER_SELECTOR);
			const range = container ? findTextRange(container, needle) : null;
			if (!range) {
				if (retries >= MAX_RETRIES) {
					return;
				}
				retries += 1;
				setTimeout(tryScroll, 200);
				return;
			}
			const rect = range.getBoundingClientRect();
			window.scrollTo({
				top: window.scrollY + rect.top - window.innerHeight / 2,
				behavior: prefersReducedMotion() ? "auto" : "smooth",
			});
			flashRange(range);
			setAnnouncement(`Jumped to transcript: ${needle.slice(0, 120)}`);
			announceTimer = setTimeout(() => setAnnouncement(""), 4000);
		};
		tryScroll();
		return () => {
			cancelled = true;
			if (announceTimer !== undefined) {
				clearTimeout(announceTimer);
			}
		};
	}, [content]);

	return (
		<div aria-live="polite" className="sr-only">
			{announcement}
		</div>
	);
}

function prefersReducedMotion(): boolean {
	return (
		window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ===
		true
	);
}

/** First text node containing `needle`, as a Range over just the needle. */
function findTextRange(root: Element, needle: string): Range | null {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let node: Node | null = walker.nextNode();
	while (node) {
		const at = node.textContent?.indexOf(needle) ?? -1;
		if (at !== -1) {
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + needle.length);
			return range;
		}
		node = walker.nextNode();
	}
	return null;
}

/**
 * Flash the quoted range. Prefers the CSS Custom Highlight API (precise, no DOM
 * mutation); falls back to animating the containing element's background.
 */
const HIGHLIGHT_STYLE_ID = "transcript-anchor-highlight";

/**
 * Lightning CSS (Turbopack's optimizer) can't parse the `::highlight()`
 * pseudo-element yet, so the rule is injected here — only on the Custom
 * Highlight API path that needs it — instead of living in globals.css.
 */
function ensureHighlightStyle() {
	if (document.getElementById(HIGHLIGHT_STYLE_ID)) {
		return;
	}
	const style = document.createElement("style");
	style.id = HIGHLIGHT_STYLE_ID;
	style.textContent =
		"::highlight(transcript-anchor){background-color:color-mix(in srgb, var(--primary) 25%, transparent)}";
	document.head.appendChild(style);
}

function flashRange(range: Range) {
	const highlights = (CSS as unknown as { highlights?: Map<string, unknown> })
		.highlights;
	const HighlightCtor = (
		globalThis as unknown as { Highlight?: new (range: Range) => unknown }
	).Highlight;
	if (highlights && HighlightCtor) {
		ensureHighlightStyle();
		highlights.set("transcript-anchor", new HighlightCtor(range));
		setTimeout(() => highlights.delete("transcript-anchor"), 2500);
		return;
	}
	const el = range.startContainer.parentElement;
	if (!el) {
		return;
	}
	const flashColor = "color-mix(in srgb, var(--primary) 20%, transparent)";
	if (prefersReducedMotion() || typeof el.animate !== "function") {
		el.style.backgroundColor = flashColor;
		setTimeout(() => {
			el.style.backgroundColor = "";
		}, 1500);
		return;
	}
	el.animate(
		[{ backgroundColor: flashColor }, { backgroundColor: "transparent" }],
		{ duration: 1500, easing: "ease-out" },
	);
}
