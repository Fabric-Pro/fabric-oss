import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import {
	BarChart3Icon,
	BookOpenIcon,
	BriefcaseIcon,
	CodeIcon,
	HeadphonesIcon,
	MegaphoneIcon,
	RocketIcon,
	ScaleIcon,
	SettingsIcon,
	SparklesIcon,
	WalletIcon,
	ZapIcon,
} from "lucide-react";

const categoryIcons: Record<
	string,
	{ icon: React.ElementType; gradient: string }
> = {
	DATA: { icon: BarChart3Icon, gradient: "from-blue-500 to-blue-600" },
	DESIGN: { icon: SparklesIcon, gradient: "from-purple-500 to-purple-600" },
	ENGINEERING: { icon: CodeIcon, gradient: "from-green-500 to-green-600" },
	SALES: { icon: BriefcaseIcon, gradient: "from-amber-500 to-amber-600" },
	SUPPORT: {
		icon: HeadphonesIcon,
		gradient: "from-purple-500 to-purple-600",
	},
	MARKETING: { icon: MegaphoneIcon, gradient: "from-pink-500 to-pink-600" },
	PRODUCT: { icon: RocketIcon, gradient: "from-cyan-500 to-cyan-600" },
	KNOWLEDGE: {
		icon: BookOpenIcon,
		gradient: "from-indigo-500 to-indigo-600",
	},
	PRODUCTIVITY: { icon: ZapIcon, gradient: "from-yellow-500 to-yellow-600" },
	FINANCE: { icon: WalletIcon, gradient: "from-emerald-500 to-emerald-600" },
	LEGAL: { icon: ScaleIcon, gradient: "from-slate-500 to-slate-600" },
	OPERATIONS: {
		icon: SettingsIcon,
		gradient: "from-orange-500 to-orange-600",
	},
	GENERAL: { icon: RobotIcon, gradient: "from-slate-500 to-slate-600" },
};

export function getCategoryIcon(category: string | null | undefined) {
	return categoryIcons[category || "GENERAL"] || categoryIcons.GENERAL;
}
