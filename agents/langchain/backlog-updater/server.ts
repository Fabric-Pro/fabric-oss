/**
 * LangGraph Server Entry Point for Backlog Updater Agent
 * This file is required by @langchain/langgraph-cli to run the agent as a server
 */

import { backlogUpdaterGraph } from "./agent.js";

export const graph = backlogUpdaterGraph;

export const graphMetadata = {
	name: "backlog_updater",
	description:
		"AI-powered backlog analysis and update from project context (Teams, meetings, Notion)",
	version: "1.0.0",
	capabilities: [
		"backlog-analysis",
		"context-fetching",
		"change-proposal",
		"pm-sync",
	],
};
