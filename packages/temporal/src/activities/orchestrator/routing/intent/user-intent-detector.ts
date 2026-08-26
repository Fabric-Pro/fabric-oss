/**
 * User Intent Detector
 *
 * Detects explicit user intent from messages for routing decisions.
 * Uses keyword detection for explicit signals and lets semantic matching
 * handle agent/tool selection.
 */

import type { UserIntent } from "./types";

// YouTube URL patterns
const YOUTUBE_URL_PATTERNS = [
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})(?:[^\s]*)?/i,
	/(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})(?:[^\s]*)?/i,
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})(?:[^\s]*)?/i,
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/v\/([a-zA-Z0-9_-]{11})(?:[^\s]*)?/i,
	/(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})(?:[^\s]*)?/i,
];

// Workspace/document access patterns
// These patterns trigger workspace RAG mode - when matched, the system should use
// the user's workspace documents instead of external searches
const WORKSPACE_PATTERNS = [
	// Explicit workspace references
	"read from workspace",
	"from my workspace",
	"in my workspace",
	"workspace document",
	"workspace content",
	"workspace file",
	"search workspace",
	"find in workspace",
	"get from workspace",
	"use workspace",
	"my workspace",
	// Document references
	"read document",
	"read the document",
	"from my documents",
	"in my documents",
	"search my documents",
	"my documents",
	"the document",
	"these documents",
	"this document",
	// File references
	"use my files",
	"my files",
	"uploaded files",
	"attached files",
	"attached documents",
	"the attached",
	"the file",
	"these files",
	// RAG-specific
	"rag",
	"retrieve from",
	// Summarization of documents
	"summarize my",
	"summarize the document",
	"summarize these",
	"summary of my",
	"overview of my",
	"what's in my",
	"what is in my",
];

// Workflow execution patterns
const WORKFLOW_PATTERNS = [
	"run workflow",
	"execute workflow",
	"trigger workflow",
	"start workflow",
	"use workflow",
	"run the workflow",
];

// Workflow name extraction patterns
const WORKFLOW_NAME_PATTERNS = [
	/(?:run|execute|trigger|start|use)\s+(?:the\s+)?(?:workflow\s+)?["']([^"']+)["']\s*(?:workflow)?/i,
	/(?:run|execute|trigger|start|use)\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s+workflow/i,
	/workflow\s+(?:called|named)\s+["']?([^"'\s]+)["']?/i,
];

// Agent name extraction patterns
const AGENT_NAME_PATTERNS = [
	/(?:use|ask|delegate\s+to|run|call)\s+(?:the\s+)?["']([^"']+)["']\s*(?:agent)?/i,
	/(?:use|ask|delegate\s+to|run|call)\s+(?:the\s+)?(\w+(?:[_-]\w+)*)\s+agent/i,
	/agent\s+(?:called|named)\s+["']?([^"'\s]+)["']?/i,
	/(?:with|using)\s+(?:the\s+)?(\w+(?:[_-]\w+)*)\s+agent/i,
];

// External service indicators
const EXTERNAL_SERVICE_INDICATORS = [
	"post to",
	"send to",
	"create in",
	"add to",
	"get from",
	"fetch from",
	"search in",
	"update in",
	"delete from",
];

// Known service names
const SERVICE_NAMES = [
	"slack",
	"github",
	"jira",
	"linear",
	"trello",
	"notion",
	"confluence",
	"asana",
	"monday",
];

// Code/browser execution indicators
const CODE_EXECUTION_INDICATORS = [
	"run code",
	"execute code",
	"run python",
	"run javascript",
	"run script",
	"execute script",
	"browser automation",
	"automate browser",
	"click on",
	"navigate to",
];

// Document generation indicators
const DOC_GENERATION_INDICATORS = [
	"generate prd",
	"create prd",
	"write prd",
	"generate document",
	"create document",
	"write document",
	"generate report",
	"create report",
];

const SLIDESHOW_PATTERNS = [
	"slideshow",
	"slide deck",
	"slide-deck",
	"slide presentation",
	"presentation deck",
	"5-slide",
	"5 slide",
	"slides about",
	"create slides",
	"create a deck",
	"make slides",
	"make a presentation",
	"create a presentation",
];

const FRAME_PATTERNS = [
	"create a frame",
	"make a frame",
	"build a frame",
	"generate a frame",
	"interactive frame",
	"fabric frame",
	"dashboard frame",
	"wireframe",
	// Visualization / chart / dashboard
	"create a visualization",
	"make a visualization",
	"generate a visualization",
	"build a visualization",
	"data visualization",
	"interactive visualization",
	"visualize",
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

/**
 * Detects explicit user intent from the message.
 *
 * Uses a hybrid approach:
 * 1. Fast keyword detection for explicit signals (workspace, workflow, etc.)
 * 2. Semantic matching for agent/tool selection (no hardcoded agent patterns)
 */
export function detectUserIntent(message: string): UserIntent {
	const messageLower = message.toLowerCase();
	const result: UserIntent = {};
	const mentionedCapabilities: string[] = [];

	// YouTube URL detection
	const youtubeUrl = detectYouTubeUrl(message);
	if (youtubeUrl) {
		result.youtubeUrl = youtubeUrl;
		result.requestedFabricAi = true;
		mentionedCapabilities.push("youtube_transcript");
		mentionedCapabilities.push("fabric_ai");
		console.log(`[IntentDetector] Detected YouTube URL: ${youtubeUrl}`);
	}

	// Workspace/document access
	if (WORKSPACE_PATTERNS.some((p) => messageLower.includes(p))) {
		result.requestedWorkspace = true;
		mentionedCapabilities.push("workspace");
	}

	// Workflow execution
	if (WORKFLOW_PATTERNS.some((p) => messageLower.includes(p))) {
		result.requestedWorkflow = true;
		mentionedCapabilities.push("workflow");
	}

	// Extract specific workflow name
	const workflowName = extractWorkflowName(message);
	if (workflowName) {
		result.requestedWorkflowName = workflowName;
		result.requestedWorkflow = true;
		if (!mentionedCapabilities.includes("workflow")) {
			mentionedCapabilities.push("workflow");
		}
	}

	// Extract specific agent name
	const agentName = extractAgentName(message);
	if (agentName) {
		result.requestedAgentName = agentName;
		result.requestedAgent = agentName;
		mentionedCapabilities.push("agent");
	}

	// External service detection
	const needsExternalService =
		EXTERNAL_SERVICE_INDICATORS.some((ind) => messageLower.includes(ind)) ||
		SERVICE_NAMES.some((svc) => messageLower.includes(svc));

	if (needsExternalService) {
		result.requestedMcpTools = true;
		mentionedCapabilities.push("mcp_tool");
	}

	// Code/browser execution capability
	if (CODE_EXECUTION_INDICATORS.some((ind) => messageLower.includes(ind))) {
		mentionedCapabilities.push("code_execution");
	}

	// Document generation capability
	if (DOC_GENERATION_INDICATORS.some((ind) => messageLower.includes(ind))) {
		mentionedCapabilities.push("document_generation");
	}

	if (SLIDESHOW_PATTERNS.some((p) => messageLower.includes(p))) {
		result.requestedFrameOutput = "slideshow";
		result.requestedFabricAi = true;
		mentionedCapabilities.push("create_frames");
		mentionedCapabilities.push("fabric_ai");
	} else if (FRAME_PATTERNS.some((p) => messageLower.includes(p))) {
		result.requestedFrameOutput = "frame";
		result.requestedFabricAi = true;
		mentionedCapabilities.push("create_frames");
		mentionedCapabilities.push("fabric_ai");
	}

	if (mentionedCapabilities.length > 0) {
		result.mentionedCapabilities = mentionedCapabilities;
	}

	return result;
}

/**
 * Detects YouTube URL in message.
 */
function detectYouTubeUrl(message: string): string | undefined {
	for (const pattern of YOUTUBE_URL_PATTERNS) {
		const match = message.match(pattern);
		if (match) {
			const fullUrlMatch = message.match(
				/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}[^\s]*/i,
			);
			return fullUrlMatch
				? fullUrlMatch[0]
				: `https://www.youtube.com/watch?v=${match[1]}`;
		}
	}
	return undefined;
}

/**
 * Extracts workflow name from message.
 */
function extractWorkflowName(message: string): string | undefined {
	for (const pattern of WORKFLOW_NAME_PATTERNS) {
		const match = message.match(pattern);
		if (match?.[1]) {
			return match[1].trim();
		}
	}
	return undefined;
}

/**
 * Extracts agent name from message.
 */
function extractAgentName(message: string): string | undefined {
	for (const pattern of AGENT_NAME_PATTERNS) {
		const match = message.match(pattern);
		if (match?.[1]) {
			return match[1].trim();
		}
	}
	return undefined;
}
