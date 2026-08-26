"use client";

import {
	BookOpenIcon,
	BotIcon,
	FilePlus2Icon,
	FileTextIcon,
	FolderSearchIcon,
	GlobeIcon,
	ImageIcon,
	LayoutIcon,
	LightbulbIcon,
	MegaphoneIcon,
	MicIcon,
	SearchIcon,
	SparklesIcon,
	WrenchIcon,
} from "lucide-react";
import type { ReactNode } from "react";

type BuiltInCapabilityId =
	| "agent-memory"
	| "create-files"
	| "create-frames"
	| "create-images"
	| "discover-knowledge"
	| "discover-tools"
	| "go-deep"
	| "mention-users"
	| "project-context"
	| "create-story"
	| "run-agent"
	| "speech-generator"
	| "web-search-browse";

export interface CapabilitySubTool {
	name: string;
	description: string;
	stake?: "high" | "medium" | "low" | "never";
}

export interface BuiltInCapabilityDefinition {
	id: BuiltInCapabilityId;
	name: string;
	description: string;
	type: "skill" | "tool";
	icon: (className?: string) => ReactNode;
	iconBgClassName: string;
	stake: "never" | "low" | "medium" | "high";
	subTools?: CapabilitySubTool[];
}

export const BUILT_IN_CAPABILITIES: BuiltInCapabilityDefinition[] = [
	{
		id: "go-deep",
		name: "Go Deep",
		description:
			"Run a deeper research-oriented execution with more planning, verification, and tool use.",
		type: "skill",
		icon: (className) => <SparklesIcon className={className} />,
		iconBgClassName: "bg-muted",
		stake: "never",
		subTools: [
			{
				name: "Deep Research",
				description:
					"Run comprehensive multi-step research with planning and verification.",
				stake: "never",
			},
			{
				name: "Multi-step Analysis",
				description:
					"Break complex problems into steps and verify each result.",
				stake: "never",
			},
		],
	},
	{
		id: "mention-users",
		name: "Mention Users",
		description:
			"Use connected Slack or Microsoft 365 accounts for team-facing notifications and follow-ups.",
		type: "skill",
		icon: (className) => <MegaphoneIcon className={className} />,
		iconBgClassName: "bg-muted",
		stake: "medium",
		subTools: [
			{
				name: "Mention in Slack",
				description: "Notify a user or channel in Slack.",
				stake: "medium",
			},
			{
				name: "Mention in Microsoft Teams",
				description: "Notify a user or team in Microsoft Teams.",
				stake: "medium",
			},
		],
	},
	{
		id: "create-frames",
		name: "Create Frames",
		description:
			"Give the agent first-class Fabric Frame and slideshow tools for creating, updating, listing, retrieving, and sharing visual outputs.",
		type: "skill",
		icon: (className) => <LayoutIcon className={className} />,
		iconBgClassName: "bg-blue-100 dark:bg-blue-950/50",
		stake: "low",
		subTools: [
			{
				name: "Create Frame",
				description:
					"Generate a first-class interactive frame from a prompt, dataset, or design brief.",
				stake: "never",
			},
			{
				name: "Update and Retrieve Frames",
				description:
					"Open existing frames, refine them, and reuse them across follow-up tasks.",
				stake: "never",
			},
			{
				name: "Share and Export",
				description:
					"Publish frames, create slideshows, and produce share-ready visual artifacts.",
				stake: "never",
			},
		],
	},
	{
		id: "discover-knowledge",
		name: "Discover Knowledge",
		description:
			"Search connected workspaces and documents to surface the right context at runtime.",
		type: "skill",
		icon: (className) => <BookOpenIcon className={className} />,
		iconBgClassName: "bg-primary/10",
		stake: "never",
		subTools: [
			{
				name: "Search Documents",
				description:
					"Full-text search across all connected documents and workspaces.",
				stake: "never",
			},
			{
				name: "Search Knowledge Base",
				description:
					"Semantic search across indexed knowledge sources.",
				stake: "never",
			},
		],
	},
	{
		id: "discover-tools",
		name: "Discover Tools",
		description:
			"Browse connected MCP tools and select the right one when a task needs an external action.",
		type: "skill",
		icon: (className) => <SearchIcon className={className} />,
		iconBgClassName: "bg-muted",
		stake: "never",
		subTools: [
			{
				name: "List Available Tools",
				description:
					"Browse all connected MCP tools and their capabilities.",
				stake: "never",
			},
			{
				name: "Select and Run Tool",
				description:
					"Dynamically select and invoke the most appropriate tool.",
				stake: "low",
			},
		],
	},
	{
		id: "project-context",
		name: "Project Context",
		description:
			"Search the bound project's documents, transcripts, code analysis, and contexts. Pairs with a project bound to the agent's chat or trigger.",
		type: "tool",
		icon: (className) => <FolderSearchIcon className={className} />,
		iconBgClassName: "bg-primary/10",
		stake: "never",
		subTools: [
			{
				name: "Project RAG Query",
				description:
					"Hybrid vector + keyword search across the project's uploaded documents, generated specs, meeting transcripts, code analysis, and synced integrations.",
				stake: "never",
			},
		],
	},
	{
		id: "create-story",
		name: "Create Feature/Bug",
		description:
			"Let the agent create features and bugs in the project bound by Project Context. New stories go through the same drafting prompt as the Add Feature button, so they look identical to manually-created ones.",
		type: "tool",
		icon: (className) => <FilePlus2Icon className={className} />,
		iconBgClassName: "bg-primary/10",
		stake: "medium",
		subTools: [
			{
				name: "Create Story",
				description:
					"Create a feature or bug in the bound project from a user request. The bound stage prompt drafts the title, description, and acceptance criteria.",
				stake: "medium",
			},
		],
	},
	{
		id: "agent-memory",
		name: "Agent Memory",
		description: "User-scoped long-term memory tools for agents.",
		type: "tool",
		icon: (className) => <LightbulbIcon className={className} />,
		iconBgClassName: "bg-yellow-100 dark:bg-yellow-950/50",
		stake: "low",
		subTools: [
			{
				name: "Save Memory",
				description:
					"Store a piece of information in the agent's long-term memory.",
				stake: "low",
			},
			{
				name: "Recall Memory",
				description:
					"Retrieve relevant memories based on the current context.",
				stake: "never",
			},
			{
				name: "Delete Memory",
				description: "Remove a stored memory entry by ID.",
				stake: "medium",
			},
		],
	},
	{
		id: "create-files",
		name: "Create Files",
		description:
			"Generate and convert documents, code, and structured data.",
		type: "tool",
		icon: (className) => <FileTextIcon className={className} />,
		iconBgClassName: "bg-muted",
		stake: "low",
		subTools: [
			{
				name: "Generate Document",
				description:
					"Create a document (Markdown, PDF, DOCX) from content.",
				stake: "never",
			},
			{
				name: "Generate Code File",
				description: "Write and export a code file in any language.",
				stake: "never",
			},
			{
				name: "Convert to Structured Data",
				description:
					"Transform text into JSON, CSV, or other structured formats.",
				stake: "never",
			},
		],
	},
	{
		id: "create-images",
		name: "Create Images",
		description:
			"Generate and edit images from text descriptions and references.",
		type: "tool",
		icon: (className) => <ImageIcon className={className} />,
		iconBgClassName: "bg-purple-100 dark:bg-purple-950/50",
		stake: "low",
		subTools: [
			{
				name: "Generate Image",
				description:
					"Generate an image from a text description or prompt.",
				stake: "never",
			},
			{
				name: "Edit Image",
				description:
					"Modify an existing image based on text instructions.",
				stake: "never",
			},
		],
	},
	{
		id: "run-agent",
		name: "Run Agent",
		description:
			"Run a child agent as a tool when a specialist should take over a subtask.",
		type: "tool",
		icon: (className) => <BotIcon className={className} />,
		iconBgClassName: "bg-muted",
		stake: "medium",
		subTools: [
			{
				name: "Delegate to Agent",
				description:
					"Hand off a subtask to a specialist agent and receive its output.",
				stake: "low",
			},
		],
	},
	{
		id: "speech-generator",
		name: "Speech Generator",
		description: "Turn written text into spoken audio or dialogue.",
		type: "tool",
		icon: (className) => <MicIcon className={className} />,
		iconBgClassName: "bg-orange-100 dark:bg-orange-950/50",
		stake: "low",
		subTools: [
			{
				name: "Text to Speech",
				description:
					"Convert written text into natural-sounding spoken audio.",
				stake: "never",
			},
			{
				name: "Generate Dialogue",
				description:
					"Generate multi-voice spoken dialogue from a script.",
				stake: "never",
			},
		],
	},
	{
		id: "web-search-browse",
		name: "Web Search Browse",
		description:
			"Search the web and retrieve information from specific websites in the same run.",
		type: "tool",
		icon: (className) => <GlobeIcon className={className} />,
		iconBgClassName: "bg-muted",
		stake: "never",
		subTools: [
			{
				name: "Web Search",
				description:
					"Search the web and return ranked results with snippets.",
				stake: "never",
			},
			{
				name: "Browse URL",
				description:
					"Fetch and read the content of a specific webpage.",
				stake: "never",
			},
			{
				name: "Scrape Page",
				description:
					"Extract structured data from a webpage using CSS selectors.",
				stake: "never",
			},
		],
	},
];

const BUILT_IN_CAPABILITIES_BY_ID = new Map(
	BUILT_IN_CAPABILITIES.map((capability) => [capability.id, capability]),
);

export function getBuiltInCapability(id: string) {
	return BUILT_IN_CAPABILITIES_BY_ID.get(id as BuiltInCapabilityId);
}

export function getBuiltInCapabilitiesByType(type: "skill" | "tool") {
	return BUILT_IN_CAPABILITIES.filter(
		(capability) => capability.type === type,
	);
}

interface AgentSelectionSummary {
	capabilityIds: string[];
	skillIds: string[];
	skillDetails: SkillDetail[];
}

type SkillDetail = {
	id: string;
	name: string;
	description?: string | null;
};

function coerceSkillDetail(value: unknown): SkillDetail | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string") {
		return null;
	}

	return {
		id: raw.id,
		name: typeof raw.name === "string" ? raw.name : raw.id,
		description:
			typeof raw.description === "string" ? raw.description : null,
	};
}

export function getAgentSelectionSummary(agent?: {
	config?: Record<string, unknown> | null;
	metadata?: Record<string, unknown> | null;
}) {
	const config =
		agent?.config && typeof agent.config === "object" ? agent.config : {};
	const metadata =
		agent?.metadata && typeof agent.metadata === "object"
			? agent.metadata
			: {};

	const configCapabilityIds = Array.isArray(config.capabilityIds)
		? config.capabilityIds.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	const metadataCapabilityIds =
		Array.isArray(metadata.selectedCapabilities) &&
		metadata.selectedCapabilities.every(
			(value) =>
				typeof value === "object" &&
				value !== null &&
				"id" in value &&
				typeof value.id === "string",
		)
			? metadata.selectedCapabilities.map((value: any) => value.id)
			: [];
	const capabilityIds = Array.from(
		new Set([...configCapabilityIds, ...metadataCapabilityIds]),
	);

	const configSkillIds = Array.isArray(config.skillIds)
		? config.skillIds.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	const configSkillDetails =
		Array.isArray(config.skills) &&
		config.skills.every(
			(value) => typeof value === "object" && value !== null,
		)
			? config.skills
					.map(coerceSkillDetail)
					.filter((value): value is SkillDetail => value !== null)
			: [];
	const metadataSkillDetails =
		Array.isArray(metadata.selectedSkills) &&
		metadata.selectedSkills.every(
			(value) => typeof value === "object" && value !== null,
		)
			? metadata.selectedSkills
					.map(coerceSkillDetail)
					.filter((value): value is SkillDetail => value !== null)
			: [];
	const skillDetails = Array.from(
		new Map(
			[...configSkillDetails, ...metadataSkillDetails].map((skill) => [
				skill.id,
				skill,
			]),
		).values(),
	);
	const skillIds = Array.from(
		new Set([...configSkillIds, ...skillDetails.map((skill) => skill.id)]),
	);

	return {
		capabilityIds,
		skillIds,
		skillDetails,
	} satisfies AgentSelectionSummary;
}

export function getCapabilityIcon(
	id: string,
	className = "size-4 text-foreground",
) {
	const capability = getBuiltInCapability(id);
	return capability?.icon(className) ?? <WrenchIcon className={className} />;
}
