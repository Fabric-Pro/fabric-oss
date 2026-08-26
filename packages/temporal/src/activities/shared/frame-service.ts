import { getAIModelWithMetadata } from "@repo/ai";
import { computeMaxOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	createFrame,
	type FrameBlock,
	getFrameById,
	listFrames,
	publishFrame,
	updateFrame,
} from "@repo/database";
import { Context, heartbeat } from "@temporalio/activity";
import { streamText } from "ai";

export type FrameOutputFormat = "html" | "json" | "mermaid" | "markdown";

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

function deriveFrameTitle(params: {
	args: Record<string, unknown> | undefined;
	kind: "frame" | "slideshow";
}) {
	const rawDescription =
		getRawString(params.args, ["description", "prompt", "summary"]) || "";
	const cleaned = rawDescription
		.replace(/^create\s+(?:a|an)?\s*/i, "")
		.replace(/^make\s+(?:a|an)?\s*/i, "")
		.replace(/^build\s+(?:a|an)?\s*/i, "")
		.replace(/^generate\s+(?:a|an)?\s*/i, "")
		.replace(/^\d+[- ]slide\s+/i, "")
		.replace(
			/^(?:slideshow|slide deck|presentation)\s+(?:about|for)\s+/i,
			"",
		)
		.replace(/^(?:frame|dashboard|report|visual)\s+(?:about|for)\s+/i, "")
		.replace(/\.$/, "")
		.trim();

	if (!cleaned) {
		return params.kind === "slideshow"
			? "Untitled Slideshow"
			: "Untitled Frame";
	}

	const words = cleaned.split(/\s+/).slice(0, 8);
	const normalized = words
		.map((word) =>
			word.length > 0
				? word.charAt(0).toUpperCase() + word.slice(1)
				: word,
		)
		.join(" ")
		.trim();

	if (!normalized) {
		return params.kind === "slideshow"
			? "Untitled Slideshow"
			: "Untitled Frame";
	}

	return params.kind === "slideshow"
		? normalized.includes("Slideshow") ||
			normalized.includes("Presentation")
			? normalized
			: `${normalized} Slideshow`
		: normalized.includes("Frame")
			? normalized
			: `${normalized} Frame`;
}

export function validateCreateFrameArgs(
	args: Record<string, unknown> | undefined,
):
	| {
			ok: true;
			value: {
				title: string;
				description: string;
				format: FrameOutputFormat;
				components: Array<{ type: string; label: string }>;
				kind: "frame" | "slideshow";
				shareOnCreate: boolean;
				blocks?: FrameBlock[];
			};
	  }
	| { ok: false; error: string } {
	const kind = normalizeKind(getNonEmptyString(args, ["kind", "frameType"]));
	const description =
		getRawString(args, ["description", "prompt", "summary"]) || "";
	const explicitTitle = getNonEmptyString(args, [
		"title",
		"frameTitle",
		"name",
	]);
	const title = explicitTitle || deriveFrameTitle({ args, kind });
	const format = normalizeFormat(getNonEmptyString(args, ["format"]));
	const blocks = normalizeInputBlocks(args?.blocks, format);

	return {
		ok: true,
		value: {
			title,
			description,
			format,
			components: normalizeComponents(args?.components),
			kind,
			shareOnCreate: Boolean(args?.shareOnCreate),
			...(blocks ? { blocks } : {}),
		},
	};
}

function normalizeInputBlocks(
	value: unknown,
	defaultFormat: FrameOutputFormat,
): FrameBlock[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		return undefined;
	}
	const normalized: FrameBlock[] = [];
	for (let i = 0; i < value.length; i++) {
		const raw = value[i];
		if (!raw || typeof raw !== "object") {
			continue;
		}
		const record = raw as Record<string, unknown>;
		const content =
			typeof record.content === "string" ? record.content : undefined;
		if (!content || content.trim().length === 0) {
			continue;
		}
		const declaredType =
			typeof record.type === "string" ? record.type : undefined;
		const type: FrameOutputFormat =
			declaredType === "html" ||
			declaredType === "json" ||
			declaredType === "mermaid" ||
			declaredType === "markdown"
				? declaredType
				: defaultFormat;
		const id =
			typeof record.id === "string" && record.id.trim().length > 0
				? record.id.trim()
				: `block-${i + 1}`;
		const titleField =
			typeof record.title === "string" ? record.title : undefined;
		const language =
			typeof record.language === "string" ? record.language : undefined;
		const block: FrameBlock = {
			id,
			type,
			content,
			...(titleField ? { title: titleField } : {}),
			...(language ? { language } : {}),
		};
		normalized.push(block);
	}
	return normalized.length > 0 ? normalized : undefined;
}

export function validateUpdateFrameArgs(
	args: Record<string, unknown> | undefined,
):
	| {
			ok: true;
			value: {
				frameId: string;
				title?: string;
				description?: string;
				blocks?: FrameBlock[];
			};
	  }
	| { ok: false; error: string } {
	const frameId = getNonEmptyString(args, ["frameId", "id"]);
	if (!frameId) {
		return {
			ok: false,
			error: "Frame ID is required. Provide `frameId` for the frame to update.",
		};
	}

	const title = getNonEmptyString(args, ["title"]);
	const description = getRawString(args, ["description"]);
	const blocks = normalizeInputBlocks(args?.blocks, "html");

	if (!title && description === undefined && !blocks) {
		return {
			ok: false,
			error: "Provide at least one update field: `title`, `description`, or `blocks`.",
		};
	}

	return { ok: true, value: { frameId, title, description, blocks } };
}

function getNonEmptyString(
	args: Record<string, unknown> | undefined,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = args?.[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function getRawString(
	args: Record<string, unknown> | undefined,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = args?.[key];
		if (typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

function normalizeFormat(value?: string): FrameOutputFormat {
	// Always use html — markdown produces plain text which renders poorly as a frame.
	// The HTML generator creates beautifully styled documents for text-heavy content.
	if (value === "json" || value === "mermaid") {
		return value;
	}
	return "html";
}

function normalizeKind(value?: string): "frame" | "slideshow" {
	return value === "slideshow" ? "slideshow" : "frame";
}

function normalizeComponents(
	value: unknown,
): Array<{ type: string; label: string }> {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((component) => {
		if (!component || typeof component !== "object") {
			return [];
		}
		const record = component as Record<string, unknown>;
		const type =
			typeof record.type === "string" && record.type.trim().length > 0
				? record.type.trim()
				: "component";
		const label =
			typeof record.label === "string" && record.label.trim().length > 0
				? record.label.trim()
				: type;
		return [{ type, label }];
	});
}

const HTML_FRAME_SYSTEM_PROMPT = `You create first-class Fabric Frames — self-contained interactive HTML artifacts.

RULES:
- Output ONLY the complete HTML document. No explanation, no markdown fences.
- All CSS must be inline in <style> tags. All JS must be inline in <script> tags.
- You may load libraries via CDN using <script src="..."> in <head>. Preferred CDNs:
  - Chart.js: https://cdn.jsdelivr.net/npm/chart.js
  - D3.js: https://cdn.jsdelivr.net/npm/d3
  - Mermaid: https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js
  - ApexCharts: https://cdn.jsdelivr.net/npm/apexcharts
- Do NOT load external images or fonts from unknown domains.
- Use Google Fonts if needed: https://fonts.googleapis.com
- Color palette (CSS vars are NOT available inside the iframe — use these hex values):
  Primary: #9F2A3A  |  Neutral: #18181b  |  Surface: #fafaf9  |  Muted: #a1a1aa
  Success: #059669  |  Highlight: #f59e0b
- Make it visually polished. Use clean typography, subtle borders, good spacing.
- Ensure the design fills the iframe width (100%) and is responsive.
- CRITICAL: Do NOT set height on <html> or <body>. Never use height: 100vh, height: 100%, or overflow: hidden/scroll on body or html — the frame must grow to its natural content height so the viewer can auto-size it without scrollbars.
- Do NOT use document.write() or eval().
- For conceptual or text-heavy content (architecture diagrams, explanations, reports): render as a well-structured HTML document with clear sections, icons (use emoji or Unicode symbols), color-coded cards, and visual hierarchy — NOT a wall of plain text.
- For data: use charts (Chart.js), tables with row striping, or stat cards.
- Always aim for a visually rich, informative artifact — never a plain white page with bullet points.`;

const SLIDE_SYSTEM_PROMPT = `You create a single slide for a Fabric slideshow — a self-contained HTML slide.

RULES:
- Output ONLY the complete HTML document for this one slide. No explanation, no markdown fences.
- The slide must fill 100% width and height of its container (use min-height: 100vh or similar).
- All CSS inline in <style>, all JS inline in <script>.
- You may load Chart.js, D3, or ApexCharts via jsdelivr CDN if the slide needs charts.
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
	systemPrompt: string;
	userPrompt: string;
	heartbeatPhase: string;
}): Promise<string> {
	const { model, metadata } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{ userId: input.userId, organizationId: input.organizationId },
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
	let lastHeartbeatAt = 0;
	const result = streamText({
		model,
		messages: [
			{ role: "system", content: input.systemPrompt },
			{ role: "user", content: input.userPrompt },
		],
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

	return accumulated;
}

/**
 * Generates a slide outline (titles + bullet points) for a slideshow.
 */
async function generateSlideOutline(input: {
	userId: string;
	organizationId?: string;
	title: string;
	description: string;
	slideCount: number;
}): Promise<Array<{ title: string; content: string }>> {
	try {
		const text = await streamCompleteText({
			userId: input.userId,
			organizationId: input.organizationId,
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
	} catch {
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
	} catch {
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

export async function createFirstClassFrame(input: {
	args: Record<string, unknown> | undefined;
	userId: string;
	organizationId?: string;
	conversationId?: string;
	sourceRunType?: string;
	sourceRunId?: string;
	authoritySessionId?: string;
	providerKeys?: string[];
}) {
	const validated = validateCreateFrameArgs(input.args);
	if (!validated.ok) {
		return { error: validated.error };
	}

	let blocks: FrameBlock[];

	if (validated.value.blocks && validated.value.blocks.length > 0) {
		// Caller produced rendered content — persist as-is and skip server-side generation.
		blocks = validated.value.blocks;
	} else if (
		validated.value.kind === "slideshow" &&
		validated.value.format === "html"
	) {
		const slideCount = parseSlideCount(validated.value.description);
		const outline = await generateSlideOutline({
			userId: input.userId,
			organizationId: input.organizationId,
			title: validated.value.title,
			description: validated.value.description,
			slideCount,
		});
		blocks = await Promise.all(
			outline.map((slide, i) =>
				generateFrameBlock({
					userId: input.userId,
					organizationId: input.organizationId,
					title: slide.title,
					description: slide.content,
					format: validated.value.format,
					components: validated.value.components,
					kind: "slideshow",
					slideIndex: i,
					totalSlides: outline.length,
					presentationTitle: validated.value.title,
				}),
			),
		);
	} else {
		const block = await generateFrameBlock({
			userId: input.userId,
			organizationId: input.organizationId,
			title: validated.value.title,
			description: validated.value.description,
			format: validated.value.format,
			components: validated.value.components,
			kind: validated.value.kind,
		});
		blocks = [block];
	}

	const frame = await createFrame({
		userId: input.userId,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		title: validated.value.title,
		description: validated.value.description,
		kind: validated.value.kind,
		blocks,
		sourceRunType: input.sourceRunType,
		sourceRunId: input.sourceRunId,
		authoritySessionId: input.authoritySessionId,
		providerKeys: input.providerKeys,
		// Always make frames public so shareUrl is always valid.
		// shareOnCreate: true by default unless explicitly disabled.
		isPublic: true,
	});
	const frameUrl = buildInternalFrameUrl(frame.id, input.organizationId);
	const embedUrl = buildInternalFrameEmbedUrl(frame.id, input.organizationId);
	const shareUrl = frame.shareToken
		? buildShareUrl(frame.shareToken)
		: undefined;
	const shareEmbedUrl = frame.shareToken
		? buildShareEmbedUrl(frame.shareToken)
		: undefined;
	return {
		frameId: frame.id,
		title: frame.title,
		description: frame.description ?? undefined,
		kind: frame.kind,
		contentType: frame.contentType,
		content: frame.document.blocks[0]?.content || "",
		frameUrl,
		embedUrl,
		shareUrl,
		shareEmbedUrl,
		response: `Frame "${frame.title}" created successfully.`,
	};
}

export async function updateFirstClassFrame(input: {
	args: Record<string, unknown> | undefined;
	userId: string;
	organizationId?: string;
}) {
	const validated = validateUpdateFrameArgs(input.args);
	if (!validated.ok) {
		return { error: validated.error };
	}
	const frame = await updateFrame({
		id: validated.value.frameId,
		userId: input.userId,
		organizationId: input.organizationId,
		title: validated.value.title,
		description: validated.value.description,
		blocks: validated.value.blocks,
	});
	if (!frame) {
		return { error: "Frame not found." };
	}
	const frameUrl = buildInternalFrameUrl(frame.id, input.organizationId);
	const embedUrl = buildInternalFrameEmbedUrl(frame.id, input.organizationId);
	const shareUrl = frame.shareToken
		? buildShareUrl(frame.shareToken)
		: undefined;
	const shareEmbedUrl = frame.shareToken
		? buildShareEmbedUrl(frame.shareToken)
		: undefined;
	return {
		frameId: frame.id,
		title: frame.title,
		description: frame.description ?? undefined,
		kind: frame.kind,
		contentType: frame.contentType,
		frameUrl,
		embedUrl,
		shareUrl,
		shareEmbedUrl,
		response: `Frame "${frame.title}" updated successfully.`,
	};
}

export async function getFirstClassFrame(input: {
	args: Record<string, unknown> | undefined;
	userId: string;
	organizationId?: string;
}) {
	const frameId = getNonEmptyString(input.args, ["frameId", "id"]);
	if (!frameId) {
		return { error: "Frame ID is required. Provide `frameId`." };
	}
	const frame = await getFrameById({
		id: frameId,
		userId: input.userId,
		organizationId: input.organizationId,
	});
	if (!frame) {
		return { error: "Frame not found." };
	}
	const frameUrl = buildInternalFrameUrl(frame.id, input.organizationId);
	const embedUrl = buildInternalFrameEmbedUrl(frame.id, input.organizationId);
	const shareUrl = frame.shareToken
		? buildShareUrl(frame.shareToken)
		: undefined;
	const shareEmbedUrl = frame.shareToken
		? buildShareEmbedUrl(frame.shareToken)
		: undefined;
	return {
		frameId: frame.id,
		title: frame.title,
		description: frame.description,
		kind: frame.kind,
		contentType: frame.contentType,
		blocks: frame.document.blocks,
		frameUrl,
		embedUrl,
		shareUrl,
		shareEmbedUrl,
	};
}

export async function listFirstClassFrames(input: {
	userId: string;
	organizationId?: string;
	conversationId?: string;
}) {
	const frames = await listFrames({
		userId: input.userId,
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		limit: 25,
	});
	return {
		frames: frames.map((frame) => ({
			frameId: frame.id,
			title: frame.title,
			description: frame.description ?? undefined,
			kind: frame.kind,
			contentType: frame.contentType,
			frameUrl: buildInternalFrameUrl(frame.id, input.organizationId),
			embedUrl: buildInternalFrameEmbedUrl(
				frame.id,
				input.organizationId,
			),
			shareUrl: frame.shareToken
				? buildShareUrl(frame.shareToken)
				: undefined,
			shareEmbedUrl: frame.shareToken
				? buildShareEmbedUrl(frame.shareToken)
				: undefined,
			updatedAt: frame.updatedAt.toISOString(),
		})),
	};
}

export async function shareFirstClassFrame(input: {
	args: Record<string, unknown> | undefined;
	userId: string;
	organizationId?: string;
}) {
	const frameId = getNonEmptyString(input.args, ["frameId", "id"]);
	if (!frameId) {
		return { error: "Frame ID is required. Provide `frameId`." };
	}
	const frame = await publishFrame({
		id: frameId,
		userId: input.userId,
		organizationId: input.organizationId,
	});
	if (!frame || !frame.shareToken) {
		return { error: "Frame not found." };
	}
	return {
		frameId: frame.id,
		title: frame.title,
		description: frame.description ?? undefined,
		kind: frame.kind,
		contentType: frame.contentType,
		shareUrl: buildShareUrl(frame.shareToken),
		shareEmbedUrl: buildShareEmbedUrl(frame.shareToken),
		frameUrl: buildInternalFrameUrl(frame.id, input.organizationId),
		embedUrl: buildInternalFrameEmbedUrl(frame.id, input.organizationId),
		response: `Frame "${frame.title}" is now shareable.`,
	};
}

function buildShareUrl(token: string) {
	const baseUrl =
		process.env.NEXT_PUBLIC_SITE_URL ||
		process.env.APP_URL ||
		"http://localhost:3001";
	return `${baseUrl}/share/frame/${token}`;
}

function buildShareEmbedUrl(token: string) {
	const baseUrl =
		process.env.NEXT_PUBLIC_SITE_URL ||
		process.env.APP_URL ||
		"http://localhost:3001";
	return `${baseUrl}/share/frame/${token}/embed`;
}

function buildInternalFrameUrl(frameId: string, organizationId?: string) {
	return organizationId ? `/app/frames/${frameId}` : `/app/frames/${frameId}`;
}

function buildInternalFrameEmbedUrl(frameId: string, organizationId?: string) {
	return organizationId
		? `/app/frames/${frameId}/embed`
		: `/app/frames/${frameId}/embed`;
}
