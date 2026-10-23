import { PROPOSAL_THEME_ATTRIBUTE } from "@repo/utils/proposal-artifact/proposal-theme";
import {
	type UIEvent,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	type DiagramSizing,
	diagramDisplayWidth,
	readSvgNaturalSize,
} from "./mermaid-diagram-sizing";

type ScrollEdge = "start" | "middle" | "end";

/** Where a scrolling diagram stands: at its start, in the middle or at its end. */
function scrollEdgeOf(area: HTMLElement): ScrollEdge {
	if (area.scrollLeft <= 0) {
		return "start";
	}
	return area.scrollLeft >= area.scrollWidth - area.clientWidth - 1
		? "end"
		: "middle";
}

/**
 * The live width of a rendered diagram (Fizzy #2946). Inside the theme root
 * a diagram is never drawn with labels below the minimum: one that would
 * need to be wider than its column scrolls, and its scroll edge is tracked.
 *
 * `showCode`, `error` and `mounted` decide whether the diagram area is in
 * the DOM, so a change to any of them measures again.
 */
export function useMermaidDiagramSizing(
	svg: string,
	{
		showCode,
		error,
		mounted,
	}: { showCode: boolean; error: string | null; mounted: boolean },
) {
	const areaRef = useRef<HTMLDivElement>(null);
	const [sizing, setSizing] = useState<DiagramSizing | null>(null);
	const [scrollEdge, setScrollEdge] = useState<ScrollEdge>("start");

	useLayoutEffect(() => {
		const area = areaRef.current;
		const natural = svg ? readSvgNaturalSize(svg) : null;
		if (
			!area ||
			!natural ||
			!area.closest(`[${PROPOSAL_THEME_ATTRIBUTE}="live"]`)
		) {
			setSizing(null);
			return;
		}
		const measure = () => {
			const style = window.getComputedStyle(area);
			const column =
				area.clientWidth -
				(Number.parseFloat(style.paddingLeft) || 0) -
				(Number.parseFloat(style.paddingRight) || 0);
			const next = diagramDisplayWidth({
				naturalWidth: natural.width,
				labelPx: natural.labelPx,
				columnWidth: column,
			});
			setSizing((previous) =>
				previous?.width === next.width &&
				previous.scrollable === next.scrollable
					? previous
					: next,
			);
		};
		measure();
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(area);
		return () => observer.disconnect();
	}, [svg, showCode, error, mounted]);

	const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
		setScrollEdge(scrollEdgeOf(event.currentTarget));
	}, []);

	return { areaRef, sizing, scrollEdge, onScroll };
}
