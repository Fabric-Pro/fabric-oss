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
		/** A Badge variant, so every scope reads in both themes from the
		 *  same tokens the rest of the app uses. The previous raw Tailwind
		 *  tints (orange on an orange gradient) fell below readable contrast
		 *  on the dark surface. */
		variant: "default" | "success" | "outline" | "info";
		useFabricLogo?: boolean;
	}
> = {
	SYSTEM: {
		label: "Fabric",
		icon: null,
		useFabricLogo: true,
		variant: "default",
	},
	ORG: {
		label: "Organization",
		icon: BuildingIcon,
		variant: "success",
	},
	PROJECT: {
		label: "Project",
		icon: FolderIcon,
		variant: "outline",
	},
	USER: {
		label: "Personal",
		icon: UserIcon,
		variant: "info",
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
		<Badge variant={config.variant}>
			{showIcon && config.useFabricLogo && (
				<FabricLogo size={12} className="mr-1" />
			)}
			{showIcon && Icon && <Icon className="mr-1 size-3" />}
			{config.label}
		</Badge>
	);
}
