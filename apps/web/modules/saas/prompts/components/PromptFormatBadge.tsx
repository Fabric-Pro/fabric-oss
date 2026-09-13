import { Badge } from "@ui/components/badge";
import { BracesIcon, CodeIcon, FileTextIcon } from "lucide-react";

type PromptFormat =
	| "PLAIN_TEXT"
	| "MARKDOWN"
	| "HANDLEBARS"
	| "MUSTACHE"
	| "LIQUID"
	| "JINJA2";

/** The format is metadata, not a state, so every format wears the same
 *  neutral badge; the icon and label carry the difference. The raw Tailwind
 *  tints this used before were unreadable on the dark surface. */
const formatConfig: Record<
	PromptFormat,
	{
		label: string;
		icon: React.ComponentType<{ className?: string }>;
	}
> = {
	PLAIN_TEXT: {
		label: "Plain Text",
		icon: FileTextIcon,
	},
	MARKDOWN: {
		label: "Markdown",
		icon: FileTextIcon,
	},
	HANDLEBARS: {
		label: "Handlebars",
		icon: BracesIcon,
	},
	MUSTACHE: {
		label: "Mustache",
		icon: BracesIcon,
	},
	LIQUID: {
		label: "Liquid",
		icon: CodeIcon,
	},
	JINJA2: {
		label: "Jinja2",
		icon: CodeIcon,
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
		<Badge variant="info">
			{showIcon && <Icon className="mr-1 size-3" />}
			{config.label}
		</Badge>
	);
}
