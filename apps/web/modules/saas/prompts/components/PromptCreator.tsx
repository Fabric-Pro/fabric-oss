"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@ui/components/breadcrumb";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PromptEditorAI } from "./PromptEditorAI";

type Props = {
	organizationId?: string;
};

export function PromptCreator({ organizationId }: Props) {
	const router = useRouter();
	const { basePath } = useOrganizationContext();

	const createMutation = useMutation({
		mutationFn: async (data: {
			name: string;
			description?: string;
			scope: "SYSTEM" | "ORG" | "USER";
			format:
				| "PLAIN_TEXT"
				| "MARKDOWN"
				| "HANDLEBARS"
				| "MUSTACHE"
				| "LIQUID"
				| "JINJA2";
			category?: string;
			tags: string[];
			isPublic: boolean;
			content?: string;
		}) => {
			// Generate a unique key from the name
			const key = data.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "");

			return await orpcClient.prompts.create({
				key,
				name: data.name,
				description: data.description,
				scope: data.scope,
				organizationId:
					data.scope === "ORG" ? organizationId : undefined,
				format: data.format,
				category: data.category,
				tags: data.tags,
				isPublic: data.isPublic,
				initialContent: data.content,
			});
		},
		onSuccess: (result) => {
			toast.success("Prompt created successfully");
			router.push(`${basePath}/prompts/${result.prompt.id}`);
		},
		onError: (error) => {
			toast.error("Failed to create prompt", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const handleSave = (data: any) => {
		createMutation.mutate(data);
	};

	const handleCancel = () => {
		router.push(`${basePath}/prompts`);
	};

	return (
		<div>
			{/* Breadcrumbs */}
			<Breadcrumb className="mb-6">
				<BreadcrumbList>
					<BreadcrumbItem>
						<BreadcrumbLink href={`${basePath}/prompts`}>
							Prompts
						</BreadcrumbLink>
					</BreadcrumbItem>
					<BreadcrumbSeparator />
					<BreadcrumbItem>
						<BreadcrumbPage>New Prompt</BreadcrumbPage>
					</BreadcrumbItem>
				</BreadcrumbList>
			</Breadcrumb>

			<div className="mb-6">
				<h1
					className="text-3xl tracking-tight mb-2"
					style={{
						fontFamily:
							"var(--font-sans, 'EB Garamond', Georgia, serif)",
						fontWeight: 400,
					}}
				>
					Create New Prompt
				</h1>
				<p className="text-muted-foreground">
					Create a reusable prompt template for AI agents, workflows,
					and documents.
				</p>
			</div>

			<PromptEditorAI
				onSave={handleSave}
				onCancel={handleCancel}
				isLoading={createMutation.isPending}
				canEditScope={true}
				organizationId={organizationId}
			/>
		</div>
	);
}
