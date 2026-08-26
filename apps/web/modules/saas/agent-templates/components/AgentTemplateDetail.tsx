"use client";

import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { CreateAgentPage } from "./CreateAgentPage";

type Props = {
	slug: string;
	organizationId?: string;
	basePath?: string;
};

export function AgentTemplateDetail({
	slug,
	organizationId: _organizationId,
	basePath = "/app/agent-templates",
}: Props) {
	const { data, isLoading, error } = useQuery(
		orpc.agentTemplates.templates.get.queryOptions({
			input: { slugOrId: slug },
		}),
	);

	if (isLoading) {
		return (
			<div className="flex justify-center py-12">
				<Spinner className="h-8 w-8" />
			</div>
		);
	}

	if (error || !data?.template) {
		return (
			<div className="text-center py-12">
				<p className="text-muted-foreground mb-4">Template not found</p>
				<Button asChild variant="outline">
					<Link href={basePath}>
						<ArrowLeftIcon className="mr-2 h-4 w-4" />
						Back to Gallery
					</Link>
				</Button>
			</div>
		);
	}

	const template = data.template;

	return (
		<CreateAgentPage
			template={template}
			organizationId={_organizationId}
			basePath={basePath}
		/>
	);
}
