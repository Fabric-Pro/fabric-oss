#!/usr/bin/env tsx

/**
 * Seed script to add hero emojis to existing agents
 * Generates AI-suggested emojis based on agent name, description, and category
 */

import { db } from "./client";

/**
 * Suggest emojis based on agent characteristics
 * Returns exactly 3 emojis
 */
function suggestEmojisForAgent(
	name: string,
	description: string | null | undefined,
	framework: string | null | undefined,
): string[] {
	const nameLower = name.toLowerCase();
	const descLower = description?.toLowerCase() || "";

	// Name/description-based keyword matching (prioritize over framework for more variety)
	if (
		nameLower.includes("document") ||
		descLower.includes("document") ||
		descLower.includes("prd") ||
		descLower.includes("proposal")
	) {
		return ["📝", "📄", "✍️"];
	}

	if (
		nameLower.includes("code") ||
		nameLower.includes("developer") ||
		descLower.includes("code") ||
		descLower.includes("programming")
	) {
		return ["💻", "🛠️", "⚙️"];
	}

	if (
		nameLower.includes("test") ||
		nameLower.includes("qa") ||
		descLower.includes("testing") ||
		descLower.includes("quality")
	) {
		return ["🧪", "✅", "🔬"];
	}

	if (
		nameLower.includes("deploy") ||
		nameLower.includes("release") ||
		descLower.includes("deployment") ||
		descLower.includes("production")
	) {
		return ["🚀", "📦", "✨"];
	}

	if (
		nameLower.includes("plan") ||
		nameLower.includes("task") ||
		nameLower.includes("project") ||
		descLower.includes("planning")
	) {
		return ["📋", "🎯", "🗓️"];
	}

	if (
		nameLower.includes("data") ||
		nameLower.includes("analytics") ||
		descLower.includes("analysis") ||
		descLower.includes("metrics")
	) {
		return ["📊", "📈", "🔍"];
	}

	if (
		nameLower.includes("research") ||
		nameLower.includes("explore") ||
		descLower.includes("research") ||
		descLower.includes("investigation")
	) {
		return ["🔬", "📚", "🧪"];
	}

	if (
		nameLower.includes("chat") ||
		nameLower.includes("conversation") ||
		nameLower.includes("assistant") ||
		descLower.includes("chat")
	) {
		return ["💬", "🤖", "✨"];
	}

	if (
		nameLower.includes("workflow") ||
		nameLower.includes("automation") ||
		descLower.includes("automate") ||
		descLower.includes("workflow")
	) {
		return ["⚙️", "🤖", "⚡"];
	}

	if (
		nameLower.includes("api") ||
		nameLower.includes("integration") ||
		descLower.includes("api") ||
		descLower.includes("integrate")
	) {
		return ["🔌", "🌐", "📡"];
	}

	if (
		nameLower.includes("content") ||
		nameLower.includes("write") ||
		nameLower.includes("blog") ||
		descLower.includes("content")
	) {
		return ["✨", "🎨", "📝"];
	}

	if (
		nameLower.includes("security") ||
		nameLower.includes("auth") ||
		descLower.includes("security") ||
		descLower.includes("authentication")
	) {
		return ["🔒", "🛡️", "🔐"];
	}

	if (
		nameLower.includes("monitor") ||
		nameLower.includes("observability") ||
		descLower.includes("monitoring") ||
		descLower.includes("logs")
	) {
		return ["📊", "🔍", "📈"];
	}

	if (
		nameLower.includes("notification") ||
		nameLower.includes("alert") ||
		descLower.includes("notify") ||
		descLower.includes("alert")
	) {
		return ["🔔", "📢", "✉️"];
	}

	// Framework-based fallback emojis
	if (framework === "LANGGRAPH") {
		return ["🔗", "🤖", "⚡"];
	}
	if (framework === "CREWAI") {
		return ["👥", "🚀", "🎯"];
	}

	// Default AI/bot-related emojis
	return ["🤖", "✨", "💡"];
}

async function main() {
	console.log("Starting agent hero emoji seed...");

	// Fetch all agents
	const allAgents = await db.agent.findMany({
		select: {
			id: true,
			name: true,
			displayName: true,
			description: true,
			framework: true,
			heroEmojis: true,
		},
	});

	// Filter agents that don't have hero emojis
	const agents = allAgents.filter(
		(agent) => !agent.heroEmojis || agent.heroEmojis.length === 0,
	);

	console.log(`Found ${agents.length} agents without hero emojis`);

	if (agents.length === 0) {
		console.log("All agents already have hero emojis!");
		return;
	}

	// Update each agent with suggested emojis
	for (const agent of agents) {
		const emojis = suggestEmojisForAgent(
			agent.displayName,
			agent.description,
			agent.framework,
		);

		console.log(
			`Updating agent "${agent.displayName}" with emojis: ${emojis.join(" ")}`,
		);

		await db.agent.update({
			where: { id: agent.id },
			data: { heroEmojis: emojis },
		});
	}

	console.log(
		`✅ Successfully updated ${agents.length} agents with hero emojis`,
	);
}

main()
	.catch((e) => {
		console.error("Error seeding agent hero emojis:", e);
		process.exit(1);
	})
	.finally(async () => {
		await db.$disconnect();
	});
