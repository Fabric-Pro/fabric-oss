import { isInlineDiagramRequest } from "../workflows/orchestrator/diagram-rendering";

/** A request to revise a target must not force a creation tool before the model reads it. */
export function isExistingFrameRevisionRequest(message: string): boolean {
	if (explicitFrameCreationOutput(message)) {
		return false;
	}
	const target =
		"(?:frame|dashboard|wireframe|prototype|slideshow|slide[- ]deck|presentation|slides)";
	const pointer =
		"(?:(?:this|that|the|my|our|existing|current|saved|open)\\s+)(?:(?:existing|current|saved|open|interactive|fabric)\\s+){0,3}";
	return (
		new RegExp(
			`\\b(?:change|update|edit|revise|improve|refine|redesign|fix|adjust|restyle|modify)\\b[^.!?\\n]{0,80}\\b${target}\\b`,
			"i",
		).test(message) ||
		new RegExp(`\\bmake\\s+${pointer}${target}\\b`, "i").test(message)
	);
}

function explicitFrameCreationOutput(
	message: string,
): "frame" | "slideshow" | null {
	const match =
		/\b(?:create|build|generate|make|design|start)\s+(?:(?:me|us)\s+)?(?:(?:a|an)\s+)?(?:new\s+)?(?:(?:interactive|fabric)\s+){0,2}(frame|dashboard|wireframe|prototype|slideshow|slide[- ]deck|presentation)\b/i.exec(
			message,
		);
	if (
		!match ||
		/(?:do\s+not|don't|never|not)\s*$/i.test(
			message.slice(Math.max(0, match.index - 20), match.index),
		)
	) {
		return null;
	}
	return /^(?:slideshow|slide[- ]deck|presentation)$/i.test(match[1])
		? "slideshow"
		: "frame";
}

function detectDirectFrameOutput(
	message: string,
): "frame" | "slideshow" | null {
	const lower = message.toLowerCase();
	const slideshowPatterns = [
		"slideshow",
		"slide deck",
		"slide-deck",
		"slides about",
		"create slides",
		"make slides",
		"presentation",
		"presentation deck",
		"deck about",
		"5-slide",
		"5 slide",
	];
	if (slideshowPatterns.some((pattern) => lower.includes(pattern))) {
		return "slideshow";
	}

	const framePatterns = [
		"create a frame",
		"make a frame",
		"build a frame",
		"interactive frame",
		"fabric frame",
		"wireframe",
		// Visualization / chart / dashboard
		"create a visualization",
		"make a visualization",
		"generate a visualization",
		"build a visualization",
		"data visualization",
		"interactive visualization",
		"create a chart",
		"make a chart",
		"generate a chart",
		"build a chart",
		"interactive chart",
		"create a graph",
		"make a graph",
		"interactive graph",
		"create a dashboard",
		"make a dashboard",
		"build a dashboard",
		"interactive dashboard",
	];
	if (
		framePatterns.some((pattern) => lower.includes(pattern)) &&
		!isInlineDiagramRequest(message)
	) {
		return "frame";
	}

	return null;
}

function detectAdvisorFrameOutput(
	message: string,
): "frame" | "slideshow" | null {
	const lower = message.toLowerCase();
	const slideshowPatterns = [
		"slideshow",
		"slide deck",
		"slide-deck",
		"presentation",
		"presentation deck",
		"deck",
		"5-slide",
		"5 slide",
		"slides",
	];
	if (slideshowPatterns.some((pattern) => lower.includes(pattern))) {
		return "slideshow";
	}

	const framePatterns = [
		"create a frame",
		"make a frame",
		"build a frame",
		"interactive frame",
		"fabric frame",
		"wireframe",
		"dashboard",
		// Visualization / chart / dashboard
		"create a visualization",
		"make a visualization",
		"generate a visualization",
		"build a visualization",
		"data visualization",
		"interactive visualization",
		"create a chart",
		"make a chart",
		"generate a chart",
		"build a chart",
		"interactive chart",
		"create a graph",
		"make a graph",
		"interactive graph",
		"create a dashboard",
		"make a dashboard",
		"build a dashboard",
		"interactive dashboard",
	];
	if (
		framePatterns.some((pattern) => lower.includes(pattern)) &&
		!isInlineDiagramRequest(message)
	) {
		return "frame";
	}

	return null;
}

export function detectRequestedFrameOutput(
	message: string,
	engine: "direct" | "advisor",
): "frame" | "slideshow" | null {
	if (isExistingFrameRevisionRequest(message)) {
		return null;
	}
	const created = explicitFrameCreationOutput(message);
	if (created && !isInlineDiagramRequest(message)) {
		return created;
	}
	const contentRequest = message.replace(
		/\bpresentation\s*(?::|=)?\s*(?:mode\s+)?(?:to\s+)?(?:INTERFACE|DOCUMENT)\b/gi,
		"",
	);
	return engine === "direct"
		? detectDirectFrameOutput(contentRequest)
		: detectAdvisorFrameOutput(contentRequest);
}
