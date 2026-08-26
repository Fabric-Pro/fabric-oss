/**
 * Fabric AI Handler
 *
 * Handles steps that execute Fabric AI tools (YouTube, scraping, patterns).
 * These are tools from the "Fabric AI" virtual server discovered via semantic search.
 */

import { resolveOpenAiApiKey } from "@repo/ai";
import {
	createFirstClassFrame,
	getFirstClassFrame,
	listFirstClassFrames,
	shareFirstClassFrame,
	updateFirstClassFrame,
} from "../../../shared/frame-service";
import { guardToolWriteForReadOnly } from "../../../shared/read-only-gate";
import type { ExecuteStepInput, ExecuteStepOutput } from "../../types";
import {
	publishStepProgress,
	publishToolComplete,
	publishToolStart,
} from "../../utils/partykit-publisher";
import type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./types";

export class FabricAiHandler implements StepHandler {
	readonly name = "fabric-ai";
	readonly capabilities = ["fabric_ai"];

	canHandle(input: ExecuteStepInput): boolean {
		const app = input.step.app;
		const executor = input.step.executor;
		return Boolean(
			app?.startsWith("fabric_") || executor?.startsWith("fabric_"),
		);
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		const toolName = input.step.app || input.step.executor || "";

		console.log(`[FabricAiHandler] Executing Fabric AI tool: ${toolName}`);

		try {
			const output = await this.executeFabricAiTool(input, toolName);
			return {
				handled: true,
				output,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error("[FabricAiHandler] Fabric AI tool failed:", error);
			return {
				handled: false,
				error: `Fabric AI tool ${toolName} failed: ${errorMessage}`,
				shouldFallback: false,
			};
		}
	}

	private async executeFabricAiTool(
		input: ExecuteStepInput,
		toolName: string,
	): Promise<ExecuteStepOutput> {
		const startTime = Date.now();
		const stepInputs = input.step.inputs as
			| Record<string, unknown>
			| undefined;
		const executionId = input.executionId;
		const toolCallId = `fabric-${toolName}-${Date.now()}`;

		console.log(`[FabricAiHandler] Fabric AI tool: ${toolName}`, {
			stepId: input.step.id,
			inputs: stepInputs,
		});

		// Read-only mode: most fabric_* tools are Fabric-internal
		// and exempt at the chokepoint, but the third-party integration families
		// (fabric_asana_*, fabric_attio_*, fabric_front_*) and the generic
		// fabric_mcp_call dispatch write to EXTERNAL services with the user's
		// credentials — the fabric_ exemption must not protect them (post-ship
		// review finding). Gate the vendor-stripped operation so reads
		// (list/search) still pass; for fabric_mcp_call gate the INNER server
		// tool (an absent/malformed serverTool classifies WRITE — fail-closed;
		// the case itself rejects it anyway).
		const externalVendorMatch = toolName.match(
			/^fabric_(?:asana|attio|front)_(.+)$/,
		);
		const externalOperation = externalVendorMatch
			? externalVendorMatch[1]
			: toolName === "fabric_mcp_call"
				? String(stepInputs?.serverTool ?? "")
						.split("/")
						.pop() || "unknown_tool"
				: null;
		if (externalOperation) {
			const readOnlyBlock = await guardToolWriteForReadOnly(
				input.projectId,
				externalOperation,
			);
			if (readOnlyBlock) {
				throw new Error(readOnlyBlock.error);
			}
		}

		// Publish tool start to PartyKit for real-time UI updates
		if (executionId) {
			publishToolStart(executionId, input.step.id, {
				id: toolCallId,
				name: toolName,
				args: stepInputs || {},
				serverName: "Fabric AI",
			}).catch(() => {}); // Non-blocking

			// Also publish step progress with "executing" phase
			publishStepProgress(executionId, {
				stepId: input.step.id,
				stepDescription: input.step.description,
				phase: "executing",
				toolCalls: [
					{
						id: toolCallId,
						name: toolName,
						args: stepInputs || {},
						status: "running",
						serverName: "Fabric AI",
					},
				],
			}).catch(() => {}); // Non-blocking
		}

		// Import Fabric AI activities dynamically to avoid circular deps
		const fabricAi = await import("../../../fabric-ai");
		const { createFabricClient } = await import("@repo/fabric-ai");

		let result: string;
		const toolCalls: ToolCallRecord[] = [];

		// Get context from previous steps for chaining
		const previousContent =
			input.previousStepResults.length > 0
				? input.previousStepResults[
						input.previousStepResults.length - 1
					].response || ""
				: "";

		switch (toolName) {
			case "fabric_youtube_transcript": {
				const url = this.extractUrl(stepInputs, [
					"url",
					"video_url",
					"videoUrl",
				]);
				if (!url) {
					throw new Error("YouTube URL is required");
				}

				console.log(
					`[FabricAiHandler] Extracting YouTube transcript: ${url}`,
				);

				const transcriptResult =
					await fabricAi.extractYouTubeTranscript({
						url,
						timestamps:
							(stepInputs?.timestamps as boolean) || false,
					});

				result = transcriptResult.transcript || "";
				toolCalls.push({
					id: `fabric-yt-${Date.now()}`,
					name: toolName,
					args: { url },
					result: {
						transcriptLength: result.length,
						title: transcriptResult.title,
						videoId: transcriptResult.videoId,
					},
					status: transcriptResult.success ? "success" : "error",
					durationMs: transcriptResult.durationMs,
				});
				break;
			}

			case "fabric_analyze_youtube": {
				const url = this.extractUrl(stepInputs, [
					"url",
					"video_url",
					"videoUrl",
				]);
				const pattern = (stepInputs?.pattern as string) || "summarize";
				if (!url) {
					throw new Error("YouTube URL is required");
				}

				console.log(
					`[FabricAiHandler] Analyzing YouTube video: ${url} with pattern: ${pattern}`,
				);

				const analyzeResult = await fabricAi.analyzeYouTubeVideo({
					url,
					pattern: pattern as any,
					userId: input.userId,
					organizationId: input.organizationId,
					projectId: input.projectId,
				});

				result = analyzeResult.analysis || "";
				toolCalls.push({
					id: `fabric-yt-analyze-${Date.now()}`,
					name: toolName,
					args: { url, pattern },
					result: {
						analysisLength: result.length,
						title: analyzeResult.title,
					},
					status: analyzeResult.success ? "success" : "error",
					durationMs: analyzeResult.durationMs,
				});
				break;
			}

			case "fabric_scrape_url": {
				const url = (stepInputs?.url as string) || "";
				const htmlInput = (stepInputs?.html as string) || "";

				// Auto-route to readability if html is provided instead of url
				if (!url && htmlInput) {
					console.log(
						"[FabricAiHandler] fabric_scrape_url received html instead of url, routing to readability extraction",
					);
					const client = createFabricClient();
					const readabilityResponse =
						await client.extractReadableContent(htmlInput, "");
					result = readabilityResponse.content;
					toolCalls.push({
						id: `fabric-scrape-${Date.now()}`,
						name: "fabric_readability",
						args: { htmlLength: htmlInput.length },
						result: { contentLength: result.length },
						status: "success",
						durationMs: Date.now() - startTime,
					});
					break;
				}

				if (!url) {
					throw new Error("URL is required for scraping");
				}

				console.log(`[FabricAiHandler] Scraping URL: ${url}`);

				const scrapeResult = await fabricAi.scrapeUrlActivity({
					url,
					userId: input.userId,
					organizationId: input.organizationId,
				});

				result = scrapeResult.content || "";
				toolCalls.push({
					id: `fabric-scrape-${Date.now()}`,
					name: toolName,
					args: { url },
					result: { contentLength: result.length },
					status: scrapeResult.success ? "success" : "error",
					durationMs: scrapeResult.durationMs,
				});
				break;
			}

			case "fabric_scrape_and_analyze": {
				const url = (stepInputs?.url as string) || "";
				const pattern = (stepInputs?.pattern as string) || "summarize";
				if (!url) {
					throw new Error("URL is required for scraping");
				}

				console.log(
					`[FabricAiHandler] Scraping and analyzing URL: ${url}`,
				);

				const analyzeResult = await fabricAi.scrapeAndAnalyzeActivity({
					url,
					pattern: pattern as any,
					userId: input.userId,
					organizationId: input.organizationId,
					projectId: input.projectId,
				});

				result = analyzeResult.analysis || "";
				toolCalls.push({
					id: `fabric-scrape-analyze-${Date.now()}`,
					name: toolName,
					args: { url, pattern },
					result: { analysisLength: result.length },
					status: analyzeResult.success ? "success" : "error",
					durationMs: analyzeResult.durationMs,
				});
				break;
			}

			case "fabric_web_search": {
				const query = (stepInputs?.query as string) || "";
				if (!query) {
					throw new Error("Search query is required");
				}

				console.log(`[FabricAiHandler] Web search: ${query}`);

				const searchResult = await fabricAi.searchWebActivity({
					question: query,
					userId: input.userId,
					organizationId: input.organizationId,
				});

				result = searchResult.results || "";
				toolCalls.push({
					id: `fabric-search-${Date.now()}`,
					name: toolName,
					args: { query },
					result: { resultLength: result.length },
					status: searchResult.success ? "success" : "error",
					durationMs: searchResult.durationMs,
				});
				break;
			}

			case "fabric_search_and_analyze": {
				const query = (stepInputs?.query as string) || "";
				const pattern = (stepInputs?.pattern as string) || "summarize";
				if (!query) {
					throw new Error("Search query is required");
				}

				console.log(`[FabricAiHandler] Search and analyze: ${query}`);

				const analyzeResult = await fabricAi.searchAndAnalyzeActivity({
					question: query,
					pattern: pattern as any,
					userId: input.userId,
					organizationId: input.organizationId,
					projectId: input.projectId,
				});

				result = analyzeResult.analysis || "";
				toolCalls.push({
					id: `fabric-search-analyze-${Date.now()}`,
					name: toolName,
					args: { query, pattern },
					result: { analysisLength: result.length },
					status: analyzeResult.success ? "success" : "error",
					durationMs: analyzeResult.durationMs,
				});
				break;
			}

			case "fabric_pattern": {
				const pattern = (stepInputs?.pattern as string) || "summarize";
				let inputText =
					(stepInputs?.input as string) ||
					(stepInputs?.content as string) ||
					previousContent;
				const variables =
					(stepInputs?.variables as Record<string, string>) || {};

				if (!inputText) {
					throw new Error(
						"Input text is required for pattern execution. Either provide 'input' or ensure previous step has output.",
					);
				}

				// AUTO-DETECT: If the input is a YouTube URL, extract transcript first
				const youtubeUrlRegex =
					/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/;
				const youtubeMatch = inputText.match(youtubeUrlRegex);

				if (youtubeMatch && inputText.length < 500) {
					console.log(
						"[FabricAiHandler] Auto-detected YouTube URL, extracting transcript first",
					);

					const transcriptResult =
						await fabricAi.extractYouTubeTranscript({
							url: inputText.trim(),
							timestamps: false,
						});

					if (
						transcriptResult.success &&
						transcriptResult.transcript
					) {
						inputText = transcriptResult.transcript;
						console.log(
							`[FabricAiHandler] Extracted YouTube transcript: ${inputText.length} chars`,
						);
					} else {
						console.warn(
							`[FabricAiHandler] Failed to extract YouTube transcript: ${transcriptResult.error}`,
						);
					}
				}

				console.log(
					`[FabricAiHandler] Applying pattern "${pattern}" to ${inputText.length} chars`,
				);

				const patternResult = await fabricAi.executeFabricPattern({
					pattern: pattern as any,
					input: inputText,
					variables,
					userId: input.userId,
					organizationId: input.organizationId,
					projectId: input.projectId,
				});

				result = patternResult.output;
				toolCalls.push({
					id: `fabric-pattern-${Date.now()}`,
					name: toolName,
					args: { pattern, inputLength: inputText.length },
					result: { outputLength: result.length },
					status: patternResult.success ? "success" : "error",
					durationMs: patternResult.durationMs,
				});
				break;
			}

			case "fabric_list_patterns": {
				console.log("[FabricAiHandler] Listing Fabric patterns");
				const listStartTime = Date.now();

				const patternsResult =
					await fabricAi.listFabricPatternsActivity();
				const patterns = patternsResult.patterns || [];

				result = patterns.map((p) => `- ${p}`).join("\n");
				toolCalls.push({
					id: `fabric-list-patterns-${Date.now()}`,
					name: toolName,
					args: {},
					result: { patternCount: patterns.length },
					status: patternsResult.success ? "success" : "error",
					durationMs: Date.now() - listStartTime,
				});
				break;
			}

			case "fabric_youtube_metadata": {
				const url = this.extractUrl(stepInputs, [
					"url",
					"video_url",
					"videoUrl",
				]);
				if (!url) {
					throw new Error("YouTube URL is required");
				}

				console.log(
					`[FabricAiHandler] Getting YouTube metadata: ${url}`,
				);
				const metadataStartTime = Date.now();

				// Issue AI token for delegated YouTube API access
				const { issueAIToken } = await import("@repo/ai-token");
				const aiToken = await issueAIToken({
					userId: input.userId,
					organizationId: input.organizationId,
					source: "fabric-youtube-metadata",
				});

				const client = createFabricClient();
				const metadata = await client.getYouTubeMetadata(url, aiToken);

				result = JSON.stringify(metadata, null, 2);
				toolCalls.push({
					id: `fabric-youtube-metadata-${Date.now()}`,
					name: toolName,
					args: { url },
					result: {
						videoId: metadata.videoId,
						title: metadata.title,
					},
					status: "success",
					durationMs: Date.now() - metadataStartTime,
				});
				break;
			}

			case "fabric_youtube_comments": {
				const url = this.extractUrl(stepInputs, [
					"url",
					"video_url",
					"videoUrl",
				]);
				if (!url) {
					throw new Error("YouTube URL is required");
				}

				console.log(
					`[FabricAiHandler] Getting YouTube comments: ${url}`,
				);
				const commentsStartTime = Date.now();

				// Issue AI token for delegated YouTube API access
				const { issueAIToken: issueAITokenComments } = await import(
					"@repo/ai-token"
				);
				const commentsAiToken = await issueAITokenComments({
					userId: input.userId,
					organizationId: input.organizationId,
					source: "fabric-youtube-comments",
				});

				const client = createFabricClient();
				const commentsResponse = await client.getYouTubeComments(
					url,
					commentsAiToken,
				);

				result = commentsResponse.comments.join("\n\n");
				toolCalls.push({
					id: `fabric-youtube-comments-${Date.now()}`,
					name: toolName,
					args: { url },
					result: { commentCount: commentsResponse.count },
					status: "success",
					durationMs: Date.now() - commentsStartTime,
				});
				break;
			}

			case "fabric_youtube_playlist": {
				const url = this.extractUrl(stepInputs, [
					"url",
					"playlist_url",
					"playlistUrl",
				]);
				if (!url) {
					throw new Error("YouTube playlist URL is required");
				}

				console.log(
					`[FabricAiHandler] Getting YouTube playlist: ${url}`,
				);
				const playlistStartTime = Date.now();

				// Issue AI token for delegated YouTube API access
				const { issueAIToken: issueAITokenPlaylist } = await import(
					"@repo/ai-token"
				);
				const playlistAiToken = await issueAITokenPlaylist({
					userId: input.userId,
					organizationId: input.organizationId,
					source: "fabric-youtube-playlist",
				});

				const client = createFabricClient();
				const playlistResponse = await client.getYouTubePlaylist(
					url,
					playlistAiToken,
				);

				result = playlistResponse.videos
					.map((v) => `- [${v.title}](${v.url})`)
					.join("\n");
				toolCalls.push({
					id: `fabric-youtube-playlist-${Date.now()}`,
					name: toolName,
					args: { url },
					result: {
						videoCount: playlistResponse.count,
						playlistId: playlistResponse.playlistId,
					},
					status: "success",
					durationMs: Date.now() - playlistStartTime,
				});
				break;
			}

			case "fabric_transcribe_audio": {
				const fileContentBase64 =
					(stepInputs?.fileContent as string) || "";
				const fileName = (stepInputs?.fileName as string) || "";
				const model = (stepInputs?.model as string) || "whisper-1";

				if (!fileContentBase64 || !fileName) {
					throw new Error(
						"File content and filename are required for transcription",
					);
				}

				console.log(
					`[FabricAiHandler] Transcribing audio: ${fileName}`,
				);

				const transcribeResult = await fabricAi.transcribeAudioActivity(
					{
						fileContentBase64,
						fileName,
						model: model as any,
						userId: input.userId,
						organizationId: input.organizationId,
					},
				);

				result = transcribeResult.transcript || "";
				toolCalls.push({
					id: `fabric-transcribe-${Date.now()}`,
					name: toolName,
					args: { fileName, model },
					result: { textLength: result.length },
					status: transcribeResult.success ? "success" : "error",
					durationMs: transcribeResult.durationMs,
				});
				break;
			}

			case "fabric_readability": {
				const html = (stepInputs?.html as string) || "";
				const sourceUrl = (stepInputs?.url as string) || "";

				if (!html) {
					throw new Error(
						"HTML content is required for readability extraction",
					);
				}

				console.log(
					`[FabricAiHandler] Extracting readable content from HTML (${html.length} chars)`,
				);
				const readabilityStartTime = Date.now();

				const client = createFabricClient();
				const readabilityResponse = await client.extractReadableContent(
					html,
					sourceUrl,
				);

				result = readabilityResponse.content;
				toolCalls.push({
					id: `fabric-readability-${Date.now()}`,
					name: toolName,
					args: { htmlLength: html.length, url: sourceUrl },
					result: { contentLength: result.length },
					status: "success",
					durationMs: Date.now() - readabilityStartTime,
				});
				break;
			}

			case "fabric_template": {
				const template = (stepInputs?.template as string) || "";
				const variables =
					(stepInputs?.variables as Record<string, string>) || {};
				const templateInput =
					(stepInputs?.input as string) || previousContent;

				if (!template) {
					throw new Error("Template string is required");
				}

				console.log(
					`[FabricAiHandler] Applying template plugins (${template.length} chars)`,
				);
				const templateStartTime = Date.now();

				const client = createFabricClient();
				const templateResponse = await client.applyTemplate(
					template,
					variables,
					templateInput,
				);

				result = templateResponse.output;
				toolCalls.push({
					id: `fabric-template-${Date.now()}`,
					name: toolName,
					args: {
						templateLength: template.length,
						hasVariables: Object.keys(variables).length > 0,
					},
					result: { outputLength: result.length },
					status: "success",
					durationMs: Date.now() - templateStartTime,
				});
				break;
			}

			case "fabric_list_strategies": {
				console.log("[FabricAiHandler] Listing Fabric strategies");
				const strategiesStartTime = Date.now();

				const strategiesResult =
					await fabricAi.listStrategiesActivity();
				const strategies = strategiesResult.strategies || [];

				result = strategies
					.map(
						(s) =>
							`- **${s.name}**: ${s.description || "No description"}`,
					)
					.join("\n");
				toolCalls.push({
					id: `fabric-list-strategies-${Date.now()}`,
					name: toolName,
					args: {},
					result: { strategyCount: strategies.length },
					status: strategiesResult.success ? "success" : "error",
					durationMs: Date.now() - strategiesStartTime,
				});
				break;
			}

			case "fabric_get_strategy": {
				const name = (stepInputs?.name as string) || "";
				if (!name) {
					throw new Error("Strategy name is required");
				}

				console.log(
					`[FabricAiHandler] Getting Fabric strategy: ${name}`,
				);
				const strategyStartTime = Date.now();

				const client = createFabricClient();
				const strategy = await client.getStrategy(name);

				result = strategy.content;
				toolCalls.push({
					id: `fabric-get-strategy-${Date.now()}`,
					name: toolName,
					args: { name },
					result: { contentLength: result.length },
					status: "success",
					durationMs: Date.now() - strategyStartTime,
				});
				break;
			}

			case "fabric_list_contexts": {
				console.log("[FabricAiHandler] Listing Fabric contexts");
				const contextsStartTime = Date.now();

				const contextsResult = await fabricAi.listContextsActivity();
				const contexts = contextsResult.contexts || [];

				result = contexts.map((c) => `- ${c}`).join("\n");
				toolCalls.push({
					id: `fabric-list-contexts-${Date.now()}`,
					name: toolName,
					args: {},
					result: { contextCount: contexts.length },
					status: contextsResult.success ? "success" : "error",
					durationMs: Date.now() - contextsStartTime,
				});
				break;
			}

			case "fabric_get_context": {
				const name = (stepInputs?.name as string) || "";
				if (!name) {
					throw new Error("Context name is required");
				}

				console.log(
					`[FabricAiHandler] Getting Fabric context: ${name}`,
				);
				const contextStartTime = Date.now();

				const client = createFabricClient();
				const context = await client.getContextContent(name);

				result = context.content;
				toolCalls.push({
					id: `fabric-get-context-${Date.now()}`,
					name: toolName,
					args: { name },
					result: { contentLength: result.length },
					status: "success",
					durationMs: Date.now() - contextStartTime,
				});
				break;
			}

			// =====================================================================
			// Image Generation Tool
			// =====================================================================

			case "fabric_generate_image": {
				const prompt = (stepInputs?.prompt as string) || "";
				const provider =
					(stepInputs?.provider as "gateway" | "fal" | "gemini") ||
					"gateway";
				const aspectRatio =
					(stepInputs?.aspectRatio as string) || "1:1";
				const quality = (stepInputs?.quality as string) || "medium";
				const model = stepInputs?.model as string | undefined;
				const gatewayModel = stepInputs?.gatewayModel as
					| string
					| undefined;
				// Use inputImage storage path from step inputs, fallback to first attached image path
				const inputImagePath =
					(stepInputs?.inputImage as string) ||
					input.attachedImageUrls?.[0] ||
					undefined;

				if (!prompt) {
					throw new Error("Prompt is required for image generation");
				}

				console.log(
					`[FabricAiHandler] Generating image with ${provider}: "${prompt.substring(0, 100)}..."${inputImagePath ? " (with input image)" : ""}`,
				);

				const { generateImageActivity } = await import(
					"../../../image-generation"
				);

				const imageResult = await generateImageActivity({
					prompt,
					provider,
					aspectRatio,
					quality,
					model,
					inputImagePath,
					gatewayModel,
					userId: input.userId,
					organizationId: input.organizationId,
				});

				if (!imageResult.success) {
					throw new Error(
						imageResult.error || "Image generation failed",
					);
				}

				// Use proxy URL for stable image display (won't expire like signed URLs)
				const orgParam = input.organizationId
					? `&orgId=${encodeURIComponent(input.organizationId)}`
					: "";
				const imageDisplayUrl = imageResult.storagePath
					? `/api/storage/image?path=${encodeURIComponent(imageResult.storagePath)}${orgParam}`
					: imageResult.imageUrl;

				// Include markdown image syntax so the LLM naturally renders it in the response
				const dimensions =
					imageResult.width && imageResult.height
						? ` (${imageResult.width}x${imageResult.height})`
						: "";
				result = `![Generated Image](${imageDisplayUrl})\n\n`;
				if (imageResult.text) {
					result += `${imageResult.text}\n\n`;
				}
				result +=
					`Image generated successfully using ${imageResult.provider}${dimensions}.\n` +
					`Model: ${imageResult.model}`;

				toolCalls.push({
					id: `fabric-generate-image-${Date.now()}`,
					name: toolName,
					args: {
						prompt: prompt.substring(0, 200),
						provider,
						aspectRatio,
						quality,
						hasInputImage: !!inputImagePath,
					},
					result: {
						imageUrl: imageDisplayUrl,
						storagePath: imageResult.storagePath,
						width: imageResult.width,
						height: imageResult.height,
						provider: imageResult.provider,
					},
					status: "success",
					durationMs: imageResult.durationMs,
				});
				break;
			}

			// =====================================================================
			// MCP CLI Tools - Dynamic MCP Server Discovery and Tool Execution
			// These tools enable agents to dynamically discover and interact with
			// MCP servers without loading all tool schemas upfront.
			// =====================================================================

			case "fabric_mcp_list": {
				const withDescriptions =
					(stepInputs?.withDescriptions as boolean) || false;

				console.log(
					`[FabricAiHandler] Listing MCP servers (withDescriptions: ${withDescriptions})`,
				);
				const mcpListStartTime = Date.now();

				const client = createFabricClient();
				const listResponse = await client.mcpCliList(withDescriptions);

				// Format as readable text
				const serversList = listResponse.servers
					.map((s) => {
						const toolsList = s.tools
							.map(
								(t) =>
									`  - ${t.name}${t.description ? `: ${t.description}` : ""}`,
							)
							.join("\n");
						return `**${s.name}**\n${toolsList}`;
					})
					.join("\n\n");

				result = serversList || "No MCP servers configured";
				toolCalls.push({
					id: `fabric-mcp-list-${Date.now()}`,
					name: toolName,
					args: { withDescriptions },
					result: { serverCount: listResponse.count },
					status: "success",
					durationMs: Date.now() - mcpListStartTime,
				});
				break;
			}

			case "fabric_mcp_grep": {
				const pattern = (stepInputs?.pattern as string) || "";
				const withDescriptions =
					(stepInputs?.withDescriptions as boolean) || false;

				if (!pattern) {
					throw new Error("Search pattern is required");
				}

				console.log(
					`[FabricAiHandler] Searching MCP tools with pattern: ${pattern}`,
				);
				const mcpGrepStartTime = Date.now();

				const client = createFabricClient();
				const grepResponse = await client.mcpCliGrep(
					pattern,
					withDescriptions,
				);

				// Format as readable list
				const toolsList = grepResponse.tools
					.map(
						(t) =>
							`- ${t.server}/${t.name}${t.description ? ` - ${t.description}` : ""}`,
					)
					.join("\n");

				result = toolsList || `No tools matching pattern "${pattern}"`;
				toolCalls.push({
					id: `fabric-mcp-grep-${Date.now()}`,
					name: toolName,
					args: { pattern, withDescriptions },
					result: { matchCount: grepResponse.count },
					status: "success",
					durationMs: Date.now() - mcpGrepStartTime,
				});
				break;
			}

			case "fabric_mcp_schema": {
				const serverTool = (stepInputs?.serverTool as string) || "";

				if (!serverTool) {
					throw new Error(
						"serverTool parameter is required (format: server/tool)",
					);
				}

				console.log(
					`[FabricAiHandler] Getting MCP tool schema: ${serverTool}`,
				);
				const mcpSchemaStartTime = Date.now();

				const client = createFabricClient();
				const schemaResponse = await client.mcpCliSchema(serverTool);

				// Format schema as readable JSON
				result = JSON.stringify(
					{
						name: schemaResponse.name,
						server: schemaResponse.server,
						description: schemaResponse.description,
						inputSchema: schemaResponse.inputSchema,
					},
					null,
					2,
				);
				toolCalls.push({
					id: `fabric-mcp-schema-${Date.now()}`,
					name: toolName,
					args: { serverTool },
					result: {
						server: schemaResponse.server,
						tool: schemaResponse.name,
					},
					status: "success",
					durationMs: Date.now() - mcpSchemaStartTime,
				});
				break;
			}

			case "fabric_mcp_call": {
				const serverTool = (stepInputs?.serverTool as string) || "";
				const mcpArguments =
					(stepInputs?.arguments as Record<string, unknown>) || {};

				if (!serverTool) {
					throw new Error(
						"serverTool parameter is required (format: server/tool)",
					);
				}

				console.log(
					`[FabricAiHandler] Calling MCP tool: ${serverTool}`,
					{ arguments: mcpArguments },
				);
				const mcpCallStartTime = Date.now();

				const client = createFabricClient();
				const callResponse = await client.mcpCliCall(
					serverTool,
					mcpArguments,
				);

				if (callResponse.isError) {
					result = `Error: ${callResponse.error}`;
					toolCalls.push({
						id: `fabric-mcp-call-${Date.now()}`,
						name: toolName,
						args: { serverTool, arguments: mcpArguments },
						result: { error: callResponse.error },
						status: "error",
						durationMs: Date.now() - mcpCallStartTime,
					});
				} else {
					// Handle different content types
					if (typeof callResponse.content === "string") {
						result = callResponse.content;
					} else {
						result = JSON.stringify(callResponse.content, null, 2);
					}
					toolCalls.push({
						id: `fabric-mcp-call-${Date.now()}`,
						name: toolName,
						args: { serverTool, arguments: mcpArguments },
						result: {
							contentType: typeof callResponse.content,
							contentLength: result.length,
						},
						status: "success",
						durationMs: Date.now() - mcpCallStartTime,
					});
				}
				break;
			}

			// =====================================================================
			// Text-to-Speech Tool
			// =====================================================================

			case "fabric_text_to_speech": {
				const ttsText = (stepInputs?.text as string) || previousContent;
				const ttsVoice = (stepInputs?.voice as string) || "alloy";
				const ttsSpeed = (stepInputs?.speed as number) || 1.0;

				if (!ttsText) {
					throw new Error(
						"Text is required for text-to-speech conversion",
					);
				}

				console.log(
					`[FabricAiHandler] Converting text to speech (${ttsText.length} chars, voice: ${ttsVoice})`,
				);
				const ttsStartTime = Date.now();

				// Use OpenAI TTS API
				const { uploadFile: uploadAudio } = await import(
					"@repo/storage"
				);

				// This path calls OpenAI's TTS endpoint directly, so it needs the
				// tenant's OpenAI key specifically, decrypted — not whichever
				// provider the tenant's default model selection resolved to.
				const openAiApiKey = await resolveOpenAiApiKey({
					userId: input.userId,
					organizationId: input.organizationId,
				});

				if (!openAiApiKey) {
					throw new Error(
						"No OpenAI API key configured for text-to-speech",
					);
				}

				// Call OpenAI TTS
				const ttsResponse = await fetch(
					"https://api.openai.com/v1/audio/speech",
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${openAiApiKey}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							model: "tts-1",
							input: ttsText.substring(0, 4096), // TTS limit
							voice: ttsVoice,
							speed: Math.min(4.0, Math.max(0.25, ttsSpeed)),
							response_format: "mp3",
						}),
					},
				);

				if (!ttsResponse.ok) {
					const errText = await ttsResponse.text();
					throw new Error(
						`TTS API error ${ttsResponse.status}: ${errText}`,
					);
				}

				const audioBuffer = Buffer.from(
					await ttsResponse.arrayBuffer(),
				);
				const audioKey = `tts/${input.userId}/${Date.now()}.mp3`;

				await uploadAudio(audioKey, audioBuffer, {
					bucket:
						process.env.NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME ||
						"chat-documents",
					contentType: "audio/mpeg",
				});

				const orgParam = input.organizationId
					? `&orgId=${encodeURIComponent(input.organizationId)}`
					: "";
				const audioUrl = `/api/storage/image?path=${encodeURIComponent(audioKey)}${orgParam}`;

				// Estimate duration: ~150 words per minute average
				const wordCount = ttsText.split(/\s+/).length;
				const estimatedDuration = Math.round(
					(wordCount / 150) * 60 * (1 / ttsSpeed),
				);

				result =
					"Audio generated successfully.\n" +
					`- Voice: ${ttsVoice}\n` +
					`- Estimated duration: ~${estimatedDuration} seconds\n` +
					`- [Listen to audio](${audioUrl})`;

				toolCalls.push({
					id: `fabric-tts-${Date.now()}`,
					name: toolName,
					args: {
						textLength: ttsText.length,
						voice: ttsVoice,
						speed: ttsSpeed,
					},
					result: {
						audioUrl,
						format: "mp3",
						durationSeconds: estimatedDuration,
					},
					status: "success",
					durationMs: Date.now() - ttsStartTime,
				});
				break;
			}

			// =====================================================================
			// First-Class Frames Tools
			// =====================================================================

			case "fabric_create_frame":
			case "fabric_create_slideshow": {
				const frameStartTime = Date.now();
				const frameResult = await createFirstClassFrame({
					args:
						toolName === "fabric_create_slideshow"
							? { ...stepInputs, kind: "slideshow" }
							: stepInputs,
					userId: input.userId,
					organizationId: input.organizationId || undefined,
					conversationId: input.conversationId ?? input.executionId,
					sourceRunType: "ORCHESTRATOR",
					sourceRunId: input.executionId,
				});
				if ("error" in frameResult) {
					throw new Error(frameResult.error);
				}

				result =
					`${frameResult.response}\n` +
					`- Frame ID: ${frameResult.frameId}\n` +
					`- Kind: ${frameResult.kind}\n` +
					`- Content Type: ${frameResult.contentType}\n` +
					(frameResult.shareUrl
						? `- [Shared frame](${frameResult.shareUrl})\n`
						: "") +
					(frameResult.frameUrl
						? `- Internal route: ${frameResult.frameUrl}\n`
						: "") +
					`\nContent:\n\`\`\`\n${frameResult.content.substring(0, 2000)}${frameResult.content.length > 2000 ? "\n..." : ""}\n\`\`\``;

				// Drop rendered content from the persisted tool result. The DB owns
				// the content; carrying it here trips the workflow output's 5KB
				// per-result truncation and replaces the whole object with a
				// sentinel string, which strands the client without `frameId`.
				const { content: _content, ...leanResult } = frameResult;
				toolCalls.push({
					id: `fabric-create-frame-${Date.now()}`,
					name: toolName,
					args: stepInputs || {},
					result: leanResult,
					status: "success",
					durationMs: Date.now() - frameStartTime,
				});
				break;
			}

			case "fabric_update_frame": {
				const frameStartTime = Date.now();
				const frameResult = await updateFirstClassFrame({
					args: stepInputs,
					userId: input.userId,
					organizationId: input.organizationId || undefined,
				});
				if ("error" in frameResult) {
					throw new Error(frameResult.error);
				}
				result = frameResult.response;
				toolCalls.push({
					id: `fabric-update-frame-${Date.now()}`,
					name: toolName,
					args: stepInputs || {},
					result: frameResult,
					status: "success",
					durationMs: Date.now() - frameStartTime,
				});
				break;
			}

			case "fabric_get_frame": {
				const frameStartTime = Date.now();
				const frameResult = await getFirstClassFrame({
					args: stepInputs,
					userId: input.userId,
					organizationId: input.organizationId || undefined,
				});
				if ("error" in frameResult) {
					throw new Error(frameResult.error);
				}
				result = `Loaded frame "${frameResult.title}".`;
				toolCalls.push({
					id: `fabric-get-frame-${Date.now()}`,
					name: toolName,
					args: stepInputs || {},
					result: frameResult,
					status: "success",
					durationMs: Date.now() - frameStartTime,
				});
				break;
			}

			case "fabric_list_frames": {
				const frameStartTime = Date.now();
				const frameResult = await listFirstClassFrames({
					userId: input.userId,
					organizationId: input.organizationId || undefined,
					conversationId: input.conversationId ?? input.executionId,
				});
				result = `Found ${frameResult.frames.length} frame(s).`;
				toolCalls.push({
					id: `fabric-list-frames-${Date.now()}`,
					name: toolName,
					args: stepInputs || {},
					result: frameResult,
					status: "success",
					durationMs: Date.now() - frameStartTime,
				});
				break;
			}

			case "fabric_share_frame": {
				const frameStartTime = Date.now();
				const frameResult = await shareFirstClassFrame({
					args: stepInputs,
					userId: input.userId,
					organizationId: input.organizationId || undefined,
				});
				if ("error" in frameResult) {
					throw new Error(frameResult.error);
				}
				result = frameResult.response;
				toolCalls.push({
					id: `fabric-share-frame-${Date.now()}`,
					name: toolName,
					args: stepInputs || {},
					result: frameResult,
					status: "success",
					durationMs: Date.now() - frameStartTime,
				});
				break;
			}

			// =====================================================================
			// Third-Party Integration Tools
			// =====================================================================

			case "fabric_asana_create_task": {
				const { fetchCredentialsByProvider } = await import(
					"@repo/database"
				);
				const asanaCreds = await fetchCredentialsByProvider(
					"ASANA",
					input.userId,
					input.organizationId,
				);
				if (!asanaCreds?.ASANA_ACCESS_TOKEN) {
					throw new Error(
						"Asana integration not configured. Please add your Asana API token in Settings > Integrations.",
					);
				}

				const taskName = (stepInputs?.name as string) || "";
				const taskNotes = (stepInputs?.notes as string) || "";
				const projectId = (stepInputs?.projectId as string) || "";
				const dueOn = (stepInputs?.dueOn as string) || "";
				const asanaStartTime = Date.now();

				if (!taskName) {
					throw new Error("Task name is required");
				}

				const taskBody: Record<string, unknown> = {
					data: {
						name: taskName,
						...(taskNotes && { notes: taskNotes }),
						...(dueOn && { due_on: dueOn }),
						...(projectId && { projects: [projectId] }),
					},
				};

				const asanaResp = await fetch(
					"https://app.asana.com/api/1.0/tasks",
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${asanaCreds.ASANA_ACCESS_TOKEN}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(taskBody),
					},
				);

				if (!asanaResp.ok) {
					const errText = await asanaResp.text();
					throw new Error(
						`Asana API error ${asanaResp.status}: ${errText}`,
					);
				}

				const asanaData = (await asanaResp.json()) as {
					data: { gid: string; name: string; permalink_url?: string };
				};
				const taskGid = asanaData.data.gid;
				const taskUrl =
					asanaData.data.permalink_url ||
					`https://app.asana.com/0/${projectId}/${taskGid}`;

				result = `Asana task created: "${taskName}"\n- Task ID: ${taskGid}\n- URL: ${taskUrl}`;
				toolCalls.push({
					id: `fabric-asana-create-${Date.now()}`,
					name: toolName,
					args: { name: taskName, projectId },
					result: { taskId: taskGid, taskUrl },
					status: "success",
					durationMs: Date.now() - asanaStartTime,
				});
				break;
			}

			case "fabric_asana_list_tasks": {
				const { fetchCredentialsByProvider: fetchAsanaCreds } =
					await import("@repo/database");
				const asanaListCreds = await fetchAsanaCreds(
					"ASANA",
					input.userId,
					input.organizationId,
				);
				if (!asanaListCreds?.ASANA_ACCESS_TOKEN) {
					throw new Error(
						"Asana integration not configured. Please add your Asana API token in Settings > Integrations.",
					);
				}

				const asanaProjectId = (stepInputs?.projectId as string) || "";
				const includeCompleted =
					(stepInputs?.completed as boolean) || false;
				const asanaListStartTime = Date.now();

				if (!asanaProjectId) {
					throw new Error("Project ID is required");
				}

				const tasksUrl = `https://app.asana.com/api/1.0/projects/${asanaProjectId}/tasks?opt_fields=gid,name,completed,due_on,assignee&completed=${includeCompleted}`;
				const asanaListResp = await fetch(tasksUrl, {
					headers: {
						Authorization: `Bearer ${asanaListCreds.ASANA_ACCESS_TOKEN}`,
					},
				});

				if (!asanaListResp.ok) {
					const errText = await asanaListResp.text();
					throw new Error(
						`Asana API error ${asanaListResp.status}: ${errText}`,
					);
				}

				const asanaListData = (await asanaListResp.json()) as {
					data: Array<{
						gid: string;
						name: string;
						completed: boolean;
						due_on?: string;
					}>;
				};
				const tasks = asanaListData.data;

				result =
					tasks.length > 0
						? tasks
								.map(
									(t) =>
										`- ${t.completed ? "[x]" : "[ ]"} ${t.name}${t.due_on ? ` (due: ${t.due_on})` : ""}`,
								)
								.join("\n")
						: "No tasks found in this project.";

				toolCalls.push({
					id: `fabric-asana-list-${Date.now()}`,
					name: toolName,
					args: { projectId: asanaProjectId },
					result: { count: tasks.length },
					status: "success",
					durationMs: Date.now() - asanaListStartTime,
				});
				break;
			}

			case "fabric_attio_create_record": {
				const { fetchCredentialsByProvider: fetchAttioCreds } =
					await import("@repo/database");
				const attioCreateCreds = await fetchAttioCreds(
					"ATTIO",
					input.userId,
					input.organizationId,
				);
				if (!attioCreateCreds?.ATTIO_API_KEY) {
					throw new Error(
						"Attio integration not configured. Please add your Attio API key in Settings > Integrations.",
					);
				}

				const attioObjectType =
					(stepInputs?.objectType as string) || "people";
				const attioAttributes =
					(stepInputs?.attributes as Record<string, unknown>) || {};
				const attioCreateStartTime = Date.now();

				const attioCreateResp = await fetch(
					`https://api.attio.com/v2/objects/${attioObjectType}/records`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${attioCreateCreds.ATTIO_API_KEY}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							data: { values: attioAttributes },
						}),
					},
				);

				if (!attioCreateResp.ok) {
					const errText = await attioCreateResp.text();
					throw new Error(
						`Attio API error ${attioCreateResp.status}: ${errText}`,
					);
				}

				const attioCreateData = (await attioCreateResp.json()) as {
					data: { id: { record_id: string } };
				};
				const recordId = attioCreateData.data.id.record_id;

				result = `Attio ${attioObjectType} record created.\n- Record ID: ${recordId}`;
				toolCalls.push({
					id: `fabric-attio-create-${Date.now()}`,
					name: toolName,
					args: { objectType: attioObjectType },
					result: { recordId },
					status: "success",
					durationMs: Date.now() - attioCreateStartTime,
				});
				break;
			}

			case "fabric_attio_search_records": {
				const { fetchCredentialsByProvider: fetchAttioSearchCreds } =
					await import("@repo/database");
				const attioSearchCreds = await fetchAttioSearchCreds(
					"ATTIO",
					input.userId,
					input.organizationId,
				);
				if (!attioSearchCreds?.ATTIO_API_KEY) {
					throw new Error(
						"Attio integration not configured. Please add your Attio API key in Settings > Integrations.",
					);
				}

				const attioSearchObjectType =
					(stepInputs?.objectType as string) || "people";
				const attioSearchQuery = (stepInputs?.query as string) || "";
				const attioSearchLimit = (stepInputs?.limit as number) || 10;
				const attioSearchStartTime = Date.now();

				const attioSearchResp = await fetch(
					`https://api.attio.com/v2/objects/${attioSearchObjectType}/records/query`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${attioSearchCreds.ATTIO_API_KEY}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							limit: attioSearchLimit,
							filter: attioSearchQuery
								? { name: { $contains: attioSearchQuery } }
								: undefined,
						}),
					},
				);

				if (!attioSearchResp.ok) {
					const errText = await attioSearchResp.text();
					throw new Error(
						`Attio API error ${attioSearchResp.status}: ${errText}`,
					);
				}

				const attioSearchData = (await attioSearchResp.json()) as {
					data: Array<Record<string, unknown>>;
				};
				const attioRecords = attioSearchData.data;

				result =
					attioRecords.length > 0
						? `Found ${attioRecords.length} ${attioSearchObjectType} records:\n${JSON.stringify(attioRecords, null, 2).substring(0, 2000)}`
						: `No ${attioSearchObjectType} records found matching "${attioSearchQuery}".`;

				toolCalls.push({
					id: `fabric-attio-search-${Date.now()}`,
					name: toolName,
					args: {
						objectType: attioSearchObjectType,
						query: attioSearchQuery,
					},
					result: { count: attioRecords.length },
					status: "success",
					durationMs: Date.now() - attioSearchStartTime,
				});
				break;
			}

			case "fabric_front_create_conversation": {
				const { fetchCredentialsByProvider: fetchFrontCreds } =
					await import("@repo/database");
				const frontCreateCreds = await fetchFrontCreds(
					"FRONT",
					input.userId,
					input.organizationId,
				);
				if (!frontCreateCreds?.FRONT_API_KEY) {
					throw new Error(
						"Front integration not configured. Please add your Front API token in Settings > Integrations.",
					);
				}

				const frontSubject = (stepInputs?.subject as string) || "";
				const frontBody = (stepInputs?.body as string) || "";
				const frontTo = (stepInputs?.to as string[]) || [];
				const frontChannelId = (stepInputs?.channelId as string) || "";
				const frontCreateStartTime = Date.now();

				if (!frontSubject || !frontBody || frontTo.length === 0) {
					throw new Error(
						"subject, body, and to are required for Front",
					);
				}

				const frontCreateResp = await fetch(
					`https://api2.frontapp.com/channels/${frontChannelId || "default"}/messages`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${frontCreateCreds.FRONT_API_KEY}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							author_id: "alt:email:me",
							subject: frontSubject,
							body: frontBody,
							to: frontTo.map((email) => ({ handle: email })),
						}),
					},
				);

				if (!frontCreateResp.ok) {
					const errText = await frontCreateResp.text();
					throw new Error(
						`Front API error ${frontCreateResp.status}: ${errText}`,
					);
				}

				const frontCreateData = (await frontCreateResp.json()) as {
					id?: string;
					conversation_id?: string;
					_links?: { related?: { conversation?: string } };
				};
				const conversationId =
					frontCreateData.conversation_id ||
					frontCreateData.id ||
					"unknown";
				const conversationUrl =
					frontCreateData._links?.related?.conversation ||
					`https://app.frontapp.com/open/${conversationId}`;

				result = `Front conversation created: "${frontSubject}"\n- Conversation ID: ${conversationId}\n- URL: ${conversationUrl}`;
				toolCalls.push({
					id: `fabric-front-create-${Date.now()}`,
					name: toolName,
					args: {
						subject: frontSubject,
						recipientCount: frontTo.length,
					},
					result: { conversationId, conversationUrl },
					status: "success",
					durationMs: Date.now() - frontCreateStartTime,
				});
				break;
			}

			case "fabric_front_list_conversations": {
				const { fetchCredentialsByProvider: fetchFrontListCreds } =
					await import("@repo/database");
				const frontListCreds = await fetchFrontListCreds(
					"FRONT",
					input.userId,
					input.organizationId,
				);
				if (!frontListCreds?.FRONT_API_KEY) {
					throw new Error(
						"Front integration not configured. Please add your Front API token in Settings > Integrations.",
					);
				}

				const frontStatus = (stepInputs?.status as string) || "open";
				const frontLimit = (stepInputs?.limit as number) || 10;
				const frontInboxId = (stepInputs?.inboxId as string) || "";
				const frontListStartTime = Date.now();

				const frontListUrl = frontInboxId
					? `https://api2.frontapp.com/inboxes/${frontInboxId}/conversations?q[statuses][]=${frontStatus}&limit=${frontLimit}`
					: `https://api2.frontapp.com/conversations?q[statuses][]=${frontStatus}&limit=${frontLimit}`;

				const frontListResp = await fetch(frontListUrl, {
					headers: {
						Authorization: `Bearer ${frontListCreds.FRONT_API_KEY}`,
					},
				});

				if (!frontListResp.ok) {
					const errText = await frontListResp.text();
					throw new Error(
						`Front API error ${frontListResp.status}: ${errText}`,
					);
				}

				const frontListData = (await frontListResp.json()) as {
					_results?: Array<{
						id: string;
						subject?: string;
						status: string;
					}>;
				};
				const conversations = frontListData._results || [];

				result =
					conversations.length > 0
						? conversations
								.map(
									(c) =>
										`- [${c.status}] ${c.subject || "(no subject)"} (ID: ${c.id})`,
								)
								.join("\n")
						: "No conversations found.";

				toolCalls.push({
					id: `fabric-front-list-${Date.now()}`,
					name: toolName,
					args: { status: frontStatus, limit: frontLimit },
					result: { count: conversations.length },
					status: "success",
					durationMs: Date.now() - frontListStartTime,
				});
				break;
			}

			case "fabric_canva_list_designs": {
				const { fetchCredentialsByProvider: fetchCanvaCreds } =
					await import("@repo/database");
				const canvaCreds = await fetchCanvaCreds(
					"CANVA",
					input.userId,
					input.organizationId,
				);
				if (!canvaCreds?.CANVA_ACCESS_TOKEN) {
					throw new Error(
						"Canva integration not configured. Please add your Canva API token in Settings > Integrations.",
					);
				}

				const canvaStartTime = Date.now();
				const canvaResp = await fetch(
					"https://api.canva.com/rest/v1/designs?limit=20",
					{
						headers: {
							Authorization: `Bearer ${canvaCreds.CANVA_ACCESS_TOKEN}`,
						},
					},
				);

				if (!canvaResp.ok) {
					const errText = await canvaResp.text();
					throw new Error(
						`Canva API error ${canvaResp.status}: ${errText}`,
					);
				}

				const canvaData = (await canvaResp.json()) as {
					items: Array<{
						id: string;
						title: string;
						urls?: { view_url?: string };
					}>;
				};
				const designs = canvaData.items || [];

				result = `Found ${designs.length} Canva designs:\n${designs.map((d, i) => `${i + 1}. ${d.title} — ${d.urls?.view_url || d.id}`).join("\n")}`;
				toolCalls.push({
					id: `fabric-canva-list-${Date.now()}`,
					name: toolName,
					args: {},
					result: { designs, count: designs.length },
					status: "success",
					durationMs: Date.now() - canvaStartTime,
				});
				break;
			}

			default:
				throw new Error(`Unknown Fabric AI tool: ${toolName}`);
		}

		const durationMs = Date.now() - startTime;
		console.log(
			`[FabricAiHandler] Fabric AI tool completed in ${durationMs}ms`,
		);

		// Publish tool completion to PartyKit
		if (executionId && toolCalls.length > 0) {
			const lastToolCall = toolCalls[toolCalls.length - 1];
			// Map internal status to PartyKit status
			const mapStatusForComplete = (s: string): "complete" | "error" => {
				return s === "error" ? "error" : "complete";
			};
			const mapStatusForProgress = (
				s: string,
			): "pending" | "running" | "complete" | "error" => {
				if (s === "success") {
					return "complete";
				}
				if (s === "error") {
					return "error";
				}
				return "complete";
			};

			publishToolComplete(executionId, input.step.id, {
				id: lastToolCall.id,
				name: lastToolCall.name,
				result: lastToolCall.result,
				status: mapStatusForComplete(lastToolCall.status),
				durationMs: lastToolCall.durationMs,
				serverName: "Fabric AI",
			}).catch(() => {}); // Non-blocking

			// Publish step progress with completed tool
			publishStepProgress(executionId, {
				stepId: input.step.id,
				stepDescription: input.step.description,
				phase: "processing_results",
				toolCalls: toolCalls.map((tc) => ({
					id: tc.id,
					name: tc.name,
					args: tc.args,
					result: tc.result,
					status: mapStatusForProgress(tc.status),
					durationMs: tc.durationMs,
					serverName: "Fabric AI",
				})),
			}).catch(() => {}); // Non-blocking
		}

		return {
			outputs: {
				response: result,
				toolResults: toolCalls,
				fabricTool: toolName,
			},
			variables: {},
			toolCalls,
			response: result,
		};
	}

	private extractUrl(
		inputs: Record<string, unknown> | undefined,
		keys: string[],
	): string {
		if (!inputs) {
			return "";
		}
		for (const key of keys) {
			if (inputs[key] && typeof inputs[key] === "string") {
				return inputs[key] as string;
			}
		}
		return "";
	}
}
