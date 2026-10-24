import { getAIModelWithMetadata } from "@repo/ai";
import { findAiUsageLimitError } from "@repo/ai/lib/find-usage-limit-error";
import { computeMaxOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import type { FrameBlock } from "@repo/database";
import { logger } from "@repo/logs";
import { rethrowIfDispatchStopped } from "@repo/utils/dispatch-guard";
import { Context, heartbeat } from "@temporalio/activity";
import { streamText } from "ai";
import type { FrameGenerationSpec, FrameOutputFormat } from "./frame-args";

/**
 * Writing a frame's pages with the configured model, for a caller that gave
 * a description instead of the pages. A caller that wrote the HTML itself - an
 * agent making a Workspace or an artifact - never comes here.
 */

const FRAME_LLM_ABORT_MS = 240_000;
const FRAME_HEARTBEAT_INTERVAL_MS = 1_000;

function safeHeartbeat(details?: unknown) {
	try {
		heartbeat(details);
	} catch {
		// Outside an activity context (e.g. unit tests) — heartbeat is a no-op.
	}
}

function getActivityCancellationSignal(): AbortSignal | undefined {
	try {
		return Context.current().cancellationSignal;
	} catch {
		return undefined;
	}
}

const HTML_FRAME_SYSTEM_PROMPT = `You create first-class Fabric Frames — self-contained interactive HTML artifacts.

RULES:
- Output ONLY the complete HTML document. No explanation, no markdown fences.
- All CSS must be inline in <style> tags. All JS must be inline in <script> tags.
- Load nothing from the network: no <script src>, stylesheets, images or fonts from any URL. The page runs in a sandbox that blocks them, so it would render broken. Use system fonts and draw charts yourself with inline SVG or <canvas>.
- Color palette (CSS vars are NOT available inside the iframe — use these hex values):
  Primary: #9F2A3A  |  Neutral: #18181b  |  Surface: #fafaf9  |  Muted: #a1a1aa
  Success: #059669  |  Highlight: #f59e0b
- Make it visually polished. Use clean typography, subtle borders, good spacing.
- Ensure the design fills the iframe width (100%) and is responsive.
- CRITICAL: Do NOT set height on <html> or <body>. Never use height: 100vh, height: 100%, or overflow: hidden/scroll on body or html — the frame must grow to its natural content height so the viewer can auto-size it without scrollbars.
- Do NOT use document.write() or eval().
- For conceptual or text-heavy content (architecture diagrams, explanations, reports): render as a well-structured HTML document with clear sections, icons (use emoji or Unicode symbols), color-coded cards, and visual hierarchy — NOT a wall of plain text.
- For data: use inline SVG charts, tables with row striping, or stat cards.
- Always aim for a visually rich, informative artifact — never a plain white page with bullet points.`;

const SLIDE_SYSTEM_PROMPT = `You create a single slide for a Fabric slideshow — a self-contained HTML slide.

RULES:
- Output ONLY the complete HTML document for this one slide. No explanation, no markdown fences.
- The slide must fill 100% width and height of its container (use min-height: 100vh or similar).
- All CSS inline in <style>, all JS inline in <script>.
- Load nothing from the network (scripts, stylesheets, images, fonts): the sandbox blocks it. Draw any chart with inline SVG or <canvas>.
- Color palette (use hex — CSS vars not available in iframe):
  Primary: #9F2A3A  |  Neutral: #18181b  |  Surface: #fafaf9  |  Muted: #a1a1aa
- Make it look like a professional presentation slide: large headline, clear layout, focused content.
- Each slide should be complete and standalone.`;

function buildFramePrompt(input: {
	title: string;
	description: string;
	format: FrameOutputFormat;
	components: Array<{ type: string; label: string }>;
}) {
	const componentsDescription =
		input.components.length > 0
			? `\n\nComponents to include:\n${input.components.map((c) => `- ${c.type}: ${c.label}`).join("\n")}`
			: "";
	const formatInstruction =
		input.format === "html"
			? "Output ONLY the complete HTML document."
			: input.format === "json"
				? "Output ONLY valid JSON, no explanation."
				: input.format === "mermaid"
					? "Output ONLY the Mermaid diagram code, no explanation."
					: "Output ONLY Markdown, no explanation.";
	return `Title: "${input.title}"\n\n${input.description}${componentsDescription}\n\n${formatInstruction}`;
}

function buildSlidePrompt(input: {
	slideTitle: string;
	slideContent: string;
	slideIndex: number;
	totalSlides: number;
	presentationTitle: string;
}) {
	return (
		`Presentation: "${input.presentationTitle}"\n` +
		`Slide ${input.slideIndex + 1} of ${input.totalSlides}: "${input.slideTitle}"\n\n` +
		`Content for this slide:\n${input.slideContent}\n\n` +
		"Output ONLY the complete HTML document for this slide."
	);
}

/**
 * Parses the requested slide count from the description (e.g. "5-slide", "5 slides").
 * Defaults to 5 if not specified.
 */
function parseSlideCount(description: string): number {
	const match = description.match(/\b(\d+)[- ]slide/i);
	if (match) {
		const n = Number.parseInt(match[1], 10);
		if (n >= 2 && n <= 20) {
			return n;
		}
	}
	return 5;
}

/**
 * Streams text from the configured COMPLEX model with activity heartbeats and a
 * hard abort timeout. Honors workflow cancellation via the activity's
 * cancellationSignal — without it, workflow cancel would not abort the in-flight
 * LLM call and the activity would consume the full startToCloseTimeout slot.
 */
async function streamCompleteText(input: {
	userId: string;
	organizationId?: string;
	/** Usage attribution only: the chat the frame is generated for. */
	conversationId?: string;
	systemPrompt: string;
	userPrompt: string;
	heartbeatPhase: string;
}): Promise<string> {
	const { model, metadata } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId: input.userId,
			organizationId: input.organizationId,
			...(input.conversationId
				? { conversationId: input.conversationId }
				: {}),
		},
	);

	// Whole frame document from short prompts — maximal mode.
	const maxOutputTokens = computeMaxOutputTokenBudget(metadata, {
		promptChars: input.systemPrompt.length + input.userPrompt.length,
	});

	const cancellationSignal = getActivityCancellationSignal();
	const timeoutSignal = AbortSignal.timeout(FRAME_LLM_ABORT_MS);
	const abortSignal = cancellationSignal
		? AbortSignal.any([cancellationSignal, timeoutSignal])
		: timeoutSignal;

	let accumulated = "";
	let limitError: ReturnType<typeof findAiUsageLimitError>;
	let lastHeartbeatAt = 0;
	const result = streamText({
		model,
		// textStream omits error parts, including HARD usage-limit refusals.
		onError: ({ error }) => {
			const refusal = findAiUsageLimitError(error);
			if (refusal) {
				limitError ??= refusal;
			} else {
				logger.error("Frame generation stream failed", { error });
			}
		},
		instructions: input.systemPrompt,
		messages: [{ role: "user", content: input.userPrompt }],
		abortSignal,
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
	});

	safeHeartbeat({ phase: input.heartbeatPhase, chars: 0 });

	for await (const chunk of result.textStream) {
		accumulated += chunk;
		const now = Date.now();
		if (now - lastHeartbeatAt >= FRAME_HEARTBEAT_INTERVAL_MS) {
			safeHeartbeat({
				phase: input.heartbeatPhase,
				chars: accumulated.length,
			});
			lastHeartbeatAt = now;
		}
	}

	safeHeartbeat({
		phase: `${input.heartbeatPhase}.done`,
		chars: accumulated.length,
	});

	if (limitError) {
		throw limitError;
	}
	return accumulated;
}

/**
 * Generates a slide outline (titles + bullet points) for a slideshow.
 */
async function generateSlideOutline(input: {
	userId: string;
	organizationId?: string;
	conversationId?: string;
	title: string;
	description: string;
	slideCount: number;
}): Promise<Array<{ title: string; content: string }>> {
	try {
		const text = await streamCompleteText({
			userId: input.userId,
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			systemPrompt:
				"You plan presentation slide outlines. Output ONLY valid JSON — an array of objects with 'title' and 'content' fields. No explanation, no markdown fences.",
			userPrompt:
				`Create a ${input.slideCount}-slide outline for a presentation titled "${input.title}".\n\n` +
				`Description: ${input.description}\n\n` +
				`Return a JSON array with ${input.slideCount} objects, each with:\n` +
				`- "title": the slide title (short, punchy)\n` +
				`- "content": 3-5 bullet points or key facts for this slide\n\n` +
				"Output ONLY the JSON array.",
			heartbeatPhase: "frame.slide-outline",
		});
		const parsed = JSON.parse(text.trim() || "[]");
		if (Array.isArray(parsed) && parsed.length > 0) {
			return parsed.slice(0, input.slideCount).map((s: unknown) => ({
				title:
					typeof (s as { title?: unknown }).title === "string"
						? (s as { title: string }).title
						: input.title,
				content:
					typeof (s as { content?: unknown }).content === "string"
						? (s as { content: string }).content
						: "",
			}));
		}
	} catch (error) {
		// Inside a chat turn, a stop or a token-allowance refusal is not a
		// failed outline to replace with defaults (a no-op outside a turn).
		rethrowIfDispatchStopped(error);
		const limitError = findAiUsageLimitError(error);
		if (limitError) {
			throw limitError;
		}
		// fall through to defaults
	}

	// Fallback: evenly titled slides
	return Array.from({ length: input.slideCount }, (_, i) => ({
		title: i === 0 ? input.title : `Part ${i + 1}`,
		content: input.description,
	}));
}

async function generateFrameBlock(input: {
	userId: string;
	organizationId?: string;
	conversationId?: string;
	title: string;
	description: string;
	format: FrameOutputFormat;
	components: Array<{ type: string; label: string }>;
	kind: "frame" | "slideshow";
	slideIndex?: number;
	totalSlides?: number;
	presentationTitle?: string;
}): Promise<FrameBlock> {
	const isSlide =
		input.kind === "slideshow" &&
		typeof input.slideIndex === "number" &&
		typeof input.totalSlides === "number";

	const systemPrompt =
		input.format === "html"
			? isSlide
				? SLIDE_SYSTEM_PROMPT
				: HTML_FRAME_SYSTEM_PROMPT
			: "You create first-class Fabric Frames. Output only the requested frame body, never commentary.";

	const userPrompt = isSlide
		? buildSlidePrompt({
				slideTitle: input.title,
				slideContent: input.description,
				// biome-ignore lint/style/noNonNullAssertion: slideIndex/totalSlides are required for presentation frames
				slideIndex: input.slideIndex!,
				// biome-ignore lint/style/noNonNullAssertion: totalSlides is required for presentation frames
				totalSlides: input.totalSlides!,
				presentationTitle: input.presentationTitle || input.title,
			})
		: buildFramePrompt(input);

	let content = "";
	try {
		const text = await streamCompleteText({
			userId: input.userId,
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			systemPrompt,
			userPrompt,
			heartbeatPhase: isSlide ? "frame.slide-block" : "frame.block",
		});
		content = text.trim();
		// Strip markdown code fences if the LLM wrapped the output
		content = content
			.replace(/^```(?:html|json|mermaid|markdown)?\n?/, "")
			.replace(/\n?```$/, "")
			.trim();
	} catch (error) {
		// Inside a chat turn, a stop or a token-allowance refusal is not a
		// failed block to replace with placeholder content.
		rethrowIfDispatchStopped(error);
		const limitError = findAiUsageLimitError(error);
		if (limitError) {
			throw limitError;
		}
		content = "";
	}

	if (!content) {
		content =
			input.format === "json"
				? JSON.stringify(
						{
							title: input.title,
							description: input.description,
							components: input.components,
						},
						null,
						2,
					)
				: input.format === "mermaid"
					? `graph TD\n    A[${input.title}]\n    A --> B[${input.description || "Frame content"}]`
					: input.format === "markdown"
						? `# ${input.title}\n\n${input.description || ""}`
						: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;padding:2rem;background:#fafaf9;color:#18181b}</style></head><body><h1>${input.title}</h1><p>${input.description}</p></body></html>`;
	}

	return {
		id: `block-${Date.now()}-${input.slideIndex ?? 0}`,
		type:
			input.format === "markdown"
				? "markdown"
				: input.format === "json"
					? "json"
					: input.format === "mermaid"
						? "mermaid"
						: "html",
		title: input.title,
		content,
		language:
			input.format === "json"
				? "json"
				: input.format === "mermaid"
					? "mermaid"
					: input.format === "markdown"
						? "markdown"
						: "html",
	};
}

/**
 * The pages of a frame nobody wrote the HTML of: one page generated from the
 * description, or - for an HTML slideshow - an outline and a slide per entry.
 */
export async function generateFrameBlocks(input: {
	userId: string;
	organizationId?: string;
	/**
	 * The chat the frame is generated for, recorded on the usage-log rows of
	 * the generation calls. Attribution only.
	 */
	conversationId?: string;
	spec: FrameGenerationSpec;
}): Promise<FrameBlock[]> {
	const { userId, organizationId, conversationId, spec } = input;
	if (spec.kind === "slideshow" && spec.format === "html") {
		const outline = await generateSlideOutline({
			userId,
			organizationId,
			conversationId,
			title: spec.title,
			description: spec.description,
			slideCount: parseSlideCount(spec.description),
		});
		return Promise.all(
			outline.map((slide, i) =>
				generateFrameBlock({
					userId,
					organizationId,
					conversationId,
					title: slide.title,
					description: slide.content,
					format: spec.format,
					components: spec.components,
					kind: "slideshow",
					slideIndex: i,
					totalSlides: outline.length,
					presentationTitle: spec.title,
				}),
			),
		);
	}
	return [
		await generateFrameBlock({
			userId,
			organizationId,
			conversationId,
			title: spec.title,
			description: spec.description,
			format: spec.format,
			components: spec.components,
			kind: spec.kind,
		}),
	];
}
