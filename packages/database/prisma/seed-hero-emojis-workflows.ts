#!/usr/bin/env tsx

/**
 * Seed script to add hero emojis to existing workflows
 */

import { db } from "./client";

function suggestEmojisForWorkflow(
	name: string,
	description: string | null | undefined,
	triggerType: string | null | undefined,
): string[] {
	const nameLower = name.toLowerCase();
	const descLower = description?.toLowerCase() || "";

	// Trigger type based
	if (triggerType === "WEBHOOK") {
		return ["🔗", "📡", "⚡"];
	}
	if (triggerType === "SCHEDULE") {
		return ["⏰", "📅", "🔄"];
	}
	if (triggerType === "MANUAL") {
		return ["▶️", "🎯", "👆"];
	}

	// Keyword-based matching
	if (
		nameLower.includes("notification") ||
		nameLower.includes("alert") ||
		nameLower.includes("notify") ||
		descLower.includes("send")
	) {
		return ["🔔", "📢", "✉️"];
	}

	if (
		nameLower.includes("data") ||
		nameLower.includes("process") ||
		nameLower.includes("transform") ||
		descLower.includes("processing")
	) {
		return ["⚙️", "🔄", "📊"];
	}

	if (
		nameLower.includes("email") ||
		descLower.includes("email") ||
		descLower.includes("mail")
	) {
		return ["📧", "✉️", "📬"];
	}

	if (
		nameLower.includes("sync") ||
		nameLower.includes("integration") ||
		descLower.includes("integrate")
	) {
		return ["🔄", "🔗", "⚡"];
	}

	if (
		nameLower.includes("backup") ||
		nameLower.includes("archive") ||
		descLower.includes("backup")
	) {
		return ["💾", "📦", "🗄️"];
	}

	if (
		nameLower.includes("deploy") ||
		nameLower.includes("build") ||
		descLower.includes("deployment")
	) {
		return ["🚀", "📦", "⚙️"];
	}

	if (
		nameLower.includes("report") ||
		nameLower.includes("analytics") ||
		descLower.includes("report")
	) {
		return ["📊", "📈", "📉"];
	}

	if (
		nameLower.includes("payment") ||
		nameLower.includes("invoice") ||
		descLower.includes("billing")
	) {
		return ["💰", "💳", "📄"];
	}

	if (
		nameLower.includes("user") ||
		nameLower.includes("onboard") ||
		descLower.includes("registration")
	) {
		return ["👤", "🎓", "✅"];
	}

	if (
		nameLower.includes("api") ||
		descLower.includes("api") ||
		descLower.includes("webhook")
	) {
		return ["🔌", "📡", "⚡"];
	}

	if (
		nameLower.includes("ai") ||
		nameLower.includes("ml") ||
		descLower.includes("artificial")
	) {
		return ["🤖", "🧠", "✨"];
	}

	// Default workflow emojis
	return ["⚙️", "🔄", "⚡"];
}

async function main() {
	console.log("Starting workflow hero emoji seed...");

	const allWorkflows = await db.workflow.findMany({
		select: {
			id: true,
			name: true,
			description: true,
			triggerType: true,
			heroEmojis: true,
		},
	});

	const workflows = allWorkflows.filter(
		(workflow) => !workflow.heroEmojis || workflow.heroEmojis.length === 0,
	);

	console.log(`Found ${workflows.length} workflows without hero emojis`);

	if (workflows.length === 0) {
		console.log("All workflows already have hero emojis!");
		return;
	}

	for (const workflow of workflows) {
		const emojis = suggestEmojisForWorkflow(
			workflow.name,
			workflow.description,
			workflow.triggerType,
		);

		console.log(
			`Updating workflow "${workflow.name}" with emojis: ${emojis.join(" ")}`,
		);

		await db.workflow.update({
			where: { id: workflow.id },
			data: { heroEmojis: emojis },
		});
	}

	console.log(
		`✅ Successfully updated ${workflows.length} workflows with hero emojis`,
	);
}

main()
	.catch((e) => {
		console.error("Error seeding workflow hero emojis:", e);
		process.exit(1);
	})
	.finally(async () => {
		await db.$disconnect();
	});
