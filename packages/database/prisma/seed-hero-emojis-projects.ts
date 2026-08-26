#!/usr/bin/env tsx

/**
 * Seed script to add hero emojis to existing projects
 */

import { db } from "./client";

function suggestEmojisForProject(
	name: string,
	description: string | null | undefined,
	status: string | null | undefined,
): string[] {
	const nameLower = name.toLowerCase();
	const descLower = description?.toLowerCase() || "";

	// Keyword-based matching
	if (
		nameLower.includes("mobile") ||
		nameLower.includes("app") ||
		descLower.includes("mobile") ||
		descLower.includes("ios") ||
		descLower.includes("android")
	) {
		return ["📱", "🚀", "✨"];
	}

	if (
		nameLower.includes("web") ||
		nameLower.includes("website") ||
		descLower.includes("frontend") ||
		descLower.includes("ui")
	) {
		return ["🌐", "💻", "🎨"];
	}

	if (
		nameLower.includes("api") ||
		nameLower.includes("backend") ||
		descLower.includes("server") ||
		descLower.includes("api")
	) {
		return ["🔌", "⚡", "🛠️"];
	}

	if (
		nameLower.includes("ai") ||
		nameLower.includes("ml") ||
		nameLower.includes("machine learning") ||
		descLower.includes("artificial intelligence")
	) {
		return ["🤖", "🧠", "✨"];
	}

	if (
		nameLower.includes("data") ||
		nameLower.includes("analytics") ||
		descLower.includes("dashboard") ||
		descLower.includes("metrics")
	) {
		return ["📊", "📈", "🔍"];
	}

	if (
		nameLower.includes("ecommerce") ||
		nameLower.includes("shop") ||
		nameLower.includes("store") ||
		descLower.includes("commerce")
	) {
		return ["🛒", "💳", "📦"];
	}

	if (
		nameLower.includes("chat") ||
		nameLower.includes("messaging") ||
		descLower.includes("communication")
	) {
		return ["💬", "📱", "✉️"];
	}

	if (
		nameLower.includes("game") ||
		nameLower.includes("gaming") ||
		descLower.includes("game")
	) {
		return ["🎮", "🕹️", "🎯"];
	}

	if (
		nameLower.includes("education") ||
		nameLower.includes("learning") ||
		descLower.includes("course") ||
		descLower.includes("training")
	) {
		return ["📚", "🎓", "✏️"];
	}

	if (
		nameLower.includes("health") ||
		nameLower.includes("medical") ||
		descLower.includes("healthcare")
	) {
		return ["🏥", "💊", "❤️"];
	}

	if (
		nameLower.includes("social") ||
		nameLower.includes("community") ||
		descLower.includes("network")
	) {
		return ["👥", "🌍", "💬"];
	}

	if (
		nameLower.includes("finance") ||
		nameLower.includes("banking") ||
		nameLower.includes("payment") ||
		descLower.includes("financial")
	) {
		return ["💰", "💳", "📊"];
	}

	// Status-based defaults
	if (status === "ACTIVE") {
		return ["🚀", "⚡", "💪"];
	}
	if (status === "COMPLETED") {
		return ["✅", "🎉", "🏆"];
	}
	if (status === "ARCHIVED") {
		return ["📦", "🗄️", "✅"];
	}

	// Default project emojis
	return ["🏗️", "⚙️", "🔨"];
}

async function main() {
	console.log("Starting project hero emoji seed...");

	const allProjects = await db.project.findMany({
		select: {
			id: true,
			name: true,
			description: true,
			status: true,
			heroEmojis: true,
		},
	});

	const projects = allProjects.filter(
		(project) => !project.heroEmojis || project.heroEmojis.length === 0,
	);

	console.log(`Found ${projects.length} projects without hero emojis`);

	if (projects.length === 0) {
		console.log("All projects already have hero emojis!");
		return;
	}

	for (const project of projects) {
		const emojis = suggestEmojisForProject(
			project.name,
			project.description,
			project.status,
		);

		console.log(
			`Updating project "${project.name}" with emojis: ${emojis.join(" ")}`,
		);

		await db.project.update({
			where: { id: project.id },
			data: { heroEmojis: emojis },
		});
	}

	console.log(
		`✅ Successfully updated ${projects.length} projects with hero emojis`,
	);
}

main()
	.catch((e) => {
		console.error("Error seeding project hero emojis:", e);
		process.exit(1);
	})
	.finally(async () => {
		await db.$disconnect();
	});
