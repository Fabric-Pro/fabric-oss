"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { FileStackIcon, FileTextIcon } from "lucide-react";
import { ReportTemplatesList } from "./ReportTemplatesList";
import { TemplateInstancesList } from "./TemplateInstancesList";

type Props = {
	organizationId?: string;
	basePath?: string;
	defaultTab?: "templates" | "instances";
};

export function ReportTemplatesPageTabs({
	organizationId,
	basePath = "/app/report-templates",
	defaultTab = "templates",
}: Props) {
	return (
		<Tabs defaultValue={defaultTab} className="w-full">
			<TabsList
				data-onboarding-target="reports-hub-tabs"
				className="mb-6"
			>
				<TabsTrigger value="templates" className="gap-2">
					<FileTextIcon className="h-4 w-4" />
					Templates
				</TabsTrigger>
				<TabsTrigger value="instances" className="gap-2">
					<FileStackIcon className="h-4 w-4" />
					My Instances
				</TabsTrigger>
			</TabsList>

			<TabsContent value="templates" className="mt-0">
				<ReportTemplatesList
					organizationId={organizationId}
					basePath={basePath}
				/>
			</TabsContent>

			<TabsContent value="instances" className="mt-0">
				<div className="space-y-4">
					<div>
						<h2 className="text-xl font-semibold">
							My Report Instances
						</h2>
						<p className="text-muted-foreground text-sm">
							All your configured report templates in one place
						</p>
					</div>
					<TemplateInstancesList
						organizationId={organizationId}
						basePath={basePath}
						showTemplateColumn={true}
					/>
				</div>
			</TabsContent>
		</Tabs>
	);
}
