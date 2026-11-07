"use client";

import { DeliveryReportStarterPicker } from "@saas/reports/components/DeliveryReportStarterPicker";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { LayoutGridIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { AgentTemplatesHero } from "./AgentTemplatesHero";
import { AgentTemplatesList } from "./AgentTemplatesList";
import { MyAgentsList } from "./MyAgentsList";

type Props = {
	organizationId?: string;
	basePath?: string;
	defaultTab?: "gallery" | "agents";
};

export function AgentTemplatesPageTabs({
	organizationId,
	basePath = "/app/agent-templates",
	defaultTab = "gallery",
}: Props) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();

	const handleTabChange = useCallback(
		(value: string) => {
			const params = new URLSearchParams(searchParams.toString());
			if (value === "gallery") {
				params.delete("tab");
			} else {
				params.set("tab", value);
			}
			const qs = params.toString();
			router.replace(`${pathname}${qs ? `?${qs}` : ""}`, {
				scroll: false,
			});
		},
		[router, pathname, searchParams],
	);

	return (
		<div className="space-y-4">
			<AgentTemplatesHero />
			<Tabs
				defaultValue={defaultTab}
				onValueChange={handleTabChange}
				className="w-full"
			>
				<TabsList className="mb-4 w-full justify-start">
					<TabsTrigger value="gallery" className="gap-1.5">
						<LayoutGridIcon className="size-3.5" />
						Template Gallery
					</TabsTrigger>
					<TabsTrigger value="agents" className="gap-1.5">
						<RobotIcon className="size-3.5" />
						My Agents
					</TabsTrigger>
				</TabsList>

				<TabsContent value="gallery" className="mt-0">
					<DeliveryReportStarterPicker
						reportBasePath={`${basePath.replace(/\/agent-templates$/, "")}/report-templates`}
					/>
					<AgentTemplatesList
						organizationId={organizationId}
						basePath={basePath}
					/>
				</TabsContent>

				<TabsContent value="agents" className="mt-0">
					<div className="space-y-4">
						<MyAgentsList
							organizationId={organizationId}
							basePath={basePath}
						/>
					</div>
				</TabsContent>
			</Tabs>
		</div>
	);
}
