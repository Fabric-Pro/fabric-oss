/**
 * LangGraph Server Entry Point for Backlog Updater Agent
 * Graph exports for external LangGraph tooling.
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
