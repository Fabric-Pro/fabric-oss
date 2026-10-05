import { cn } from "@ui/lib";
import Image from "next/image";
import type { AgentTool } from "./lib/agent-tools";

/**
 * A tool's mark, decorative: its name is always written beside it. A
 * single-colour black mark is inverted on the dark theme, where it would
 * otherwise vanish into its chip.
 */
export function AgentLogo({
	agent,
	className,
}: {
	agent: AgentTool;
	className: string;
}) {
	if (agent.logo === null) {
		return null;
	}
	return (
		<Image
			alt=""
			className={cn(
				"object-contain",
				className,
				agent.invertOnDark && "dark:invert",
			)}
			height={32}
			src={agent.logo}
			width={32}
		/>
	);
}
