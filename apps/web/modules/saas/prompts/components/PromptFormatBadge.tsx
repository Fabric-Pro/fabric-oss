import { Badge } from "@ui/components/badge";
import { BracesIcon, CodeIcon, FileTextIcon } from "lucide-react";

type PromptFormat =
	| "PLAIN_TEXT"
	| "MARKDOWN"
	| "HANDLEBARS"
	| "MUSTACHE"
	| "LIQUID"
	| "JINJA2";

const formatConfig: Record<
	PromptFormat,
	{
		label: string;
		icon: React.ComponentType<{ className?: string }>;
		color: string;
	}
> = {
	PLAIN_TEXT: {
		label: "Plain Text",
		icon: FileTextIcon,
		color: "bg-gray-500/10 text-gray-700 dark:bg-gray-500/20 dark:text-gray-400 border-0",
	},
	MARKDOWN: {
		label: "Markdown",
		icon: FileTextIcon,
		color: "bg-blue-500/10 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400 border-0",
	},
	HANDLEBARS: {
		label: "Handlebars",
		icon: BracesIcon,
		color: "bg-orange-500/10 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400 border-0",
	},
	MUSTACHE: {
		label: "Mustache",
		icon: BracesIcon,
		color: "bg-yellow-500/10 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-400 border-0",
	},
	LIQUID: {
		label: "Liquid",
		icon: CodeIcon,
		color: "bg-cyan-500/10 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-400 border-0",
	},
	JINJA2: {
		label: "Jinja2",
		icon: CodeIcon,
		color: "bg-purple-500/10 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400 border-0",
	},
};

type Props = {
	format: PromptFormat;
	showIcon?: boolean;
};

export function PromptFormatBadge({ format, showIcon = true }: Props) {
	const config = formatConfig[format];
	const Icon = config.icon;

	return (
		<Badge className={config.color}>
			{showIcon && <Icon className="mr-1 size-3" />}
			{config.label}
		</Badge>
	);
}
