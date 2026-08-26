#!/usr/bin/env tsx

/**
 * Seed script to add hero emojis to existing MCP servers
 */

import { db } from "./client";

function suggestEmojisForMCPServer(
	name: string,
	description: string | null | undefined,
	category: string | null | undefined,
	tags: string[],
): string[] {
	const nameLower = name.toLowerCase();
	const _descLower = description?.toLowerCase() || "";
	const categoryLower = category?.toLowerCase() || "";

	// Category-based matching
	if (
		categoryLower.includes("developer") ||
		categoryLower.includes("tools")
	) {
		return ["🛠️", "⚙️", "🔧"];
	}
	if (categoryLower.includes("data") || categoryLower.includes("database")) {
		return ["📊", "💾", "🗄️"];
	}
	if (
		categoryLower.includes("ai") ||
		categoryLower.includes("machine learning")
	) {
		return ["🤖", "🧠", "✨"];
	}
	if (
		categoryLower.includes("communication") ||
		categoryLower.includes("messaging")
	) {
		return ["💬", "📧", "📨"];
	}

	// Tag-based matching
	if (
		tags.includes("project-management") ||
		tags.includes("issue-tracking")
	) {
		return ["📋", "✅", "📝"];
	}
	if (tags.includes("version-control") || tags.includes("code-repository")) {
		return ["🔀", "📦", "🌲"];
	}
	if (tags.includes("kanban") || tags.includes("agile")) {
		return ["📊", "🎯", "⚡"];
	}

	// Keyword-based matching
	if (
		nameLower.includes("github") ||
		nameLower.includes("gitlab") ||
		nameLower.includes("git")
	) {
		return ["🐙", "🔀", "📦"];
	}
	if (
		nameLower.includes("slack") ||
		nameLower.includes("discord") ||
		nameLower.includes("teams")
	) {
		return ["💬", "👥", "📢"];
	}
	if (
		nameLower.includes("jira") ||
		nameLower.includes("linear") ||
		nameLower.includes("asana")
	) {
		return ["📋", "✅", "🎯"];
	}
	if (
		nameLower.includes("notion") ||
		nameLower.includes("confluence") ||
		nameLower.includes("docs")
	) {
		return ["📝", "📄", "📚"];
	}
	if (nameLower.includes("calendar") || nameLower.includes("schedule")) {
		return ["📅", "⏰", "🗓️"];
	}
	if (nameLower.includes("email") || nameLower.includes("mail")) {
		return ["📧", "✉️", "📬"];
	}
	if (
		nameLower.includes("api") ||
		nameLower.includes("rest") ||
		nameLower.includes("graphql")
	) {
		return ["🔌", "📡", "⚡"];
	}
	if (
		nameLower.includes("cloud") ||
		nameLower.includes("aws") ||
		nameLower.includes("azure")
	) {
		return ["☁️", "🌐", "💻"];
	}
	if (nameLower.includes("search") || nameLower.includes("index")) {
		return ["🔍", "📑", "🔎"];
	}
	if (
		nameLower.includes("analytics") ||
		nameLower.includes("metrics") ||
		nameLower.includes("monitoring")
	) {
		return ["📈", "📊", "📉"];
	}
	if (
		nameLower.includes("security") ||
		nameLower.includes("auth") ||
		nameLower.includes("vault")
	) {
		return ["🔒", "🛡️", "🔐"];
	}
	if (nameLower.includes("weather")) {
		return ["🌤️", "☁️", "🌦️"];
	}
	if (nameLower.includes("news") || nameLower.includes("feed")) {
		return ["📰", "📡", "📢"];
	}
	if (
		nameLower.includes("shopping") ||
		nameLower.includes("ecommerce") ||
		nameLower.includes("store")
	) {
		return ["🛒", "💳", "🏪"];
	}
	if (nameLower.includes("travel") || nameLower.includes("booking")) {
		return ["✈️", "🗺️", "🏨"];
	}
	if (
		nameLower.includes("payment") ||
		nameLower.includes("stripe") ||
		nameLower.includes("paypal")
	) {
		return ["💳", "💰", "💵"];
	}
	if (nameLower.includes("video") || nameLower.includes("streaming")) {
		return ["🎥", "📹", "🎬"];
	}
	if (
		nameLower.includes("music") ||
		nameLower.includes("audio") ||
		nameLower.includes("podcast")
	) {
		return ["🎵", "🎧", "🎙️"];
	}
	if (nameLower.includes("image") || nameLower.includes("photo")) {
		return ["🖼️", "📸", "🎨"];
	}
	if (
		nameLower.includes("file") ||
		nameLower.includes("storage") ||
		nameLower.includes("drive")
	) {
		return ["📁", "💾", "📂"];
	}
	if (nameLower.includes("automation") || nameLower.includes("workflow")) {
		return ["⚙️", "🔄", "⚡"];
	}

	// Default MCP Server emojis
	return ["🔌", "⚡", "🌐"];
}

async function main() {
	console.log("Starting MCP server hero emoji seed...");

	const allMCPServers = await db.mCPServer.findMany({
		select: {
			id: true,
			name: true,
			description: true,
			category: true,
			tags: true,
			heroEmojis: true,
		},
	});

	const mcpServers = allMCPServers.filter(
		(server) => !server.heroEmojis || server.heroEmojis.length === 0,
	);

	console.log(`Found ${mcpServers.length} MCP servers without hero emojis`);

	if (mcpServers.length === 0) {
		console.log("All MCP servers already have hero emojis!");
		return;
	}

	for (const server of mcpServers) {
		const emojis = suggestEmojisForMCPServer(
			server.name,
			server.description,
			server.category,
			server.tags,
		);

		console.log(
			`Updating MCP server "${server.name}" with emojis: ${emojis.join(" ")}`,
		);

		await db.mCPServer.update({
			where: { id: server.id },
			data: { heroEmojis: emojis },
		});
	}

	console.log(
		`✅ Successfully updated ${mcpServers.length} MCP servers with hero emojis`,
	);
}

main()
	.catch((e) => {
		console.error("Error seeding MCP server hero emojis:", e);
		process.exit(1);
	})
	.finally(async () => {
		await db.$disconnect();
	});
