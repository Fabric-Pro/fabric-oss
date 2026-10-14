"use client";

import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { ChevronRightIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

/**
 * Settings whose defaults suit almost every organization, folded away until
 * someone asks for them (Fizzy #2770).
 */
export function AdvancedSettings({
	children,
	testId,
}: {
	children: ReactNode;
	testId: string;
}) {
	const t = useTranslations("settings.chatgptPlanPool");
	return (
		<Collapsible data-testid={testId}>
			<CollapsibleTrigger className="group flex items-center gap-1 text-muted-foreground text-sm transition-colors hover:text-foreground">
				<ChevronRightIcon
					aria-hidden="true"
					className="size-4 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
				/>
				{t("advanced")}
			</CollapsibleTrigger>
			<CollapsibleContent className="space-y-3 pt-3">
				{children}
			</CollapsibleContent>
		</Collapsible>
	);
}
