/**
 * Backlog Updater Agent
 *
 * LangGraph agent for analyzing project context and proposing backlog updates.
 *
 * Architecture:
 * - Single chat_node graph (like document-generator)
 * - All interactive tools are CopilotKit frontend actions (useCopilotAction)
 * - System prompt dynamically adapts based on available integrations
 * - Temporal workflows handle durable operations (context fetching, LLM analysis, change application)
 *
 * @module backlog-updater
 */

import { END, START, StateGraph } from "@langchain/langgraph";

import { BacklogUpdaterStateAnnotation } from "./state";

import { chatNode } from "./nodes/chat-node";

// ============================================================================
// Graph Definition
// ============================================================================

const workflow = new StateGraph(BacklogUpdaterStateAnnotation);

workflow.addNode("chat_node", chatNode);

workflow.addEdge(START, "chat_node" as typeof START);
workflow.addEdge("chat_node" as typeof START, END);

export const backlogUpdaterGraph = workflow.compile();
// ============================================================================
// Exports
// ============================================================================
