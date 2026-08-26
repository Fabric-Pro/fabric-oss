/**
 * Intent Detection Types
 *
 * Types for user intent detection in routing decisions.
 */

/**
 * Result of user intent detection from message analysis.
 */
export interface UserIntent {
	/** User explicitly requested workspace document access */
	requestedWorkspace?: boolean;
	/** User explicitly requested workflow execution */
	requestedWorkflow?: boolean;
	/** Specific workflow name requested */
	requestedWorkflowName?: string;
	/** User explicitly requested MCP tool usage */
	requestedMcpTools?: boolean;
	/** User explicitly requested agent delegation */
	requestedAgent?: string;
	/** Specific agent name requested */
	requestedAgentName?: string;
	/** Specific tools/workflows mentioned by name */
	mentionedCapabilities?: string[];
	/** Detected YouTube URL if present */
	youtubeUrl?: string;
	/** Whether task requires Fabric AI capabilities */
	requestedFabricAi?: boolean;
	/** Explicit request for a first-class frame or slideshow output */
	requestedFrameOutput?: "frame" | "slideshow";
}

/**
 * Fabric AI capability detected from user message.
 */
export interface FabricAiCapability {
	/** Type of Fabric AI capability */
	type: "youtube_transcript" | "scrape_url" | "audio_transcribe" | "pattern";
	/** URL to process (YouTube, web page, audio file) */
	url: string;
	/** Fabric pattern to apply (e.g., "summarize", "extract_wisdom") */
	pattern?: string;
}

/**
 * User's prioritized capabilities for routing.
 */
export interface PrioritizedCapabilities {
	/** Names of prioritized MCP servers */
	mcpServers?: string[];
	/** Names of prioritized tools */
	tools?: string[];
	/** Names of prioritized agents */
	agents?: string[];
}
