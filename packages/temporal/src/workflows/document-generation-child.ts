/**
 * DocumentGenerationChildWorkflow
 *
 * Shared child workflow containing the core document generation logic.
 * This workflow is called by both:
 * - projectDocumentGenerationWorkflow (single document generation/regeneration)
 * - batchDocumentGenerationWorkflow (parallel document generation)
 *
 * Core steps:
 * 1. Retrieve project contexts from Qdrant (with reranking)
 * 2. Retrieve episodic memories (user-level)
 * 2.5. Check if Teams integration is available
 * 2.6. Fetch recent Teams messages (provides Teams context as RAG)
 * 2.7. Check if Slack integration is available
 * 2.8. Fetch recent Slack messages (provides Slack context as RAG)
 * 3. Generate document via unified LangGraph agent (with server-side Teams search tool)
 * 4. Save document to database
 * 5. Create document version
 * 6. Embed document for RAG
 */

import {
	ActivityFailure,
	ApplicationFailure,
	log,
	patched,
	proxyActivities,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";

// Configure activity retry policies for document generation
const {
	retrieveProjectContexts,
	retrieveAndFormatEpisodicMemory,
	generateDocumentWithAgent,
	saveProjectDocument,
	createDocumentVersion,
	embedProjectDocumentActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "15m",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
		// Retrieval, generation and embedding all resolve a provider first.
		// Without this a tenant that configured none pays five attempts and
		// close to four minutes of backoff PER activity to reach the verdict
		// the first millisecond already had.
		nonRetryableErrorTypes: [...AI_NON_RETRYABLE_ERROR_TYPES],
	},
});

// Short activities: Teams checks, Teams message fetching, and progress status updates
const {
	checkProjectHasTeamsIntegration,
	fetchRecentTeamsMessages,
	checkProjectHasSlackIntegration,
	fetchRecentSlackMessages,
	updateProjectDocumentStatus,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "30s",
	retry: {
		maximumAttempts: 3,
	},
});

// Best-effort decision pre-check: bounded, single-attempt, no heartbeat. The
// activity self-gates on the feature flag and swallows its own errors; the
// workflow call is additionally wrapped in try/catch so no failure mode can
// break document generation.
const { runDocumentDecisionPrecheckActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "2m",
	retry: {
		maximumAttempts: 1,
	},
});

/**
 * Input for the document generation child workflow
 */
export interface DocumentGenerationChildInput {
	projectId: string;
	documentId: string;
	documentType: string;
	userId: string;
	organizationId?: string;
	aiToken: string;
	prompt?: string;
	promptId?: string;
	/** Specific prompt version ID for attribution tracking */
	promptVersionId?: string;
	/** Current document content for regeneration context */
	currentDocument?: string;
	/** Pre-assembled context array — skips RAG, episodic memory, and Teams retrieval when provided */
	directContext?: string[];
	/**
	 * Source text the user supplied in the create flow, JOINED into the context
	 * array alongside everything else — never in place of it.
	 *
	 * Deliberately not carried on `directContext`, which replaces the array
	 * outright and skips retrieval, episodic memory, Teams, and Slack. Reusing
	 * that field would silently drop the retrieved project context this input
	 * exists to sit beside.
	 *
	 * Arrives already neutralized, bounded, and wrapped in the shared attachment
	 * envelope by the API (`supplied-context.ts`). This workflow adds no
	 * escaping of its own.
	 */
	suppliedContext?: string;
	/**
	 * The project context row created for this run, excluded from this run's
	 * retrieval so the same words do not reach the model twice — once directly
	 * via `suppliedContext` and once through the corpus.
	 */
	excludeContextId?: string;
}

/**
 * Output from the document generation child workflow
 */
export interface DocumentGenerationChildOutput {
	success: boolean;
	documentId: string;
	documentContent?: string;
	error?: string;
	metrics: {
		contextCount: number;
		episodeCount: number;
		integrationMessageCount: number;
		teamsSearchCount: number;
		documentLength: number;
		wordCount: number;
		durationMs: number;
	};
}

/** Non-fatal progress update — never throws, never blocks generation */
async function reportProgress(
	documentId: string,
	progress: number,
): Promise<void> {
	try {
		await updateProjectDocumentStatus({
			documentId,
			status: "GENERATING",
			progress,
		});
	} catch {
		// Non-fatal — progress reporting should never break generation
	}
}

/**
 * DocumentGenerationChildWorkflow
 *
 * Core document generation logic shared by single and batch workflows.
 * Returns success/failure with metrics - parent workflows handle status tracking.
 *
 * @param input - Document generation parameters
 * @returns Output with success status, content, and metrics
 */
export async function documentGenerationChildWorkflow(
	input: DocumentGenerationChildInput,
): Promise<DocumentGenerationChildOutput> {
	const {
		projectId,
		documentId,
		documentType,
		userId,
		organizationId,
		aiToken,
		prompt,
		promptId,
		promptVersionId,
		currentDocument,
		directContext,
		suppliedContext,
		excludeContextId,
	} = input;

	const startTime = Date.now();
	let contexts: string[] = [];
	let episodeCount = 0;
	const teamsSearchCount = 0;
	let hasTeamsIntegration = false;
	let hasSlackIntegration = false;

	log.info("Child workflow started: Document Generation", {
		projectId,
		documentId,
		documentType,
		hasCustomPrompt: !!promptId,
		hasCurrentDocument: !!currentDocument,
		isRegeneration: !!currentDocument,
		hasDirectContext: !!directContext,
		hasSuppliedContext: !!suppliedContext,
	});

	try {
		if (directContext && directContext.length > 0) {
			// Direct context path: skip RAG, episodic memory, and Teams retrieval
			// Used by code-based project setup where orchestrator response IS the context
			contexts = directContext;
			log.info(
				"Using direct context, skipping RAG/episodic/Teams retrieval",
				{
					contextCount: contexts.length,
					totalContextLength: contexts.reduce(
						(sum, c) => sum + c.length,
						0,
					),
				},
			);
			await reportProgress(documentId, 30);
		} else {
			// Step 1: Retrieve project contexts from Qdrant
			const contextStartTime = Date.now();
			log.info("Step 1: Retrieving project contexts", {
				projectId,
				documentType,
			});

			try {
				// Don't pass limit — let RAG settings' topK (default: 50) control retrieval count
				// The reranker then narrows to rerankTopK (default: 10) for best quality
				contexts = await retrieveProjectContexts({
					projectId,
					userId,
					organizationId,
					documentType,
					userCustomPrompt: prompt,
					// The context row created moments ago for THIS run is
					// delivered directly below, so it must not also come back
					// through similarity search. The filter has to reach the
					// query: this activity returns `string[]` with no
					// identifiers, so there is nothing here to post-filter on.
					excludeContextId,
				});

				const contextDuration = Date.now() - contextStartTime;
				const totalContextLength = contexts.reduce(
					(sum, c) => sum + c.length,
					0,
				);

				log.info("Step 1 complete: Project contexts retrieved", {
					contextCount: contexts.length,
					totalContextLength,
					durationMs: contextDuration,
				});

				await reportProgress(documentId, 15);
			} catch (contextError) {
				const rawMessage =
					contextError instanceof Error
						? contextError.message
						: "Unknown error";
				// The raw `.message` of an ActivityFailure is the generic
				// "Activity task failed"; the provider's own words live further
				// down the cause chain.
				const errorMessage = extractActivityError(contextError);

				// Configuration errors are fatal.
				//
				// `patched()` is REQUIRED — this WIDENS which failures take the
				// throw. A history recorded before this change carried on
				// without RAG after a provider refusal (the old test read the
				// wrapper's generic message and matched nothing), and replaying
				// it down the new branch would fail with a non-determinism
				// error. Old executions keep the old test; new ones get the one
				// that works.
				const fatal = patched("document-provider-refusal-fatal-v1")
					? isProviderNotConfiguredFailure(contextError)
					: rawMessage.includes("No AI provider configured") ||
						rawMessage.includes("Please configure");

				if (fatal) {
					log.error(
						"AI provider configuration error - cannot proceed",
						{
							error: errorMessage,
						},
					);
					throw contextError;
				}

				// Other errors (e.g., Qdrant unavailable) - continue without RAG
				log.warn(
					"Failed to retrieve contexts, continuing without RAG",
					{
						error: errorMessage,
					},
				);
			}

			// Step 2: Retrieve episodic memories (user-level)
			const episodicStartTime = Date.now();
			log.info("Step 2: Retrieving episodic memories", {
				projectId,
				documentType,
			});

			try {
				const episodicQuery = `${documentType} document: ${prompt || "project documentation"}`;

				const episodicResult = await retrieveAndFormatEpisodicMemory({
					projectId,
					userId,
					organizationId,
					query: episodicQuery,
					limit: 5,
				});

				if (episodicResult.episodeCount > 0) {
					episodeCount = episodicResult.episodeCount;
					contexts = [episodicResult.formattedContext, ...contexts];

					const episodicDuration = Date.now() - episodicStartTime;
					log.info("Step 2 complete: Episodic memories retrieved", {
						episodeCount,
						contextLength: episodicResult.formattedContext.length,
						durationMs: episodicDuration,
					});
				} else {
					log.info("Step 2: No episodic memories found", {
						durationMs: Date.now() - episodicStartTime,
					});
				}
			} catch (episodicError) {
				// Non-fatal - continue without episodic memories
				log.warn(
					"Failed to retrieve episodic memories, continuing without",
					{
						error:
							episodicError instanceof Error
								? episodicError.message
								: "Unknown error",
					},
				);
			}

			await reportProgress(documentId, 25);

			// Step 2.5: Check if Teams integration is available
			try {
				hasTeamsIntegration = await checkProjectHasTeamsIntegration({
					projectId,
				});
				log.info("Teams integration check", {
					projectId,
					hasTeamsIntegration,
				});
			} catch {
				// Non-fatal - assume no Teams integration
				hasTeamsIntegration = false;
			}

			// Step 2.7: Check if Slack integration is available
			try {
				hasSlackIntegration = await checkProjectHasSlackIntegration({
					projectId,
				});
				log.info("Slack integration check", {
					projectId,
					hasSlackIntegration,
				});
			} catch {
				// Non-fatal - assume no Slack integration
				hasSlackIntegration = false;
			}

			// Step 2.6: Fetch recent Teams messages if integration exists (Fix 2)
			// This provides Teams context to BOTH workflow paths (iterative and non-iterative)
			// Users with custom prompts finally get Teams messages in their context!
			if (hasTeamsIntegration) {
				try {
					const teamsStartTime = Date.now();
					log.info("Step 2.6: Fetching recent Teams messages", {
						projectId,
						userId,
					});

					const teamsResult = await fetchRecentTeamsMessages({
						projectId,
						userId,
						organizationId,
						limit: 10,
					});

					if (teamsResult.messageCount > 0) {
						// Prepend Teams messages to contexts so they're visible to the agent
						contexts = [
							...teamsResult.formattedContexts,
							...contexts,
						];

						log.info(
							"Step 2.6 complete: Teams messages added to context",
							{
								messageCount: teamsResult.messageCount,
								fetchedChats: teamsResult.fetchedChats,
								contextCount: contexts.length,
								durationMs: Date.now() - teamsStartTime,
							},
						);
					} else {
						log.info("Step 2.6: No recent Teams messages found", {
							fetchedChats: teamsResult.fetchedChats,
							errors: teamsResult.errors,
							durationMs: Date.now() - teamsStartTime,
						});
					}
				} catch (teamsError) {
					// Non-fatal - continue without Teams messages
					// The iterative path still has the search tool available
					log.warn(
						"Failed to fetch Teams messages, continuing without them",
						{
							error:
								teamsError instanceof Error
									? teamsError.message
									: "Unknown error",
						},
					);
				}
			}

			// Step 2.8: Fetch recent Slack messages if integration exists
			if (hasSlackIntegration) {
				try {
					const slackStartTime = Date.now();
					log.info("Step 2.8: Fetching recent Slack messages", {
						projectId,
						userId,
					});

					const slackResult = await fetchRecentSlackMessages({
						projectId,
						userId,
						organizationId,
						limit: 10,
					});

					if (slackResult.messageCount > 0) {
						contexts = [
							...slackResult.formattedContexts,
							...contexts,
						];

						log.info(
							"Step 2.8 complete: Slack messages added to context",
							{
								messageCount: slackResult.messageCount,
								fetchedChannels: slackResult.fetchedChannels,
								contextCount: contexts.length,
								durationMs: Date.now() - slackStartTime,
							},
						);
					} else {
						log.info("Step 2.8: No recent Slack messages found", {
							fetchedChannels: slackResult.fetchedChannels,
							errors: slackResult.errors,
							durationMs: Date.now() - slackStartTime,
						});
					}
				} catch (slackError) {
					log.warn(
						"Failed to fetch Slack messages, continuing without them",
						{
							error:
								slackError instanceof Error
									? slackError.message
									: "Unknown error",
						},
					);
				}
			}

			await reportProgress(documentId, 30);
		} // end of else (non-directContext path)

		// Supplied source content: JOIN, never assign.
		//
		// Placed here, after both branches converge, so it reaches the direct-
		// context path and the retrieval path alike — and prepended into the
		// same array the three existing additive producers use (episodic
		// memory, Teams, Slack) rather than replacing it. Assigning instead of
		// joining is the exact defect recorded in
		// docs/solutions/design-patterns/prompt-context-fan-in-must-join-not-assign.md:
		// invisible until two sources are present at once, which is precisely
		// what this feature creates by design.
		//
		// The text is already neutralized, bounded, and enveloped by the API
		// (`supplied-context.ts`) — nothing is escaped or truncated here, so
		// there is only one copy of those rules to keep correct.
		if (suppliedContext && suppliedContext.trim().length > 0) {
			contexts = [suppliedContext, ...contexts];

			log.info("Supplied source content joined into context", {
				documentId,
				suppliedLength: suppliedContext.length,
				contextCount: contexts.length,
				excludedFromRetrieval: !!excludeContextId,
			});
		}

		// Step 3: Generate document
		const generationStartTime = Date.now();
		log.info("🤖 Step 3: Generating document", {
			projectId,
			documentType,
			contextCount: contexts.length,
			hasEpisodicMemory: episodeCount > 0,
			hasSuppliedContext: !!suppliedContext,
			hasTeamsIntegration,
			isRegeneration: !!currentDocument,
		});

		let documentContent: string;

		// Unified path: Always use LangGraph agent
		// The agent now has server-side Teams search tool when hasTeamsIntegration is true
		// Template enforcement, custom prompts, and Teams search all work in one path
		log.info("📝 Generating document with unified LangGraph agent", {
			hasPromptId: !!promptId,
			hasTeamsIntegration,
			hasSlackIntegration,
			contextCount: contexts.length,
		});

		await reportProgress(documentId, 35);

		const generationResult = await generateDocumentWithAgent({
			projectId,
			documentId,
			documentType,
			prompt: prompt || "",
			contexts,
			userId,
			organizationId,
			aiToken,
			promptId,
			currentDocument,
			hasRagContexts: contexts.length > 0,
			hasTeamsIntegration,
			hasSlackIntegration,
		});
		documentContent = generationResult.content;

		// Prefer the resolved prompt version ID from the activity (which reflects the
		// actual prompt content used) over the client-supplied input ID, which may be
		// stale. Fall back to the input ID only for the custom-prompt path where no
		// resolution happens.
		const effectivePromptVersionId =
			generationResult.resolvedPromptVersionId ?? promptVersionId;

		const generationDuration = Date.now() - generationStartTime;
		const wordCount = documentContent.split(/\s+/).length;

		log.info("✅ Step 3 complete: Document generated", {
			contentLength: documentContent.length,
			wordCount,
			teamsSearchCount,
			durationMs: generationDuration,
		});

		await reportProgress(documentId, 80);

		// Step 4: Save document to database
		const saveStartTime = Date.now();
		log.info("💾 Step 4: Saving document to database", { documentId });

		await saveProjectDocument(documentId, documentContent, userId);

		log.info("✅ Step 4 complete: Document saved", {
			documentId,
			durationMs: Date.now() - saveStartTime,
		});

		// Step 4.5: Async decision pre-check (flag-gated INSIDE the activity).
		// `patched()` is REQUIRED — this adds a new activity call to the
		// workflow's command stream, so histories recorded before this change
		// would throw a non-determinism error on replay without the gate. The
		// activity self-gates on the feature flag and swallows all errors; the
		// try/catch here additionally guarantees that even a Temporal-level
		// activity failure (timeout, worker restart, retry exhaustion) can never
		// fail document generation.
		if (patched("document-decision-precheck-v1")) {
			try {
				await runDocumentDecisionPrecheckActivity({
					documentId,
					projectId,
					userId,
					organizationId,
				});
			} catch (precheckError) {
				log.warn("Decision pre-check activity failed; continuing", {
					documentId,
					error:
						precheckError instanceof Error
							? precheckError.message
							: "Unknown error",
				});
			}
		}

		// Step 5: Create document version
		const versionStartTime = Date.now();
		log.info("📝 Step 5: Creating document version", { documentId });

		try {
			await createDocumentVersion(
				documentId,
				documentContent,
				userId,
				effectivePromptVersionId,
			);
			log.info("✅ Step 5 complete: Version created", {
				documentId,
				durationMs: Date.now() - versionStartTime,
			});
		} catch (versionError) {
			// Non-fatal - document is already saved
			log.warn("Failed to create document version", {
				error:
					versionError instanceof Error
						? versionError.message
						: "Unknown error",
			});
		}

		// Step 6: Embed document for RAG (PRD/PROPOSAL only)
		const embedStartTime = Date.now();
		log.info("🔍 Step 6: Embedding document for RAG", {
			documentId,
			documentType,
		});

		try {
			const embedResult = await embedProjectDocumentActivity({
				documentId,
				userId,
				organizationId,
			});

			if (embedResult.success) {
				log.info("✅ Step 6 complete: Document embedded", {
					documentId,
					durationMs: Date.now() - embedStartTime,
				});
			} else {
				log.warn("Step 6: Document embedding skipped or failed", {
					documentId,
					error: embedResult.error,
					durationMs: Date.now() - embedStartTime,
				});
			}
		} catch (embedError) {
			// Non-fatal - document generation succeeded, embedding can be retried
			log.warn("Failed to embed document", {
				error:
					embedError instanceof Error
						? embedError.message
						: "Unknown error",
			});
		}

		const totalDuration = Date.now() - startTime;

		log.info("🎉 Child workflow completed successfully", {
			projectId,
			documentId,
			documentType,
			documentLength: documentContent.length,
			wordCount,
			teamsSearchCount,
			totalDurationMs: totalDuration,
		});

		return {
			success: true,
			documentId,
			documentContent,
			metrics: {
				contextCount: contexts.length,
				episodeCount,
				integrationMessageCount: 0, // Deprecated - use teamsSearchCount
				teamsSearchCount,
				documentLength: documentContent.length,
				wordCount,
				durationMs: totalDuration,
			},
		};
	} catch (error) {
		const totalDuration = Date.now() - startTime;
		const errorMessage = extractActivityError(error);

		log.error("❌ Child workflow failed", {
			projectId,
			documentId,
			documentType,
			error: errorMessage,
			totalDurationMs: totalDuration,
			...(error instanceof Error && { stack: error.stack }),
		});

		// Mark document as FAILED so it doesn't stay stuck in GENERATING
		try {
			await updateProjectDocumentStatus({
				documentId,
				status: "FAILED",
				progress: 0,
				error: errorMessage,
			});
		} catch {
			// Non-fatal — don't mask the original error
		}

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"DOCUMENT_GENERATION_CHILD_FAILED",
		);
	}
}

/**
 * Extract the actual error message from Temporal's wrapped errors.
 * Temporal wraps activity failures in ActivityFailure -> ApplicationFailure -> actual error.
 */
function extractActivityError(error: unknown): string {
	if (!error) {
		return "Unknown error";
	}
	if (error instanceof ActivityFailure && error.cause) {
		return extractActivityError(error.cause);
	}
	if (error instanceof ApplicationFailure) {
		if (error.cause) {
			const causeMsg = extractActivityError(error.cause);
			if (causeMsg && causeMsg !== "Unknown error") {
				return causeMsg;
			}
		}
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * Is this failure the "this tenant configured no provider" refusal?
 *
 * The branch that consults this decides whether a failed context retrieval is
 * fatal or merely means "generate without RAG", and it used to decide by
 * matching two substrings — `"No AI provider configured"` and
 * `"Please configure"`. `@repo/ai` throws FOUR distinct messages behind one
 * error class, and the embedding variant that context retrieval actually hits
 * ("No embedding provider configured. Please set an embedding provider in
 * Settings → AI Providers.") matches NEITHER. The workflow therefore treated a
 * deterministic configuration verdict as a transient RAG outage, carried on,
 * and failed at generation instead — after five more retried attempts.
 *
 * Match on the error's IDENTITY first: Temporal records the activity failure
 * type as the thrown class's name, so `AIProviderNotConfiguredError` survives
 * the ActivityFailure -> ApplicationFailure wrapping as `.type`. The message
 * test is kept only as a fallback for an error that reaches here unwrapped or
 * re-thrown as a plain `Error`, and it now covers every message the class
 * carries — both "No AI provider configured" and "No embedding provider
 * configured".
 */
const PROVIDER_NOT_CONFIGURED_ERROR_NAME = "AIProviderNotConfiguredError";

function isProviderNotConfiguredFailure(error: unknown): boolean {
	let current: unknown = error;
	let depth = 0;
	while (current != null && depth < 8) {
		if (
			current instanceof ApplicationFailure &&
			current.type === PROVIDER_NOT_CONFIGURED_ERROR_NAME
		) {
			return true;
		}
		if (
			current instanceof Error &&
			current.name === PROVIDER_NOT_CONFIGURED_ERROR_NAME
		) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
		depth += 1;
	}
	return /No (AI|embedding) provider configured/i.test(
		extractActivityError(error),
	);
}
