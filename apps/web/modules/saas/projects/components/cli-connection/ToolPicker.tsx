import { TabsList, TabsTrigger } from "@ui/components/tabs";
import { cn } from "@ui/lib";
import { PlugIcon } from "lucide-react";
import { AgentLogo } from "./AgentLogo";
import { AGENTS, type AgentTool } from "./lib/agent-tools";

const TOOL_PICKER_LABEL = "Choose your coding tool";

function ToolLogo({ agent }: { agent: AgentTool }) {
	return (
		<span
			className={cn(
				"flex size-8 items-center justify-center overflow-hidden rounded-lg",
				agent.chipped && "bg-muted",
			)}
		>
			{agent.logo === null ? (
				<PlugIcon
					aria-hidden="true"
					className="size-4.5 text-muted-foreground"
				/>
			) : (
				<AgentLogo agent={agent} className={agent.logoClassName} />
			)}
		</span>
	);
}

/**
 * The five tools as tiles. They are the tabs of the panel below, so the arrow
 * keys move between them and the selected one is announced, which a row of
 * buttons would not give. Five tiles do not fit a phone with their labels on
 * one line, so the labels wrap and the tiles shrink instead of the row
 * scrolling.
 */
export function ToolPicker() {
	return (
		<TabsList
			aria-label={TOOL_PICKER_LABEL}
			className="grid h-auto w-full grid-cols-5 items-stretch gap-1.5 border-b-0 sm:gap-2"
		>
			{AGENTS.map((agent) => (
				<TabsTrigger
					className="mb-0 h-auto flex-col justify-start gap-2 whitespace-normal rounded-lg border border-border bg-muted/30 px-1 pt-3.5 pb-3 text-center text-muted-foreground text-xs leading-tight hover:border-muted-foreground data-[state=active]:bg-background data-[state=active]:ring-1 data-[state=active]:ring-foreground focus-visible:data-[state=active]:ring-2 focus-visible:data-[state=active]:ring-ring sm:text-sm"
					key={agent.id}
					value={agent.id}
				>
					<ToolLogo agent={agent} />
					<span>{agent.label}</span>
				</TabsTrigger>
			))}
		</TabsList>
	);
}
