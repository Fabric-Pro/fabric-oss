/**
 * How a step looks wherever the editor shows it — the canvas card, the
 * inspector's step list and header, the "Add step" palette: its icon, its
 * tint and a one-line description of what kind of step it is.
 *
 * Tints reuse the app's category tokens (`--atlas-cat-*`, defined for light
 * and dark), so a step reads the same in either theme. The class strings are
 * written out in full because Tailwind only generates classes it can find
 * as literals in the source.
 */

import {
	BellIcon,
	CircleDotIcon,
	CompassIcon,
	FileTextIcon,
	GitBranchIcon,
	GlobeIcon,
	ImageIcon,
	MailIcon,
	MessageSquareIcon,
	PlayIcon,
	SearchIcon,
	SendIcon,
	SparklesIcon,
	TicketPlusIcon,
	VideoIcon,
	WrenchIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import { getNodeDefinition } from "./node-definitions";
import { getIntegrationByNodeType } from "./plugins/registry";

type NodeIcon = ComponentType<{ className?: string }>;

/** Icons a node definition names; plugins bring their own brand icon. */
const ICONS_BY_NAME: Record<string, NodeIcon> = {
	Play: PlayIcon,
	Sparkles: SparklesIcon,
	Image: ImageIcon,
	Video: VideoIcon,
	Globe: GlobeIcon,
	Search: SearchIcon,
	Send: SendIcon,
	GitBranch: GitBranchIcon,
	TicketPlus: TicketPlusIcon,
	Mail: MailIcon,
	MessageSquare: MessageSquareIcon,
	Wrench: WrenchIcon,
	Bell: BellIcon,
	CircleDot: CircleDotIcon,
	FileText: FileTextIcon,
	Compass: CompassIcon,
};

type NodeTint = "trigger" | "ai" | "web" | "logic" | "integration" | "notify";

const TILE_CLASSES: Record<NodeTint, string> = {
	trigger:
		"bg-[color-mix(in_srgb,var(--atlas-cat-integration)_16%,transparent)] text-[var(--atlas-cat-integration)]",
	ai: "bg-[color-mix(in_srgb,var(--atlas-cat-infra)_16%,transparent)] text-[var(--atlas-cat-infra)]",
	web: "bg-[color-mix(in_srgb,var(--atlas-cat-ops)_16%,transparent)] text-[var(--atlas-cat-ops)]",
	logic: "bg-[color-mix(in_srgb,var(--atlas-cat-security)_16%,transparent)] text-[var(--atlas-cat-security)]",
	integration:
		"bg-[color-mix(in_srgb,var(--atlas-cat-ai)_16%,transparent)] text-[var(--atlas-cat-ai)]",
	notify: "bg-[color-mix(in_srgb,var(--atlas-cat-data)_16%,transparent)] text-[var(--atlas-cat-data)]",
};

const ICON_CLASSES: Record<NodeTint, string> = {
	trigger: "text-[var(--atlas-cat-integration)]",
	ai: "text-[var(--atlas-cat-infra)]",
	web: "text-[var(--atlas-cat-ops)]",
	logic: "text-[var(--atlas-cat-security)]",
	integration: "text-[var(--atlas-cat-ai)]",
	notify: "text-[var(--atlas-cat-data)]",
};

function tintFor(type: string, category: string | undefined): NodeTint {
	if (type === "trigger") {
		return "trigger";
	}
	if (type === "condition") {
		return "logic";
	}
	if (category === "AI" || type.startsWith("ai-") || type === "agent-task") {
		return "ai";
	}
	if (category === "Web" || type.startsWith("firecrawl-")) {
		return "web";
	}
	if (
		category === "Communication" ||
		type.startsWith("email-") ||
		type.startsWith("slack-")
	) {
		return "notify";
	}
	return "integration";
}

const TRIGGER_TYPE_LABELS: Record<string, string> = {
	manual: "Manual",
	schedule: "Schedule",
	webhook: "Webhook",
	event: "Event",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** "Manual", "Schedule", … for a trigger node's data. */
export function triggerTypeLabel(data: Record<string, unknown> | undefined) {
	const config = data?.config;
	const triggerType =
		isRecord(config) && typeof config.triggerType === "string"
			? config.triggerType
			: "manual";
	return TRIGGER_TYPE_LABELS[triggerType] ?? triggerType;
}

/** A step's display label; node data from the canvas is loosely typed. */
export function stepLabel(data: Record<string, unknown>): string {
	return typeof data.label === "string" && data.label
		? data.label
		: "Untitled";
}

export interface NodeAppearance {
	Icon: NodeIcon;
	/** Tinted square behind the icon. */
	tileClass: string;
	/** The tint alone, for a bare icon. */
	iconClass: string;
	/** What kind of step this is, e.g. "Trigger · Schedule", "Slack · Send Message". */
	kind: string;
}

export function getNodeAppearance(
	type: string,
	data?: Record<string, unknown>,
): NodeAppearance {
	const definition = getNodeDefinition(type);
	const plugin = getIntegrationByNodeType(type);
	const tint = tintFor(type, definition?.category);
	const Icon =
		plugin?.icon ??
		(definition ? ICONS_BY_NAME[definition.icon] : undefined) ??
		WrenchIcon;

	const source = plugin?.label ?? definition?.category;
	const action = definition?.label ?? type;
	const kind =
		type === "trigger"
			? `Trigger · ${triggerTypeLabel(data)}`
			: source
				? `${source} · ${action}`
				: action;

	return {
		Icon,
		tileClass: TILE_CLASSES[tint],
		iconClass: ICON_CLASSES[tint],
		kind,
	};
}
