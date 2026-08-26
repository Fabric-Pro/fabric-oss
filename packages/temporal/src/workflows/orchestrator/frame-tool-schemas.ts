/**
 * Frame tool schemas — pure data, imported by both the activity-side catalog
 * and the workflow-side keyword pre-registration. Workflow-sandbox safe.
 */

/**
 * BLOCK CONTENT FORMAT RULES carried in the tool description so the LLM
 * follows the same conventions the legacy server-side prompt enforced.
 * Inlined into `fabric_create_frame.description`.
 */
const FRAME_DESCRIPTION_RULES =
	"PREFERRED — produce content directly via `blocks`: emit one block per kind=frame, or one block per slide for kind=slideshow. Skipping `blocks` triggers a slower server-side generation step from your `description` and is reserved for cases where you want the server to draft from a brief.\n\n" +
	"BLOCK CONTENT FORMAT RULES:\n" +
	"- type='html': complete HTML document (<!doctype html>…</html>); inline <style> and <script>; CDN OK for Chart.js/D3/Mermaid/ApexCharts; no external images/fonts from unknown domains; Google Fonts OK; never set height on html/body or use 100vh/overflow on body — frame must grow to natural content height; avoid runtime code-string evaluation and avoid stream-mutation APIs that synchronously rewrite the document. Palette (hex — CSS vars unavailable in iframe): Primary #9F2A3A, Neutral #18181b, Surface #fafaf9, Muted #a1a1aa, Success #059669, Highlight #f59e0b.\n" +
	"- type='mermaid': only the Mermaid diagram source.\n" +
	"- type='json': only valid JSON.\n" +
	"- type='markdown': only Markdown.\n" +
	"For kind='slideshow' with html: each slide is a separate block; each slide's HTML may use min-height:100vh so it fills its viewport.";

const BLOCK_ARRAY_SCHEMA = {
	type: "array" as const,
	description:
		"Pre-rendered block content produced by you. When provided, the server skips internal generation and persists these blocks as-is. For kind='frame' provide one block; for kind='slideshow' provide one block per slide in order. Follow the BLOCK CONTENT FORMAT RULES in the tool description.",
	items: {
		type: "object" as const,
		properties: {
			id: { type: "string" as const },
			type: {
				type: "string" as const,
				enum: ["html", "json", "mermaid", "markdown"] as const,
			},
			title: { type: "string" as const },
			content: {
				type: "string" as const,
				description:
					"The complete rendered content for this block (e.g., the full HTML document for type='html').",
			},
			language: { type: "string" as const },
		},
		required: ["type", "content"] as const,
	},
};

export const FABRIC_CREATE_FRAME_TOOL = {
	name: "fabric_create_frame",
	description:
		"Create a first-class Fabric Frame artifact. Frames are shareable, typed visual documents that can render interactive HTML, charts, graphs, data visualizations, dashboards, Mermaid diagrams, JSON, or markdown. Use this for: interactive visualizations, charts, graphs, data dashboards, wireframes, reports, and living documents. When the user asks to visualize data, create a chart, build a dashboard, or produce any interactive visual output, use this tool instead of writing content as plain prose.\n\n" +
		FRAME_DESCRIPTION_RULES,
	inputSchema: {
		type: "object" as const,
		properties: {
			title: { type: "string" as const, description: "Frame title" },
			description: {
				type: "string" as const,
				description:
					"Short prose summary of what the frame contains. Used as the frame's stored description. Required as a fallback brief when `blocks` is omitted.",
			},
			blocks: BLOCK_ARRAY_SCHEMA,
			components: {
				type: "array" as const,
				items: {
					type: "object" as const,
					properties: {
						type: { type: "string" as const },
						label: { type: "string" as const },
					},
				},
			},
			format: {
				type: "string" as const,
				enum: ["html", "json", "mermaid", "markdown"] as const,
				default: "html" as const,
			},
			kind: {
				type: "string" as const,
				enum: ["frame", "slideshow"] as const,
				default: "frame" as const,
			},
			shareOnCreate: {
				type: "boolean" as const,
				description: "Whether to publish the frame immediately",
			},
		},
		required: ["title"] as const,
	},
	outputSchema: {
		type: "object" as const,
		properties: {
			frameId: { type: "string" as const },
			title: { type: "string" as const },
			kind: { type: "string" as const },
			contentType: { type: "string" as const },
			content: { type: "string" as const },
			frameUrl: { type: "string" as const },
			shareUrl: { type: "string" as const },
			response: { type: "string" as const },
		},
	},
} as const;

export const FABRIC_UPDATE_FRAME_TOOL = {
	name: "fabric_update_frame",
	description: "Update an existing first-class Fabric Frame by ID.",
	inputSchema: {
		type: "object" as const,
		properties: {
			frameId: { type: "string" as const, description: "Frame ID" },
			title: { type: "string" as const },
			description: { type: "string" as const },
			blocks: BLOCK_ARRAY_SCHEMA,
		},
		required: ["frameId"] as const,
	},
	outputSchema: {
		type: "object" as const,
		properties: {
			frameId: { type: "string" as const },
			frameUrl: { type: "string" as const },
			shareUrl: { type: "string" as const },
			response: { type: "string" as const },
		},
	},
} as const;

export const FABRIC_GET_FRAME_TOOL = {
	name: "fabric_get_frame",
	description: "Get a first-class Fabric Frame and its typed blocks.",
	inputSchema: {
		type: "object" as const,
		properties: {
			frameId: { type: "string" as const, description: "Frame ID" },
		},
		required: ["frameId"] as const,
	},
	outputSchema: {
		type: "object" as const,
		properties: {
			frameId: { type: "string" as const },
			title: { type: "string" as const },
			description: { type: "string" as const },
			kind: { type: "string" as const },
			contentType: { type: "string" as const },
			blocks: { type: "array" as const },
			frameUrl: { type: "string" as const },
			shareUrl: { type: "string" as const },
		},
	},
} as const;

export const FABRIC_LIST_FRAMES_TOOL = {
	name: "fabric_list_frames",
	description:
		"List first-class Fabric Frames available in the current context.",
	inputSchema: { type: "object" as const, properties: {} },
	outputSchema: {
		type: "object" as const,
		properties: {
			frames: { type: "array" as const },
		},
	},
} as const;

export const FABRIC_SHARE_FRAME_TOOL = {
	name: "fabric_share_frame",
	description: "Publish a first-class Fabric Frame and return its share URL.",
	inputSchema: {
		type: "object" as const,
		properties: {
			frameId: { type: "string" as const, description: "Frame ID" },
		},
		required: ["frameId"] as const,
	},
	outputSchema: {
		type: "object" as const,
		properties: {
			frameId: { type: "string" as const },
			shareUrl: { type: "string" as const },
			frameUrl: { type: "string" as const },
			response: { type: "string" as const },
		},
	},
} as const;

export const FABRIC_CREATE_SLIDESHOW_TOOL = {
	name: "fabric_create_slideshow",
	description:
		"Create a first-class Fabric slideshow artifact. Generates a multi-slide presentation with one polished HTML slide per slide. Use this when the user asks for slides, a slideshow, a presentation, a deck, or any multi-slide visual output. Each slide is rendered as a standalone interactive HTML panel with navigation. Never return slide content as plain prose — always use this tool.\n\n" +
		FRAME_DESCRIPTION_RULES,
	inputSchema: {
		type: "object" as const,
		properties: {
			title: { type: "string" as const },
			description: { type: "string" as const },
			blocks: BLOCK_ARRAY_SCHEMA,
			components: { type: "array" as const },
			format: {
				type: "string" as const,
				enum: ["html", "json", "mermaid", "markdown"] as const,
				default: "html" as const,
			},
			shareOnCreate: { type: "boolean" as const },
		},
		required: ["title"] as const,
	},
	outputSchema: {
		type: "object" as const,
		properties: {
			frameId: { type: "string" as const },
			title: { type: "string" as const },
			kind: { type: "string" as const },
			contentType: { type: "string" as const },
			frameUrl: { type: "string" as const },
		},
	},
} as const;
