/**
 * How chat answers a diagram request — pure data, shared by the Direct chat
 * activity and the orchestrator workflow's system prompt. Workflow-sandbox
 * safe.
 *
 * Both chat surfaces render a ```mermaid fenced block as a diagram inline, so
 * a plain "draw / diagram / flowchart / sequence" request is answered in the
 * message. A frame (side panel) or Excalidraw canvas is created only when the
 * user asks for one.
 */
export const DIAGRAM_RENDERING_GUIDANCE = `DIAGRAMS:
- The chat renders a \`\`\`mermaid fenced code block as a diagram inline. For a diagram, flowchart, sequence diagram, state/ER/class diagram or "draw this flow" request, answer with a \`\`\`mermaid block in your reply — do not call a tool for it.
- For a diagram, call fabric_create_frame only when the user explicitly asks for a frame, a slide/slideshow, a dashboard or an interactive/HTML page.
- Call an Excalidraw tool (e.g. create_view) only when the user explicitly asks for a hand-drawn, whiteboard or Excalidraw diagram. Never call it for conversational replies, questions, status updates or option discussions — when in doubt, answer in text.`;

const INLINE_DIAGRAM_PATTERNS = [
	"mermaid",
	"diagram",
	"flowchart",
	"flow chart",
	"sequence chart",
];

const EXPLICIT_ARTIFACT_PATTERNS = [
	"frame",
	"slide",
	"dashboard",
	"interactive",
	"html",
	"excalidraw",
	"whiteboard",
];

/**
 * True when the message asks for a diagram that belongs inline as mermaid —
 * a diagram word without an explicit frame / slide / interactive-page ask.
 * Frame-forcing keyword detection yields to it.
 */
export function isInlineDiagramRequest(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		INLINE_DIAGRAM_PATTERNS.some((pattern) => lower.includes(pattern)) &&
		!EXPLICIT_ARTIFACT_PATTERNS.some((pattern) => lower.includes(pattern))
	);
}
