"use client";

import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { LayoutGridIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
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
		<Tabs
			defaultValue={defaultTab}
			onValueChange={handleTabChange}
			className="w-full"
		>
			<TabsList className="mb-6">
				<TabsTrigger value="gallery" className="gap-2">
					<LayoutGridIcon className="h-4 w-4" />
					Template Gallery
				</TabsTrigger>
				<TabsTrigger value="agents" className="gap-2">
					<RobotIcon className="h-4 w-4" />
					My Agents
				</TabsTrigger>
			</TabsList>

			<TabsContent value="gallery" className="mt-0">
				<AgentTemplatesList
					organizationId={organizationId}
					basePath={basePath}
				/>
			</TabsContent>

			<TabsContent value="agents" className="mt-0">
				<div className="space-y-4">
					<div>
						<h2 className="text-xl font-semibold">My Agents</h2>
						<p className="text-muted-foreground text-sm">
							Your custom-configured agents ready to assist you
						</p>
					</div>
					<MyAgentsList
						organizationId={organizationId}
						basePath={basePath}
					/>
				</div>
			</TabsContent>
		</Tabs>
	);
}
