"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import {
	ArrowLeftIcon,
	LayoutTemplateIcon,
	LightbulbIcon,
	Loader2Icon,
	SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

const sectionClassName = "rounded-2xl border border-border/60 bg-card/60 p-6";

const inputClassName =
	"rounded-xl border border-border/60 bg-background/55 shadow-none";

function sanitizeSlug(value: string) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

type Props = {
	organizationId?: string;
	basePath?: string;
};

export function CreateTemplatePage({
	organizationId: _organizationId,
	basePath = "/app/agent-templates",
}: Props) {
	const router = useRouter();
	const queryClient = useQueryClient();

	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [instructions, setInstructions] = useState("");
	const [isGeneratingDescription, setIsGeneratingDescription] =
		useState(false);
	const [isGeneratingInstructions, setIsGeneratingInstructions] =
		useState(false);

	const createMutation = useMutation(
		orpc.agentTemplates.templates.create.mutationOptions({
			onSuccess: (data) => {
				toast.success("Template created successfully");
				queryClient.invalidateQueries({
					queryKey: ["agentTemplates", "templates"],
				});
				router.push(`${basePath}/${data.template.slug}`);
			},
			onError: (error) => {
				toast.error(error.message || "Failed to create template");
			},
		}),
	);

	const handleCreate = () => {
		if (!name.trim()) {
			toast.error("Please enter a template name");
			return;
		}

		if (!description.trim()) {
			toast.error("Please enter a description");
			return;
		}

		if (!instructions.trim()) {
			toast.error("Please add template instructions");
			return;
		}

		const slug = sanitizeSlug(name);
		if (!slug) {
			toast.error("Please enter a valid template name");
			return;
		}

		createMutation.mutate({
			slug,
			name: slug,
			displayName: name.trim(),
			description: description.trim(),
			instructions: instructions.trim(),
		});
	};

	const generateDescription = async () => {
		setIsGeneratingDescription(true);
		try {
			await new Promise((resolve) => setTimeout(resolve, 500));
			setDescription(
				"A reusable instruction template that users can adapt when creating their own agent.",
			);
		} finally {
			setIsGeneratingDescription(false);
		}
	};

	const generateInstructions = async () => {
		setIsGeneratingInstructions(true);
		try {
			await new Promise((resolve) => setTimeout(resolve, 500));
			setInstructions(
				[
					"You are a specialist assistant for this workflow.",
					"Clarify the user's goal when needed, stay practical, and produce directly usable output.",
					"Surface assumptions when they materially affect the answer.",
				].join("\n\n"),
			);
		} finally {
			setIsGeneratingInstructions(false);
		}
	};

	return (
		<div className="bg-background">
			<div className="sticky top-0 z-10 border-b border-border bg-card">
				<div className="w-full px-6 py-3">
					<div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
						<div className="flex items-center gap-3">
							<Button variant="ghost" size="icon" asChild>
								<Link href={basePath}>
									<ArrowLeftIcon className="h-4 w-4" />
								</Link>
							</Button>
							<div className="h-4 w-px bg-border" />
							<div className="flex items-center gap-3">
								<div className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
									<LayoutTemplateIcon className="h-4 w-4" />
								</div>
								<div>
									<p className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
										Template Builder
									</p>
									<h1 className="font-sans text-base font-normal leading-tight">
										Create Template
									</h1>
								</div>
							</div>
						</div>
						<div className="flex items-center gap-2">
							<Button
								variant="outline"
								asChild
								className="border-border/60 bg-background/60"
							>
								<Link href={basePath}>Cancel</Link>
							</Button>
							<Button
								onClick={handleCreate}
								disabled={
									createMutation.isPending ||
									!name.trim() ||
									!description.trim() ||
									!instructions.trim()
								}
								className="bg-primary px-6 text-primary-foreground hover:bg-primary/90"
							>
								{createMutation.isPending ? (
									<>
										<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
										Creating...
									</>
								) : (
									"Create Template"
								)}
							</Button>
						</div>
					</div>
				</div>
			</div>

			<div className="mx-auto grid max-w-[1200px] gap-8 px-6 py-8 xl:grid-cols-[minmax(0,1fr)_280px]">
				<div className="space-y-6">
					<section className={sectionClassName}>
						<div className="mb-5">
							<h3 className="text-base font-semibold">
								Template Details
							</h3>
							<p className="text-sm text-muted-foreground">
								Dust-style templates only need a name, a short
								description, and reusable instructions.
							</p>
						</div>

						<div className="space-y-5">
							<div>
								<Label
									htmlFor="template-name"
									className="mb-2 block text-sm font-medium"
								>
									Name
								</Label>
								<Input
									id="template-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									className={inputClassName}
									placeholder="e.g., Spreadsheet Expert"
								/>
							</div>

							<div>
								<div className="mb-2 flex items-center justify-between">
									<Label
										htmlFor="template-description"
										className="text-sm font-medium"
									>
										Description
									</Label>
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="gap-2"
										onClick={generateDescription}
										disabled={isGeneratingDescription}
									>
										{isGeneratingDescription ? (
											<Loader2Icon className="h-4 w-4 animate-spin" />
										) : (
											<SparklesIcon className="h-4 w-4" />
										)}
										Generate
									</Button>
								</div>
								<Textarea
									id="template-description"
									value={description}
									onChange={(e) =>
										setDescription(e.target.value)
									}
									className={`${inputClassName} min-h-[120px] resize-none`}
									placeholder="Describe what this template helps with and when someone should use it."
								/>
							</div>

							<div>
								<div className="mb-2 flex items-center justify-between">
									<Label
										htmlFor="template-instructions"
										className="text-sm font-medium"
									>
										Instructions
									</Label>
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="gap-2"
										onClick={generateInstructions}
										disabled={isGeneratingInstructions}
									>
										{isGeneratingInstructions ? (
											<Loader2Icon className="h-4 w-4 animate-spin" />
										) : (
											<SparklesIcon className="h-4 w-4" />
										)}
										Generate
									</Button>
								</div>
								<Textarea
									id="template-instructions"
									value={instructions}
									onChange={(e) =>
										setInstructions(e.target.value)
									}
									className={`${inputClassName} min-h-[360px] resize-y`}
									placeholder="What is the purpose of the agent? How should it behave?"
								/>
							</div>
						</div>
					</section>
				</div>

				<aside className="space-y-4">
					<section className={sectionClassName}>
						<h3 className="flex items-center gap-2 text-sm font-semibold">
							<LightbulbIcon className="h-4 w-4 text-[--mkt-red]" />
							Guidance
						</h3>
						<div className="mt-4 space-y-3 text-sm text-muted-foreground">
							<p>
								Keep the description user-facing and the
								instructions agent-facing.
							</p>
							<p>
								Do not define tools, spaces, MCP servers, or
								triggers in the template. Those belong to the
								agent created from it.
							</p>
							<p>
								Write instructions that stay reusable across
								many agent instances.
							</p>
						</div>
					</section>
				</aside>
			</div>
		</div>
	);
}
