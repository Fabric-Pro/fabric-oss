import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { Badge } from "@ui/components/badge";
import { BuildingIcon, FolderIcon, UserIcon } from "lucide-react";

/** "PROJECT" is an ORG binding narrowed to one project — a distinct tier in
 *  precedence (USER > PROJECT > ORG > SYSTEM), so it gets its own label. */
type PromptScope = "SYSTEM" | "ORG" | "PROJECT" | "USER";

const scopeConfig: Record<
	PromptScope,
	{
		label: string;
		icon: React.ComponentType<{ className?: string }> | null;
		color: string;
		useFabricLogo?: boolean;
	}
> = {
	SYSTEM: {
		label: "Fabric",
		icon: null,
		useFabricLogo: true,
		color: "bg-gradient-to-r from-orange-500/10 to-red-500/10 text-orange-700 dark:from-orange-500/20 dark:to-red-500/20 dark:text-orange-400 border-0",
	},
	ORG: {
		label: "Organization",
		icon: BuildingIcon,
		color: "bg-green-500/10 text-green-700 dark:bg-green-500/20 dark:text-green-400 border-0",
	},
	PROJECT: {
		label: "Project",
		icon: FolderIcon,
		color: "bg-teal-500/10 text-teal-700 dark:bg-teal-500/20 dark:text-teal-400 border-0",
	},
	USER: {
		label: "Personal",
		icon: UserIcon,
		color: "bg-blue-500/10 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400 border-0",
	},
};

type Props = {
	scope: PromptScope;
	showIcon?: boolean;
};

export function PromptScopeBadge({ scope, showIcon = true }: Props) {
	const config = scopeConfig[scope];
	const Icon = config.icon;

	return (
		<Badge className={config.color}>
			{showIcon && config.useFabricLogo && (
				<FabricLogo size={12} className="mr-1" />
			)}
			{showIcon && Icon && <Icon className="mr-1 size-3" />}
			{config.label}
		</Badge>
	);
}
