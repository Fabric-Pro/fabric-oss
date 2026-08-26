"use client";

/**
 * Wrapper component that fetches a template and renders the CreateAgentPage
 */

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

export function CreateAgentFromTemplate({
	slug,
	organizationId,
	basePath = "/app/agent-templates",
}: Props) {
	const { data, isLoading, error } = useQuery(
		orpc.agentTemplates.templates.get.queryOptions({
			input: { slugOrId: slug },
		}),
	);

	if (isLoading) {
		return (
			<div className="flex justify-center py-12 min-h-screen items-center">
				<Spinner className="h-8 w-8" />
			</div>
		);
	}

	if (error || !data?.template) {
		return (
			<div className="flex flex-col items-center justify-center min-h-screen">
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

	return (
		<CreateAgentPage
			template={data.template as any}
			organizationId={organizationId}
			basePath={basePath}
		/>
	);
}
