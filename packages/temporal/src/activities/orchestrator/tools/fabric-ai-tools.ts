/**
 * Fabric AI Tools
 *
 * Virtual MCP tools that represent Fabric AI capabilities.
 * These are registered in the tool index so they can be discovered via semantic search.
 *
 * IMPORTANT: Each tool includes both inputSchema and outputSchema to help the orchestrator
 * understand what data flows between steps. The outputSchema describes the structure of
 * the tool's response, which is critical for proper step chaining.
 */

import {
	FABRIC_CREATE_FRAME_TOOL,
	FABRIC_CREATE_SLIDESHOW_TOOL,
	FABRIC_GET_FRAME_TOOL,
	FABRIC_LIST_FRAMES_TOOL,
	FABRIC_SHARE_FRAME_TOOL,
	FABRIC_UPDATE_FRAME_TOOL,
} from "../../../workflows/orchestrator/frame-tool-schemas";

export interface FabricAiTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	/** If true, the tool is excluded from search indexing and UI but its handler remains intact */
	hidden?: boolean;
}

/**
 * Get Fabric AI tools as virtual MCP tools.
 * These are registered in the tool index so they can be discovered via semantic search.
 *
 * WORKSPACE RAG TOOLS:
 * Workspace document queries are handled via dynamic tools (workspace_rag_query, workspace_rag_summarize).
 * These tools are executed on-demand during the execution phase, NOT during initialization.
 * This approach:
 * - Only retrieves documents when actually needed
 * - Can use refined queries from planning (better retrieval quality)
 * - Scales to large document sets (100k+ documents)
 * - Reduces latency for queries that don't need workspace docs
 */

/**
 * Get all Fabric AI tools including hidden ones.
 * Used by handlers that need to resolve tools by name regardless of visibility.
 */
export function getAllFabricAiTools(): FabricAiTool[] {
	return getFabricAiToolsInternal();
}

/**
 * Get visible (non-hidden) Fabric AI tools.
 * Used by search indexing and UI — hidden tools are excluded.
 */
export function getFabricAiTools(): FabricAiTool[] {
	return getFabricAiToolsInternal().filter((tool) => !tool.hidden);
}

function getFabricAiToolsInternal(): FabricAiTool[] {
	return [
		// =======================================================================
		// Workspace RAG Tools (Dynamic - executed on-demand)
		// These tools retrieve documents during execution, not initialization.
		// =======================================================================
		{
			name: "workspace_rag_query",
			description:
				"Search and retrieve information from the user's workspace documents using semantic similarity. " +
				"Use this tool when the user asks about their documents, attached files, personal files, workspace content, " +
				"or uploaded documents. This is the PRIMARY tool for answering questions about 'my documents', 'my files', " +
				"'attached documents', 'workspace', 'uploaded files', or any query about content the user has added to their workspace. " +
				"The tool uses vector search to find the most relevant document chunks based on the query.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"The search query to find relevant documents. Be specific for better results.",
					},
					topK: {
						type: "number",
						description:
							"Maximum number of document chunks to return (default: 10)",
						default: 10,
					},
					minSimilarity: {
						type: "number",
						description:
							"Minimum similarity threshold 0-1 (default: 0.3)",
						default: 0.3,
					},
				},
				required: ["query"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"Relevant content from the user's workspace documents",
					},
					chunkCount: {
						type: "number",
						description: "Number of document chunks found",
					},
					sources: {
						type: "array",
						items: {
							type: "object",
							properties: {
								documentName: { type: "string" },
								similarity: { type: "number" },
							},
						},
						description:
							"Source documents that contributed to the response",
					},
				},
			},
		},
		{
			name: "workspace_rag_summarize",
			description:
				"Summarize or get an overview of documents in the user's workspace. " +
				"Use when the user asks to 'summarize my documents', 'what's in my workspace', 'overview of my files', " +
				"'summarize attached documents', or any request to get a summary of their uploaded/attached content. " +
				"This retrieves content from all workspace documents and provides a comprehensive overview.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"Optional focus area for the summary (e.g., 'key points', 'action items')",
						default: "summarize all documents",
					},
					topK: {
						type: "number",
						description:
							"Maximum number of document chunks to include (default: 20 for broader coverage)",
						default: 20,
					},
				},
				required: [],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "Summary of workspace documents",
					},
					documentsProcessed: { type: "number" },
				},
			},
		},

		// =======================================================================
		// Project RAG Tools (Dynamic - executed on-demand)
		// These tools retrieve project-specific context during execution.
		// =======================================================================
		{
			name: "project_rag_query",
			description:
				"Search the attached project's documents, contexts, and codebase analysis for relevant information. " +
				"Use this when answering questions about the project, its requirements, architecture, or any project-specific context. " +
				"This tool searches the project's knowledge base including uploaded documents, PRDs, meeting notes, " +
				"code analysis results, and other project contexts using semantic similarity. " +
				"KEYWORDS: project context, project documents, project requirements, project architecture, project codebase, " +
				"project knowledge, feature details, tech stack, project goals, project specs.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"The search query to find relevant project context. Be specific for better results.",
					},
				},
				required: ["query"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"Relevant content from the project's knowledge base",
					},
					contextCount: {
						type: "number",
						description: "Number of relevant contexts found",
					},
					sources: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
								type: { type: "string" },
								relevance: { type: "number" },
							},
						},
						description:
							"Source contexts that contributed to the response",
					},
				},
			},
		},

		// =======================================================================
		// Architecture Decisions Tool (Dynamic - executed on-demand)
		// Reads the project's Decisions tab (Architecture Decision Log) directly
		// from the ArchitectureDecision table. Unlike project_rag_query, this
		// tool always returns the current live status (PROPOSED/ACCEPTED/etc.)
		// and endorsement state for every decision, without relying on semantic
		// search relevance or embedding freshness.
		// =======================================================================
		{
			name: "fabric_list_architecture_decisions",
			description:
				"List the attached project's architecture decisions (ADRs) from the Decisions tab. " +
				"Returns each decision's identifier (e.g. ADR-001), title, status " +
				"(PROPOSED/ACCEPTED/SUPERSEDED/DEPRECATED/REJECTED), domain, date, rationale, and endorsement. " +
				"Use this to understand the project's binding architectural constraints, discover " +
				"decisions pending team review, check which options were rejected so they aren't re-proposed, " +
				"or answer questions about past architectural choices. " +
				"Unlike project_rag_query (semantic search), this reads all decisions directly so status " +
				"and endorsement are always current. " +
				"KEYWORDS: architecture decisions, ADR, decisions tab, architectural constraints, " +
				"design decisions, tech decisions, decision log, ADR list, accepted decisions, " +
				"proposed decisions, rejected decisions, architectural choices, what was decided.",
			inputSchema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						enum: [
							"PROPOSED",
							"ACCEPTED",
							"SUPERSEDED",
							"DEPRECATED",
							"REJECTED",
						],
						description:
							"Optional filter: only decisions with this status. Omit to return all statuses.",
					},
					domain: {
						type: "string",
						enum: [
							"infra",
							"data",
							"ai",
							"security",
							"frontend",
							"platform",
						],
						description:
							"Optional filter: only decisions in this domain.",
					},
				},
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"Human-readable list of decisions with status, domain, date, rationale, and endorsement.",
					},
					decisionCount: {
						type: "number",
						description: "Number of decisions returned.",
					},
				},
			},
		},

		// =======================================================================
		// Feature Decisions Tool (Dynamic - executed on-demand)
		// Reads a feature's Decision Log entries (DecisionLogEntry threads)
		// from the maturation Decisions tab for that story.
		// =======================================================================
		{
			name: "fabric_list_feature_decisions",
			description:
				"List a feature's Decisions tab entries (Decision Log threads) using storyId. " +
				"Returns thread status (OPEN/RESOLVED/REJECTED/FORMATTING_ONLY/POSSIBLY_RESOLVED), " +
				"summary/content, topic, and reply activity so the agent can respect existing feature-level decisions. " +
				"Use this before proposing spec changes or conflicting implementation details for a feature. " +
				"KEYWORDS: feature decisions, decisions tab, decision log, story decisions, feature question log, " +
				"resolved decisions, open decisions, pending decisions, maturation decisions, storyId decisions.",
			inputSchema: {
				type: "object",
				properties: {
					storyId: {
						type: "string",
						description:
							"Feature (story) ID to read Decision Log threads for.",
					},
					status: {
						type: "string",
						enum: [
							"OPEN",
							"RESOLVED",
							"REJECTED",
							"FORMATTING_ONLY",
							"POSSIBLY_RESOLVED",
						],
						description:
							"Optional filter: only decision threads with this root status.",
					},
				},
				required: ["storyId"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"Human-readable list of feature decision threads and their status.",
					},
					decisionCount: {
						type: "number",
						description: "Number of decision threads returned.",
					},
				},
			},
		},

		// =======================================================================
		// Security Findings Tool (Dynamic - executed on-demand)
		// Reads the project's Security tab findings directly from the ScanFinding
		// table. These are structured triage records (status changes over time)
		// and are NOT embedded into Qdrant, so project_rag_query cannot surface
		// them — this dedicated tool is the only path the agent has to them.
		// =======================================================================
		{
			name: "fabric_list_security_findings",
			description:
				"List the attached project's Security tab findings (security and accessibility scan results) " +
				"with their severity, status, description, and remediation guidance. " +
				"Use this to summarize findings, answer questions about vulnerabilities or exposed credentials, " +
				"or gather the details needed to draft work items / tickets from findings (pair with fabric_create_story). " +
				"Returns the findings from the project's most recent completed scan, the same set shown in the Security tab. " +
				"KEYWORDS: security findings, security tab, scan findings, scan results, vulnerabilities, security issues, " +
				"exposed credentials, secrets, accessibility findings, severity, remediation, what security findings, " +
				"list security issues, create tickets for findings, security triage.",
			inputSchema: {
				type: "object",
				properties: {
					category: {
						type: "string",
						enum: ["SECURITY", "ACCESSIBILITY"],
						description:
							"Optional filter: only SECURITY or only ACCESSIBILITY findings. Omit for both.",
					},
					severity: {
						type: "string",
						enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
						description: "Optional severity filter.",
					},
					status: {
						type: "string",
						enum: ["OPEN", "RESOLVED", "DISMISSED"],
						description:
							"Optional status filter. Default behaviour returns all statuses; pass OPEN to focus on actionable findings.",
					},
				},
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"Human-readable list of findings with severity, status, description, remediation, and location.",
					},
					findingCount: {
						type: "number",
						description: "Number of findings returned.",
					},
				},
			},
		},

		// =======================================================================
		// Live Integration Search Tools (Dynamic - executed on-demand)
		// These tools hit the Slack/Teams APIs live for channels/chats linked to
		// the project via INTEGRATION contexts. Unlike project_rag_query (which
		// searches embedded content in Qdrant), these fetch fresh messages and
		// are the correct choice for "what was discussed in Slack/Teams" queries
		// — the INTEGRATION rows in Qdrant carry only pointer metadata, so
		// project_rag_query alone cannot surface message bodies.
		// =======================================================================
		{
			name: "search_slack_messages",
			description:
				"Search live Slack messages in channels linked to the attached project. " +
				"Use this when the user asks about Slack discussions, decisions, async chat, " +
				"or what teammates said in Slack. This calls the Slack API directly — it does " +
				"NOT depend on ingestion or RAG embeddings, so it works even when project_rag_query " +
				"returns no Slack content. Returns up to ~15 messages with content, sender, channel, " +
				"timestamp, and permalink. " +
				"KEYWORDS: slack, slack discussion, slack channel, slack messages, slack chat, " +
				"team discussion in slack, what was said in slack.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"Search query — keywords, phrases, topics, or 'from:@user' to filter by sender.",
					},
					limit: {
						type: "number",
						description:
							"Maximum number of messages to return (default: 15, max: 50).",
						default: 15,
					},
				},
				required: ["query"],
			},
			outputSchema: {
				type: "object",
				properties: {
					messages: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								content: { type: "string" },
								from: { type: "string" },
								createdAt: { type: "string" },
								channelId: { type: "string" },
								channelName: { type: "string" },
								threadTs: { type: "string" },
								permalink: { type: "string" },
							},
						},
					},
					totalCount: { type: "number" },
					searchedChannels: {
						type: "array",
						items: { type: "string" },
					},
					errors: { type: "array", items: { type: "string" } },
				},
			},
		},

		{
			name: "search_teams_messages",
			description:
				"Search live Microsoft Teams messages in chats and channels linked to the attached " +
				"project. Use this when the user asks about Teams discussions, decisions, async chat, " +
				"or what teammates said in Teams. Calls the Microsoft Graph API directly — does NOT " +
				"depend on ingestion or RAG embeddings. Returns relevance-ranked excerpts with " +
				"content, sender, chat name, timestamp, and webLink. " +
				"KEYWORDS: teams, microsoft teams, teams chat, teams channel, teams discussion, " +
				"teams messages, team discussion in teams, what was said in teams.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"Search query — keywords, phrases, or topics relevant to the discussion you want to find.",
					},
					limit: {
						type: "number",
						description:
							"Maximum number of raw messages per pass before relevance filtering (default: 15, max: 50).",
						default: 15,
					},
				},
				required: ["query"],
			},
			outputSchema: {
				type: "object",
				properties: {
					messages: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								content: { type: "string" },
								from: { type: "string" },
								fromEmail: { type: "string" },
								createdAt: { type: "string" },
								chatId: { type: "string" },
								teamId: { type: "string" },
								channelId: { type: "string" },
								chatName: { type: "string" },
								webLink: { type: "string" },
							},
						},
					},
					totalCount: { type: "number" },
					searchedChats: {
						type: "array",
						items: { type: "string" },
					},
					errors: { type: "array", items: { type: "string" } },
				},
			},
		},

		{
			name: "fabric_create_story",
			description:
				"Create a feature or bug in the Fabric project bound to this agent. " +
				"Use this when a user asks to add, file, log, open, or create a feature, bug, " +
				"story, or work item. The story is drafted automatically by the project's " +
				"bound prompt — you do NOT need to write the description or acceptance " +
				"criteria yourself. Pass the user's raw request verbatim as `request`. A short " +
				"working `title` is optional — if absent, one will be generated automatically " +
				"from `request`. When `title` is omitted, the server uses `request` as both " +
				"the description AND as `origin_context` for the title generator. " +
				"The system classifies the request as BUG or FEATURE automatically using an " +
				"AI classifier — you do NOT need to set `kind`. If you have strong context, " +
				"you may pass a `kind` hint; the classifier will override it when warranted. " +
				"Optional reporter fields (`reporterSource`, `reporterSourceUrl`, " +
				"`reporterName`) let you attribute the work item to its origin (a Slack " +
				"thread, Teams message, etc.) — pass them when you have that context. " +
				"KEYWORDS: create feature, file bug, log bug, add feature, open ticket, " +
				"create story, new feature, new bug, report bug, add to backlog.",
			inputSchema: {
				type: "object",
				properties: {
					kind: {
						type: "string",
						enum: ["FEATURE", "BUG"],
						description:
							"Optional hint. The system runs an AI classifier and may override.",
					},
					title: {
						type: "string",
						description:
							"Optional short working title (≤120 chars). If omitted, generated server-side from `request`.",
					},
					request: {
						type: "string",
						description:
							"The user's raw request, verbatim. Becomes the drafting context.",
					},
					priority: {
						type: "string",
						enum: ["P0_CRITICAL", "P1_HIGH", "P2_MEDIUM", "P3_LOW"],
						default: "P2_MEDIUM",
						description: "Story priority. Default P2_MEDIUM.",
					},
					size: {
						type: "string",
						enum: ["XS", "S", "M", "L", "XL"],
						description:
							"T-shirt size estimate. Optional; omit if unsure.",
					},
					reporterSource: {
						type: "string",
						enum: ["SLACK", "TEAMS", "MANUAL"],
						description:
							"Origin of this report. Set SLACK / TEAMS when invoked from those channels; defaults to MANUAL.",
					},
					reporterSourceUrl: {
						type: "string",
						description:
							"Permalink to the originating message/thread (e.g. Slack thread URL, Teams message URL).",
					},
					reporterName: {
						type: "string",
						description:
							"Display name of the user who reported this. Falls back to the agent owner when omitted.",
					},
				},
				required: ["request"],
			},
			outputSchema: {
				type: "object",
				properties: {
					storyId: { type: "string" },
					identifier: {
						type: "string",
						description: "Human-friendly identifier, e.g. F-042.",
					},
					title: { type: "string" },
					kind: { type: "string", enum: ["FEATURE", "BUG"] },
					url: {
						type: "string",
						description: "Deep link to the new story in the app.",
					},
					aiDrafted: {
						type: "boolean",
						description:
							"True when the bound stage prompt successfully drafted the story.",
					},
				},
			},
		},

		// =======================================================================
		// Knowledge Graph (Weave) Tools
		// =======================================================================
		{
			name: "weave_query",
			description:
				"Query the project's knowledge graph (Weave) for entities, relationships, and structured knowledge. " +
				"Use this when the user asks about relationships between concepts, entities in the project, " +
				"how components relate to each other, or needs a structured view of project knowledge. " +
				"Returns entities and their relationships as structured data. " +
				"KEYWORDS: knowledge graph, entities, relationships, connections, dependencies, " +
				"related to, how does X connect to Y, what depends on, architecture relationships.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"Natural language query about entities or relationships (e.g. 'What entities are related to the auth module?')",
					},
					entityType: {
						type: "string",
						description:
							"Optional: filter by entity type (e.g. 'service', 'module', 'api', 'database')",
					},
				},
				required: ["query"],
			},
			outputSchema: {
				type: "object",
				properties: {
					entities: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
								type: { type: "string" },
								description: { type: "string" },
								relationships: {
									type: "array",
									items: {
										type: "object",
										properties: {
											target: { type: "string" },
											relation: { type: "string" },
										},
									},
								},
							},
						},
						description:
							"Entities matching the query with their relationships",
					},
				},
			},
		},

		// =======================================================================
		// YouTube Tools
		// =======================================================================
		{
			name: "fabric_youtube_transcript",
			description:
				"Get the transcript from a YouTube video. Extract captions, subtitles, or spoken text from any YouTube video URL. " +
				"Returns the raw, unprocessed transcript text without AI analysis. " +
				"KEYWORDS: get transcript, download transcript, youtube transcript, video transcript, captions, subtitles, spoken text, raw text. " +
				"Use this when: (1) user asks for 'the transcript', (2) you need raw text for custom processing, (3) you want to see full content before summarizing.",
			inputSchema: {
				type: "object",
				properties: {
					url: {
						type: "string",
						description:
							"YouTube video URL (youtube.com/watch?v=..., youtu.be/..., etc.)",
					},
					timestamps: {
						type: "boolean",
						description:
							"Whether to include timestamps in the transcript",
						default: false,
					},
				},
				required: ["url"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"The raw transcript text from the YouTube video",
					},
					title: { type: "string", description: "Video title" },
					videoId: {
						type: "string",
						description: "YouTube video ID",
					},
				},
				description: "Returns transcript text in the 'response' field",
			},
		},
		{
			name: "fabric_analyze_youtube",
			description:
				"Analyze and summarize a YouTube video using AI patterns. Automatically processes the video content and applies a Fabric pattern (summarize, extract_wisdom, analyze_claims, create_keynote). " +
				"KEYWORDS: summarize video, analyze video, what is this video about, extract insights, video summary, explain video, key points from video. " +
				"Use this when user wants AI analysis/summary, NOT when they just want the raw transcript text.",
			inputSchema: {
				type: "object",
				properties: {
					url: { type: "string", description: "YouTube video URL" },
					pattern: {
						type: "string",
						description:
							"Fabric pattern to apply (e.g., summarize, extract_wisdom, analyze_claims, create_keynote)",
						default: "summarize",
					},
				},
				required: ["url"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"The AI-generated analysis of the video content",
					},
					title: { type: "string", description: "Video title" },
				},
				description: "Returns analysis text in the 'response' field",
			},
		},
		{
			name: "fabric_youtube_metadata",
			description:
				"Get metadata and information about a YouTube video. Returns title, description, channel name, duration, view count, likes, and tags. " +
				"KEYWORDS: video info, video details, metadata, video title, channel name, view count, video stats, video information. " +
				"Use when user asks for video details/info, NOT for transcript or content analysis.",
			inputSchema: {
				type: "object",
				properties: {
					url: { type: "string", description: "YouTube video URL" },
				},
				required: ["url"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"JSON string containing video metadata (title, description, channel, duration, etc.)",
					},
				},
				description: "Returns JSON metadata in the 'response' field",
			},
		},
		{
			name: "fabric_youtube_comments",
			description:
				"Get comments from a YouTube video. Retrieves viewer comments and replies for sentiment analysis or feedback review. " +
				"KEYWORDS: video comments, youtube comments, viewer feedback, reactions, comment section, audience comments. " +
				"Use when user wants to see or analyze video comments.",
			inputSchema: {
				type: "object",
				properties: {
					url: { type: "string", description: "YouTube video URL" },
				},
				required: ["url"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "Comments text, one per paragraph",
					},
				},
				description: "Returns comments in the 'response' field",
			},
		},
		{
			name: "fabric_youtube_playlist",
			description:
				"Get videos from a YouTube playlist. Lists all videos in a playlist with their titles and URLs. " +
				"KEYWORDS: playlist videos, list videos, playlist contents, batch videos, multiple videos, video list. " +
				"Use when user wants to see or process videos from a playlist.",
			inputSchema: {
				type: "object",
				properties: {
					url: {
						type: "string",
						description: "YouTube playlist URL",
					},
				},
				required: ["url"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"List of videos in markdown format: '- [title](url)'",
					},
				},
				description: "Returns video list in the 'response' field",
			},
		},

		// =======================================================================
		// Web Scraping Tools
		// =======================================================================
		{
			name: "fabric_scrape_url",
			description:
				"Scrape content from a web page and convert it to clean, LLM-friendly markdown. Works with articles, documentation, blog posts, and other web content. Uses Jina AI for high-quality extraction.",
			inputSchema: {
				type: "object",
				properties: {
					url: { type: "string", description: "URL to scrape" },
				},
				required: ["url"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"Clean markdown content extracted from the web page",
					},
				},
				description: "Returns scraped content in the 'response' field",
			},
		},
		{
			name: "fabric_scrape_and_analyze",
			description:
				"Scrape content from a web page and analyze it using a Fabric pattern. Combines web scraping with AI analysis in a single step. Good for summarizing articles or extracting key information from web pages.",
			inputSchema: {
				type: "object",
				properties: {
					url: {
						type: "string",
						description: "URL to scrape and analyze",
					},
					pattern: {
						type: "string",
						description:
							"Fabric pattern to apply (e.g., summarize, extract_wisdom)",
						default: "summarize",
					},
				},
				required: ["url"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"AI-generated analysis of the scraped web content",
					},
				},
				description: "Returns analysis text in the 'response' field",
			},
		},

		// =======================================================================
		// Web Search Tools
		// =======================================================================
		{
			name: "fabric_web_search",
			description:
				"Search the web using Jina AI and return relevant results. Good for finding current information, research, or discovering relevant content.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "Search query" },
					maxResults: {
						type: "number",
						description: "Maximum number of results to return",
						default: 5,
					},
				},
				required: ["query"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"Search results as formatted text with titles, URLs, and snippets",
					},
				},
				description: "Returns search results in the 'response' field",
			},
		},
		{
			name: "fabric_search_and_analyze",
			description:
				"Search the web and analyze the combined results using a Fabric pattern. Good for researching topics and getting AI-processed summaries of search results.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "Search query" },
					pattern: {
						type: "string",
						description:
							"Fabric pattern to apply to search results",
						default: "summarize",
					},
					maxResults: {
						type: "number",
						description: "Maximum number of results to analyze",
						default: 5,
					},
				},
				required: ["query"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"AI-generated analysis of combined search results",
					},
				},
				description: "Returns analysis text in the 'response' field",
			},
		},

		// =======================================================================
		// Pattern Tools
		// =======================================================================
		{
			name: "fabric_pattern",
			description:
				"Apply a Fabric AI pattern to transform or analyze text content. Supports 200+ patterns including summarize, extract_wisdom, analyze_claims, create_keynote, write_essay. Use this when you already have text content to process. For URLs, use fabric_analyze_youtube (YouTube) or fabric_scrape_and_analyze (web pages) instead.",
			inputSchema: {
				type: "object",
				properties: {
					input: {
						type: "string",
						description:
							"Text content to process (can also reference previous step output)",
					},
					content: {
						type: "string",
						description:
							"Alternative name for input text (alias for 'input')",
					},
					pattern: {
						type: "string",
						description:
							"Fabric pattern name (e.g., summarize, extract_wisdom, analyze_claims, create_keynote)",
					},
					variables: {
						type: "object",
						description:
							"Variables to pass to the pattern template",
					},
				},
				required: ["pattern"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"The transformed/analyzed content after applying the pattern",
					},
				},
				description:
					"Returns processed content in the 'response' field",
			},
		},
		{
			name: "fabric_list_patterns",
			description:
				"List all available Fabric AI patterns. Returns pattern names and descriptions. Use this to discover what patterns are available for content processing.",
			inputSchema: { type: "object", properties: {} },
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"List of available patterns, one per line with '- ' prefix",
					},
				},
				description: "Returns pattern list in the 'response' field",
			},
		},

		// =======================================================================
		// Audio Transcription Tools
		// =======================================================================
		{
			name: "fabric_transcribe_audio",
			description:
				"Transcribe audio or video files to text using OpenAI Whisper. Supports mp3, mp4, wav, webm, m4a formats. Can auto-split large files (>25MB). Good for meeting recordings, podcasts, or any audio content.",
			inputSchema: {
				type: "object",
				properties: {
					fileContent: {
						type: "string",
						description: "Base64 encoded audio file content",
					},
					fileName: {
						type: "string",
						description:
							"Original filename with extension (e.g., 'meeting.mp3')",
					},
					model: {
						type: "string",
						description:
							"Transcription model (whisper-1, gpt-4o-mini-transcribe, gpt-4o-transcribe)",
						default: "whisper-1",
					},
					split: {
						type: "boolean",
						description: "Auto-split files larger than 25MB",
						default: false,
					},
				},
				required: ["fileContent", "fileName"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "Transcribed text from the audio file",
					},
				},
				description: "Returns transcript in the 'response' field",
			},
		},

		// =======================================================================
		// HTML Readability Tool
		// =======================================================================
		{
			name: "fabric_readability",
			description:
				"Extract clean, readable text content from raw HTML. Removes navigation, ads, and non-content elements. Useful for processing scraped HTML or cleaning up web content before analysis.",
			inputSchema: {
				type: "object",
				properties: {
					html: {
						type: "string",
						description: "Raw HTML content to process",
					},
					url: {
						type: "string",
						description: "Optional source URL for context",
					},
				},
				required: ["html"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "Clean, readable text extracted from HTML",
					},
				},
				description:
					"Returns extracted content in the 'response' field",
			},
		},

		// =======================================================================
		// Template Plugin Tool
		// =======================================================================
		{
			name: "fabric_template",
			description:
				"Apply Fabric template plugins to generate dynamic content. Supports datetime (now, today, rel:-1d), text manipulation, file reading, web fetching, and system info. Template syntax: {{plugin:namespace:operation:value}}. Use for dynamic report generation.",
			inputSchema: {
				type: "object",
				properties: {
					template: {
						type: "string",
						description:
							"Template string with {{plugin:...}} placeholders. Example: 'Report generated on {{plugin:datetime:today}}'",
					},
					variables: {
						type: "object",
						description:
							"Variables for {{variableName}} substitution",
					},
					input: {
						type: "string",
						description: "Input text for {{input}} placeholder",
					},
				},
				required: ["template"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"Processed template with all placeholders replaced",
					},
				},
				description:
					"Returns processed template in the 'response' field",
			},
		},

		// =======================================================================
		// Strategies & Contexts Tools
		// =======================================================================
		{
			name: "fabric_list_strategies",
			description:
				"List all available Fabric strategies. Strategies define HOW to think (e.g., chain_of_thought, socratic_method). Use to discover available thinking approaches.",
			inputSchema: { type: "object", properties: {} },
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"List of strategies with names and descriptions",
					},
				},
				description: "Returns strategy list in the 'response' field",
			},
		},
		{
			name: "fabric_get_strategy",
			description:
				"Get a specific Fabric strategy by name with its full content. Strategies are system-level prompts that define HOW the AI should approach problems.",
			inputSchema: {
				type: "object",
				properties: {
					name: { type: "string", description: "Strategy name" },
				},
				required: ["name"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "Full strategy content/prompt",
					},
				},
				description: "Returns strategy content in the 'response' field",
			},
		},
		{
			name: "fabric_list_contexts",
			description:
				"List all available Fabric contexts. Contexts provide domain expertise or persona (e.g., security_expert, data_scientist). Use to discover available expert personas.",
			inputSchema: { type: "object", properties: {} },
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "List of context names, one per line",
					},
				},
				description: "Returns context list in the 'response' field",
			},
		},
		{
			name: "fabric_get_context",
			description:
				"Get a specific Fabric context by name with its full content. Contexts are user-defined background information that provides domain expertise to the AI.",
			inputSchema: {
				type: "object",
				properties: {
					name: { type: "string", description: "Context name" },
				},
				required: ["name"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "Full context content",
					},
				},
				description: "Returns context content in the 'response' field",
			},
		},

		// =======================================================================
		// Text-to-Speech Tools
		// =======================================================================
		{
			name: "fabric_text_to_speech",
			description:
				"Convert text to speech audio using OpenAI TTS. Generates an audio file from text and saves it to storage. " +
				"KEYWORDS: text to speech, TTS, generate audio, speak text, voice, narrate, audio generation, convert text to audio.",
			inputSchema: {
				type: "object",
				properties: {
					text: {
						type: "string",
						description: "Text to convert to speech",
					},
					voice: {
						type: "string",
						enum: [
							"alloy",
							"echo",
							"fable",
							"onyx",
							"nova",
							"shimmer",
						],
						description: "Voice to use for speech generation",
						default: "alloy",
					},
					speed: {
						type: "number",
						description:
							"Speed of the generated audio (0.25 to 4.0)",
						default: 1.0,
					},
				},
				required: ["text"],
			},
			outputSchema: {
				type: "object",
				properties: {
					audioUrl: {
						type: "string",
						description: "URL to access the generated audio file",
					},
					format: {
						type: "string",
						description: "Audio format (mp3)",
					},
					durationSeconds: {
						type: "number",
						description:
							"Estimated duration of the audio in seconds",
					},
					response: {
						type: "string",
						description: "Confirmation message with audio URL",
					},
				},
			},
		},

		// =======================================================================
		// First-Class Frames Tools (schemas in workflows/orchestrator/frame-tool-schemas.ts)
		// =======================================================================
		FABRIC_CREATE_FRAME_TOOL as FabricAiTool,
		FABRIC_UPDATE_FRAME_TOOL as FabricAiTool,
		FABRIC_GET_FRAME_TOOL as FabricAiTool,
		FABRIC_LIST_FRAMES_TOOL as FabricAiTool,
		FABRIC_SHARE_FRAME_TOOL as FabricAiTool,
		FABRIC_CREATE_SLIDESHOW_TOOL as FabricAiTool,

		// =======================================================================
		// Image Generation Tools
		// =======================================================================
		{
			name: "fabric_generate_image",
			description:
				"Generate or edit images using AI. Supports text-to-image generation and image editing/modification with an input image. " +
				"When an inputImage storage path is provided, the prompt describes how to modify/edit that image. " +
				"KEYWORDS: generate image, create image, make picture, draw, illustration, image generation, create artwork, make image, design image, " +
				"edit image, modify image, change image, transform image, image editing, edit picture, modify picture, edit photo.",
			inputSchema: {
				type: "object",
				properties: {
					prompt: {
						type: "string",
						description:
							"Text description of the desired image. For generation: describe style, composition, colors, lighting. For editing: describe what changes to make to the input image.",
					},
					inputImage: {
						type: "string",
						description:
							"S3 storage path of an input image to modify/edit. When provided, the prompt describes how to modify this image. Omit for text-to-image generation.",
					},
					provider: {
						type: "string",
						enum: ["gateway", "fal", "gemini"],
						description:
							"Image generation provider. 'gateway' for Nano Banana via Vercel AI Gateway (default, supports image editing), 'fal' for FLUX models, 'gemini' for direct Google Gemini.",
						default: "gateway",
					},
					gatewayModel: {
						type: "string",
						enum: [
							"google/gemini-3.1-flash-image-preview",
							"google/gemini-3-pro-image",
						],
						description:
							"Gateway model override. Omit to use the user's configured default. " +
							"Only set explicitly if the user requests specific quality: " +
							"'google/gemini-3.1-flash-image-preview' (fast) or 'google/gemini-3-pro-image' (higher quality).",
					},
					aspectRatio: {
						type: "string",
						enum: [
							"1:1",
							"3:2",
							"2:3",
							"3:4",
							"4:3",
							"4:5",
							"5:4",
							"9:16",
							"16:9",
						],
						description: "Aspect ratio for the generated image.",
						default: "1:1",
					},
					quality: {
						type: "string",
						enum: ["low", "medium", "high"],
						description:
							"Output quality: low (fast), medium (balanced), high (best quality). Only applies to FAL provider.",
						default: "medium",
					},
					model: {
						type: "string",
						description:
							"Model ID override. FAL default: fal-ai/flux-pro/v1.1, Gemini default: gemini-2.0-flash-preview-image-generation",
					},
				},
				required: ["prompt"],
			},
			outputSchema: {
				type: "object",
				properties: {
					imageUrl: {
						type: "string",
						description: "URL of the generated image",
					},
					text: {
						type: "string",
						description:
							"Text response from the model (e.g., description of changes made)",
					},
					width: { type: "number" },
					height: { type: "number" },
					provider: { type: "string" },
					model: { type: "string" },
				},
			},
		},

		// =======================================================================
		// MCP CLI Tools - Dynamic MCP Server Discovery and Tool Execution
		// These tools enable agents to dynamically discover and interact with
		// MCP servers without loading all tool schemas upfront (~99% token reduction).
		// Uses mcp-cli binary for efficient, on-demand tool discovery.
		//
		// Available MCP servers include:
		// - context7: Library documentation lookup (React, TypeScript, etc.)
		// - deepwiki: GitHub repository wiki/documentation (explain how repos work)
		// - filesystem: Local file operations
		// - memory: Persistent knowledge graph
		// =======================================================================
		{
			name: "fabric_mcp_list",
			hidden: true,
			description:
				"List all available MCP servers and their tools for documentation, repository analysis, and more. " +
				"Includes servers like context7 (library documentation for React, TypeScript, etc.), " +
				"deepwiki (GitHub repository wikis - use to explain how open source projects work), " +
				"and other configured MCP servers. Returns server names and tool names without full schemas to save tokens. " +
				"Add withDescriptions=true to include brief tool descriptions.",
			inputSchema: {
				type: "object",
				properties: {
					withDescriptions: {
						type: "boolean",
						description:
							"Include tool descriptions (more verbose, uses more tokens)",
						default: false,
					},
				},
				required: [],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "List of MCP servers and their tools",
					},
					servers: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
								tools: {
									type: "array",
									items: { type: "string" },
								},
							},
						},
					},
					count: { type: "number", description: "Number of servers" },
				},
				description: "Returns servers and tools in structured format",
			},
		},
		{
			name: "fabric_mcp_grep",
			hidden: true,
			description:
				"Search for MCP tools by glob pattern across all servers including documentation and repository tools. " +
				"Use this to find tools for: library docs (context7), GitHub repo documentation/wiki (deepwiki), file operations, etc. " +
				"Patterns use glob syntax: '*wiki*' matches wiki tools, '*doc*' matches documentation tools, '*read*' matches read operations. " +
				"More efficient than listing all tools when you know what you're looking for.",
			inputSchema: {
				type: "object",
				properties: {
					pattern: {
						type: "string",
						description:
							"Glob pattern to search for (e.g., '*file*', '*search*', '*create*')",
					},
					withDescriptions: {
						type: "boolean",
						description: "Include tool descriptions",
						default: false,
					},
				},
				required: ["pattern"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"List of matching tools in format 'server/tool'",
					},
					tools: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
								server: { type: "string" },
								description: { type: "string" },
							},
						},
					},
					count: {
						type: "number",
						description: "Number of matching tools",
					},
				},
				description: "Returns matching tools in structured format",
			},
		},
		{
			name: "fabric_mcp_schema",
			hidden: true,
			description:
				"Get the full JSON schema for a specific MCP tool. Use this before calling a tool to understand its required parameters. " +
				"Only fetches schema for the specific tool, not all tools (token-efficient). " +
				"The serverTool parameter uses format 'server/tool' (e.g., 'filesystem/read_file').",
			inputSchema: {
				type: "object",
				properties: {
					serverTool: {
						type: "string",
						description:
							"Tool identifier in format 'server/tool' (e.g., 'filesystem/read_file', 'github/search_repositories')",
					},
				},
				required: ["serverTool"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description:
							"JSON schema for the tool's input parameters",
					},
					name: { type: "string", description: "Tool name" },
					server: { type: "string", description: "Server name" },
					description: {
						type: "string",
						description: "Tool description",
					},
					inputSchema: {
						type: "object",
						description: "Full JSON schema for tool parameters",
					},
				},
				description: "Returns tool schema with parameter definitions",
			},
		},
		// =======================================================================
		// Third-Party Integration Tools
		// =======================================================================

		// --- Asana ---
		{
			name: "fabric_asana_create_task",
			description:
				"Create a task in Asana. Requires Asana integration to be configured in settings. " +
				"KEYWORDS: asana task, create asana task, add task to asana, asana project.",
			inputSchema: {
				type: "object",
				properties: {
					name: { type: "string", description: "Task name" },
					notes: {
						type: "string",
						description: "Task description or notes",
					},
					projectId: {
						type: "string",
						description: "Asana project ID to add the task to",
					},
					dueOn: {
						type: "string",
						description: "Due date in YYYY-MM-DD format",
					},
					assignee: {
						type: "string",
						description: "Assignee email or user GID",
					},
				},
				required: ["name"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "Result of creating the task",
					},
					taskId: { type: "string", description: "Created task GID" },
					taskUrl: {
						type: "string",
						description: "URL to the created task",
					},
				},
			},
		},
		{
			name: "fabric_asana_list_tasks",
			description:
				"List tasks from an Asana project. Requires Asana integration to be configured. " +
				"KEYWORDS: asana tasks, list asana tasks, asana project tasks.",
			inputSchema: {
				type: "object",
				properties: {
					projectId: {
						type: "string",
						description: "Asana project GID to list tasks from",
					},
					assignee: {
						type: "string",
						description: "Filter by assignee (me or user GID)",
					},
					completed: {
						type: "boolean",
						description: "Include completed tasks",
						default: false,
					},
				},
				required: ["projectId"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "List of tasks as formatted text",
					},
					tasks: {
						type: "array",
						items: {
							type: "object",
							properties: {
								gid: { type: "string" },
								name: { type: "string" },
								completed: { type: "boolean" },
								dueOn: { type: "string" },
							},
						},
					},
				},
			},
		},

		// --- Attio ---
		{
			name: "fabric_attio_create_record",
			description:
				"Create a record in Attio CRM. Requires Attio integration to be configured. " +
				"KEYWORDS: attio record, create attio record, CRM record, attio contact, attio company.",
			inputSchema: {
				type: "object",
				properties: {
					objectType: {
						type: "string",
						description:
							"Object type (e.g., 'people', 'companies', 'deals')",
					},
					attributes: {
						type: "object",
						description: "Record attributes as key-value pairs",
					},
				},
				required: ["objectType", "attributes"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "Result of creating the record",
					},
					recordId: {
						type: "string",
						description: "Created record ID",
					},
				},
			},
		},
		{
			name: "fabric_attio_search_records",
			description:
				"Search records in Attio CRM. Requires Attio integration to be configured. " +
				"KEYWORDS: attio search, search attio, find attio record, CRM search.",
			inputSchema: {
				type: "object",
				properties: {
					objectType: {
						type: "string",
						description:
							"Object type to search (e.g., 'people', 'companies')",
					},
					query: { type: "string", description: "Search query" },
					limit: {
						type: "number",
						description: "Maximum records to return",
						default: 10,
					},
				},
				required: ["objectType", "query"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "Search results as formatted text",
					},
					records: {
						type: "array",
						items: { type: "object" },
						description: "Matching records",
					},
					count: {
						type: "number",
						description: "Number of records found",
					},
				},
			},
		},

		// --- Front ---
		{
			name: "fabric_front_create_conversation",
			description:
				"Create a conversation in Front. Requires Front integration to be configured. " +
				"KEYWORDS: front conversation, create front message, front email, customer message.",
			inputSchema: {
				type: "object",
				properties: {
					subject: {
						type: "string",
						description: "Conversation subject",
					},
					body: { type: "string", description: "Message body" },
					to: {
						type: "array",
						items: { type: "string" },
						description: "Recipient email addresses",
					},
					channelId: {
						type: "string",
						description: "Front channel ID to send from",
					},
				},
				required: ["subject", "body", "to"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "Result of creating the conversation",
					},
					conversationId: {
						type: "string",
						description: "Created conversation ID",
					},
					conversationUrl: {
						type: "string",
						description: "URL to the conversation in Front",
					},
				},
			},
		},
		{
			name: "fabric_front_list_conversations",
			description:
				"List conversations from Front. Requires Front integration to be configured. " +
				"KEYWORDS: front conversations, list front, front inbox, front messages.",
			inputSchema: {
				type: "object",
				properties: {
					inboxId: {
						type: "string",
						description:
							"Front inbox ID to list conversations from",
					},
					status: {
						type: "string",
						enum: ["open", "archived", "deleted", "all"],
						description: "Filter by status",
						default: "open",
					},
					limit: {
						type: "number",
						description: "Maximum conversations to return",
						default: 10,
					},
				},
				required: [],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "List of conversations as formatted text",
					},
					conversations: {
						type: "array",
						items: { type: "object" },
						description: "Conversation records",
					},
					count: { type: "number" },
				},
			},
		},

		// --- Canva ---
		{
			name: "fabric_canva_list_designs",
			description:
				"List designs from a Canva account. Requires Canva integration to be configured. " +
				"KEYWORDS: canva designs, list canva, design files, canva assets.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Optional search query to filter designs",
					},
					limit: {
						type: "number",
						description: "Maximum number of designs to return",
						default: 20,
					},
				},
				required: [],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "List of designs as formatted text",
					},
					designs: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								name: { type: "string" },
								thumbnail: { type: "string" },
								url: { type: "string" },
							},
						},
					},
					count: {
						type: "number",
						description: "Number of designs found",
					},
				},
			},
		},

		{
			name: "fabric_mcp_call",
			hidden: true,
			description:
				"Execute an MCP tool with the given arguments. IMPORTANT: The 'serverTool' parameter must be in 'server/tool' format, NOT the repository name. " +
				"Examples of correct serverTool values: " +
				"'deepwiki/read_wiki_structure' (get GitHub repo documentation - requires arguments.repoName like 'langchain-ai/langgraph'), " +
				"'deepwiki/read_wiki_contents' (read specific wiki page - requires arguments.repoName and arguments.pagePath), " +
				"'deepwiki/ask_question' (ask about a repo - requires arguments.repoName and arguments.question), " +
				"'context7/resolve-library-id' (find library - requires arguments.libraryName), " +
				"'context7/query-docs' (search docs - requires arguments.libraryId and arguments.query). " +
				"NEVER pass repository names like 'langchain-ai/langgraph' as serverTool - that goes in arguments.repoName instead!",
			inputSchema: {
				type: "object",
				properties: {
					serverTool: {
						type: "string",
						description:
							"MCP tool identifier in 'server/tool' format. Examples: 'deepwiki/read_wiki_structure', 'deepwiki/ask_question', 'context7/query-docs'. NOT a repository name!",
					},
					arguments: {
						type: "object",
						description:
							"Tool arguments object. For deepwiki tools: { repoName: 'owner/repo' }. For context7: { libraryId: '/org/lib', query: 'search term' }",
						properties: {
							repoName: {
								type: "string",
								description:
									"GitHub repository in 'owner/repo' format (for deepwiki tools)",
							},
							pagePath: {
								type: "string",
								description:
									"Wiki page path (for deepwiki/read_wiki_contents)",
							},
							question: {
								type: "string",
								description:
									"Question to ask about the repo (for deepwiki/ask_question)",
							},
							libraryName: {
								type: "string",
								description:
									"Library name to search (for context7/resolve-library-id)",
							},
							libraryId: {
								type: "string",
								description:
									"Library ID from resolve-library-id (for context7/query-docs)",
							},
							query: {
								type: "string",
								description:
									"Search query (for context7/query-docs)",
							},
						},
					},
				},
				required: ["serverTool"],
			},
			outputSchema: {
				type: "object",
				properties: {
					response: {
						type: "string",
						description: "Tool execution result",
					},
					content: {
						type: "any",
						description: "Raw tool output content",
					},
					isError: {
						type: "boolean",
						description: "Whether the call resulted in an error",
					},
					error: {
						type: "string",
						description: "Error message if isError is true",
					},
				},
				description: "Returns tool execution result",
			},
		},

		// =======================================================================
		// Code Search Tools (Repository code search, file retrieval, structure)
		// =======================================================================
		{
			name: "code_search",
			description:
				"Search the project's connected repositories for code matching a query. Returns file paths and matched snippets. " +
				"If the project has multiple repositories connected, searches across all of them. " +
				"Use this to find specific functions, classes, patterns, or implementations in the codebase. " +
				"KEYWORDS: code search, find function, find class, source code, implementation, codebase, " +
				"repository, search code, find code, how is X implemented.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"Search query — use specific terms, function names, or patterns",
					},
					path: {
						type: "string",
						description:
							"Filter results to a specific directory path (e.g., 'src/auth')",
					},
					language: {
						type: "string",
						description:
							"Filter by programming language (e.g., 'typescript', 'python')",
					},
					repo: {
						type: "string",
						description:
							"Filter to a specific repository in owner/name format (e.g., 'acme/backend'). Omit to search all connected repos.",
					},
				},
				required: ["query"],
			},
			outputSchema: {
				type: "object",
				properties: {
					results: {
						type: "array",
						items: {
							type: "object",
							properties: {
								filePath: { type: "string" },
								fileName: { type: "string" },
								matchedSnippets: {
									type: "array",
									items: { type: "string" },
								},
							},
						},
					},
					totalCount: { type: "number" },
				},
			},
		},
		{
			name: "code_file_get",
			description:
				"Fetch the full content of a specific file from the project's connected repositories by its path. " +
				"Use after code_search to read the full source of a relevant file. " +
				"If multiple repos are connected and no repo is specified, tries each repo until the file is found. " +
				"KEYWORDS: get file, read file, file content, source file, view code, open file.",
			inputSchema: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description:
							"File path relative to repository root (e.g., 'src/auth/middleware.ts')",
					},
					repo: {
						type: "string",
						description:
							"Target repository in owner/name format (e.g., 'acme/backend'). Omit to search all connected repos.",
					},
				},
				required: ["path"],
			},
			outputSchema: {
				type: "object",
				properties: {
					file: {
						type: "object",
						properties: {
							path: { type: "string" },
							content: { type: "string" },
							size: { type: "number" },
							isBinary: { type: "boolean" },
							isTruncated: { type: "boolean" },
						},
					},
				},
			},
		},
		{
			name: "code_tree",
			description:
				"List the directory tree of the project's connected repositories. Useful for understanding the project structure. " +
				"If multiple repos are connected, lists structure from all repos unless a specific one is specified. " +
				"KEYWORDS: directory tree, project structure, list files, file tree, repository structure.",
			inputSchema: {
				type: "object",
				properties: {
					directory: {
						type: "string",
						description:
							"Filter to a specific directory (e.g., 'src/components'). Omit for full tree.",
					},
					repo: {
						type: "string",
						description:
							"Target repository in owner/name format (e.g., 'acme/backend'). Omit to list all connected repos.",
					},
				},
				required: [],
			},
			outputSchema: {
				type: "object",
				properties: {
					structure: {
						type: "object",
						properties: {
							entries: {
								type: "array",
								items: {
									type: "object",
									properties: {
										path: { type: "string" },
										type: { type: "string" },
										size: { type: "number" },
									},
								},
							},
							truncated: { type: "boolean" },
						},
					},
					totalFiles: { type: "number" },
					totalDirectories: { type: "number" },
				},
			},
		},
		{
			name: "code_search_semantic",
			description:
				"Semantic search over the project's indexed codebase using AST-aware code chunks. " +
				"Returns relevant functions, classes, and code snippets that semantically match the query. " +
				"More accurate than API-based search for understanding code patterns and architecture. " +
				"Requires the project to have a READY code index. " +
				"KEYWORDS: semantic code search, function search, class search, code understanding, architecture.",
			inputSchema: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description:
							"Natural language query describing the code you're looking for (e.g., 'authentication middleware', 'database connection pooling').",
					},
					language: {
						type: "string",
						description:
							"Filter by programming language (e.g., 'typescript', 'python').",
					},
				},
				required: ["query"],
			},
			outputSchema: {
				type: "object",
				properties: {
					results: {
						type: "array",
						items: {
							type: "object",
							properties: {
								filePath: { type: "string" },
								symbolName: { type: "string" },
								symbolType: { type: "string" },
								content: { type: "string" },
							},
						},
					},
				},
			},
		},
	];
}
