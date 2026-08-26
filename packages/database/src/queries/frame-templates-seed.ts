/**
 * Seed data for system frame templates
 * Run this to populate default templates available to all users
 */

import { db } from "../../prisma";

const systemTemplates = [
	{
		name: "Simple Dashboard",
		description:
			"A clean dashboard layout with metric cards and a chart section",
		category: "Dashboard",
		isSystem: true,
		variables: {
			title: {
				type: "text",
				label: "Dashboard Title",
				required: true,
				default: "My Dashboard",
				placeholder: "Enter dashboard title",
			},
			subtitle: {
				type: "text",
				label: "Subtitle",
				required: false,
				default: "Key metrics and insights",
				placeholder: "Enter subtitle",
			},
		},
		content: {
			title: "{{title}}",
			description: "{{subtitle}}",
			kind: "frame",
			blocks: [
				{
					id: "metrics-row",
					type: "row",
					blocks: [
						{
							id: "metric-1",
							type: "metric",
							title: "Total Users",
							value: "1,234",
							change: "+12%",
						},
						{
							id: "metric-2",
							type: "metric",
							title: "Revenue",
							value: "$45.2K",
							change: "+8%",
						},
						{
							id: "metric-3",
							type: "metric",
							title: "Active Sessions",
							value: "89",
							change: "+23%",
						},
					],
				},
				{
					id: "chart-section",
					type: "chart",
					chartType: "line",
					title: "Performance Over Time",
				},
			],
			theme: "light",
		},
	},
	{
		name: "Data Collection Form",
		description: "A multi-section form for collecting structured data",
		category: "Form",
		isSystem: true,
		variables: {
			formTitle: {
				type: "text",
				label: "Form Title",
				required: true,
				default: "Data Collection Form",
				placeholder: "Enter form title",
			},
			purpose: {
				type: "textarea",
				label: "Form Purpose",
				required: false,
				default: "Please fill out the information below",
				placeholder: "Describe what this form is for",
			},
		},
		content: {
			title: "{{formTitle}}",
			description: "{{purpose}}",
			kind: "frame",
			blocks: [
				{
					id: "personal-info",
					type: "section",
					title: "Personal Information",
					blocks: [
						{
							id: "name-field",
							type: "input",
							label: "Full Name",
							required: true,
						},
						{
							id: "email-field",
							type: "input",
							label: "Email Address",
							inputType: "email",
							required: true,
						},
					],
				},
				{
					id: "feedback-section",
					type: "section",
					title: "Feedback",
					blocks: [
						{
							id: "comments",
							type: "textarea",
							label: "Additional Comments",
							required: false,
						},
					],
				},
			],
			theme: "light",
		},
	},
	{
		name: "Slideshow Presentation",
		description: "A presentation template with multiple slides",
		category: "Presentation",
		isSystem: true,
		variables: {
			presentationTitle: {
				type: "text",
				label: "Presentation Title",
				required: true,
				default: "My Presentation",
				placeholder: "Enter presentation title",
			},
			author: {
				type: "text",
				label: "Author Name",
				required: false,
				default: "",
				placeholder: "Enter author name",
			},
		},
		content: {
			title: "{{presentationTitle}}",
			description: "A presentation by {{author}}",
			kind: "slideshow",
			blocks: [
				{
					id: "slide-1",
					type: "slide",
					title: "Introduction",
					content: "Welcome to {{presentationTitle}}",
				},
				{
					id: "slide-2",
					type: "slide",
					title: "Key Points",
					content: "• Point 1\n• Point 2\n• Point 3",
				},
				{
					id: "slide-3",
					type: "slide",
					title: "Conclusion",
					content: "Thank you for your attention!",
				},
			],
			theme: "dark",
		},
	},
	{
		name: "Report Layout",
		description: "A structured report with header, sections, and summary",
		category: "Layout",
		isSystem: true,
		variables: {
			reportTitle: {
				type: "text",
				label: "Report Title",
				required: true,
				default: "Quarterly Report",
				placeholder: "Enter report title",
			},
			reportDate: {
				type: "text",
				label: "Report Date",
				required: false,
				default: "",
				placeholder: "e.g., Q4 2024",
			},
		},
		content: {
			title: "{{reportTitle}}",
			description: "Report for {{reportDate}}",
			kind: "frame",
			blocks: [
				{
					id: "executive-summary",
					type: "section",
					title: "Executive Summary",
					blocks: [
						{
							id: "summary-text",
							type: "text",
							content:
								"This report provides an overview of key findings...",
						},
					],
				},
				{
					id: "findings-section",
					type: "section",
					title: "Key Findings",
					blocks: [
						{
							id: "findings-list",
							type: "list",
							items: ["Finding 1", "Finding 2", "Finding 3"],
						},
					],
				},
				{
					id: "recommendations",
					type: "section",
					title: "Recommendations",
					blocks: [
						{
							id: "recs-text",
							type: "text",
							content: "Based on the findings, we recommend...",
						},
					],
				},
			],
			theme: "light",
		},
	},
	{
		name: "Code Documentation",
		description:
			"A template for documenting code with syntax highlighting sections",
		category: "Code",
		isSystem: true,
		variables: {
			docTitle: {
				type: "text",
				label: "Documentation Title",
				required: true,
				default: "API Documentation",
				placeholder: "Enter documentation title",
			},
			language: {
				type: "text",
				label: "Programming Language",
				required: false,
				default: "typescript",
				placeholder: "e.g., typescript, python, javascript",
			},
		},
		content: {
			title: "{{docTitle}}",
			description: "Technical documentation and code examples",
			kind: "frame",
			blocks: [
				{
					id: "overview",
					type: "section",
					title: "Overview",
					blocks: [
						{
							id: "overview-text",
							type: "text",
							content:
								"This document describes the API and provides usage examples.",
						},
					],
				},
				{
					id: "example-section",
					type: "section",
					title: "Example Usage",
					blocks: [
						{
							id: "code-block",
							type: "code",
							language: "{{language}}",
							code: "// Example code\nfunction example() {\n  return 'Hello World';\n}",
						},
					],
				},
			],
			theme: "dark",
		},
	},
];

export async function seedFrameTemplates() {
	console.log("Seeding frame templates...");

	for (const template of systemTemplates) {
		const existing = await db.frameTemplate.findFirst({
			where: {
				name: template.name,
				isSystem: true,
			},
		});

		if (existing) {
			console.log(
				`Template "${template.name}" already exists, skipping...`,
			);
			continue;
		}

		await db.frameTemplate.create({
			data: {
				name: template.name,
				description: template.description,
				category: template.category,
				isSystem: template.isSystem,
				variables: template.variables,
				content: template.content,
			},
		});

		console.log(`Created template: ${template.name}`);
	}

	console.log("Frame templates seeding complete!");
}
