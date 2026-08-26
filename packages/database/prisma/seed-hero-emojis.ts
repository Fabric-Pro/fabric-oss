#!/usr/bin/env tsx

/**
 * Seed script to add hero emojis to existing prompts
 * Run with: pnpm --filter @fabric/database seed:hero-emojis
 */

import { db } from "./client";

// Emoji suggestion utility (inline to avoid dependency issues)
function suggestEmojisForPrompt(
	name: string,
	category: string | null | undefined,
	description?: string | null,
): string[] {
	const text = `${name} ${description || ""}`.toLowerCase();

	// Keyword-to-emoji mapping
	const keywordMap: Record<string, string[]> = {
		// Development & Code
		code: ["💻", "👨‍💻", "⌨️"],
		api: ["🔌", "🌐", "📡"],
		database: ["🗄️", "💾", "📊"],
		test: ["🧪", "✅", "🔬"],
		debug: ["🐛", "🔍", "🛠️"],
		deploy: ["🚀", "📦", "☁️"],
		build: ["🏗️", "⚙️", "🔨"],

		// Documentation
		document: ["📝", "📄", "📋"],
		spec: ["📖", "📚", "📓"],
		guide: ["🗺️", "📘", "🧭"],
		readme: ["📖", "📝", "ℹ️"],

		// Project Management
		plan: ["📋", "🗓️", "📅"],
		task: ["✅", "📌", "🎯"],
		story: ["📖", "📝", "✍️"],
		ticket: ["🎫", "📋", "✅"],
		milestone: ["🏁", "🎯", "⭐"],

		// Analysis & Research
		research: ["🔍", "📊", "🔬"],
		analyze: ["📈", "📊", "🔍"],
		report: ["📊", "📈", "📉"],
		metrics: ["📏", "📊", "📈"],

		// Quality & Review
		review: ["👀", "✅", "🔍"],
		quality: ["⭐", "✅", "🏆"],
		audit: ["🔍", "📋", "✅"],
		security: ["🔒", "🛡️", "🔐"],

		// AI & Automation
		ai: ["🤖", "🧠", "✨"],
		automate: ["⚙️", "🤖", "🔄"],
		workflow: ["🔄", "⚡", "🔗"],
		prompt: ["💬", "✨", "🎯"],

		// Communication
		email: ["📧", "✉️", "📬"],
		message: ["💬", "📨", "💌"],
		notification: ["🔔", "📢", "⚠️"],
		alert: ["⚠️", "🚨", "🔔"],

		// General
		create: ["✨", "🎨", "➕"],
		generate: ["⚡", "✨", "🔮"],
		improve: ["📈", "⬆️", "💎"],
		optimize: ["⚡", "🚀", "⬆️"],
	};

	// Find matching keywords
	const matchedEmojis: string[] = [];
	for (const [keyword, emojis] of Object.entries(keywordMap)) {
		if (text.includes(keyword) && matchedEmojis.length < 3) {
			matchedEmojis.push(...emojis.slice(0, 3 - matchedEmojis.length));
		}
	}

	// If we found enough emojis, return them
	if (matchedEmojis.length >= 3) {
		return matchedEmojis.slice(0, 3);
	}

	// Otherwise, use category defaults
	const categoryDefaults = getDefaultEmojisForCategory(category);
	const combined = [...matchedEmojis, ...categoryDefaults];

	return combined.slice(0, 3);
}

function getDefaultEmojisForCategory(
	category: string | null | undefined,
): string[] {
	const emojiSets: Record<string, string[]> = {
		Explore: ["🔬", "📚", "🧪"],
		Automate: ["⚙️", "🤖", "🔧"],
		Create: ["⚡", "🧱", "🚀"],
		Deploy: ["🚀", "✨", "📦"],
		Research: ["🔍", "📊", "📈"],
		Documentation: ["📝", "📖", "✍️"],
		Planning: ["📋", "🎯", "🗓️"],
		Quality: ["✅", "🔍", "⚡"],
		Onboarding: ["👋", "🎓", "🚪"],
		Development: ["💻", "🛠️", "⚙️"],
		Testing: ["🧪", "✅", "🔬"],
		Analytics: ["📊", "📈", "🔍"],
	};

	if (category && emojiSets[category]) {
		return emojiSets[category];
	}

	// Default emojis
	return ["✨", "🎯", "💡"];
}

async function main() {
	console.log("🎨 Starting to seed hero emojis for existing prompts...\n");

	try {
		// Get all prompts
		const allPrompts = await db.prompt.findMany({
			select: {
				id: true,
				name: true,
				description: true,
				category: true,
				heroEmojis: true,
			},
		});

		// Filter to only those without heroEmojis
		const prompts = allPrompts.filter(
			(p) => !p.heroEmojis || p.heroEmojis.length === 0,
		);

		console.log(
			`Found ${prompts.length} prompts to update (out of ${allPrompts.length} total)\n`,
		);

		if (prompts.length === 0) {
			console.log("✨ All prompts already have hero emojis!");
			return;
		}

		let updated = 0;
		for (const prompt of prompts) {
			const emojis = suggestEmojisForPrompt(
				prompt.name,
				prompt.category,
				prompt.description,
			);

			await db.prompt.update({
				where: { id: prompt.id },
				data: { heroEmojis: emojis },
			});

			updated++;
			console.log(
				`✅ [${updated}/${prompts.length}] "${prompt.name}" → ${emojis.join(" ")}`,
			);
		}

		console.log(`\n🎉 Successfully updated ${updated} prompts!`);
	} catch (error) {
		console.error("❌ Error seeding hero emojis:", error);
		process.exit(1);
	} finally {
		await db.$disconnect();
	}
}

main()
	.then(() => {
		console.log("\n✨ Seed completed successfully!");
		process.exit(0);
	})
	.catch((error) => {
		console.error("Failed to seed:", error);
		process.exit(1);
	});
