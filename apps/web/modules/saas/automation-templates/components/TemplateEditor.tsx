"use client";

import { useBasePath } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import {
	ArrowLeftIcon,
	PlayIcon,
	PlusIcon,
	SaveIcon,
	TrashIcon,
	XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ExecuteTemplateDialog } from "./ExecuteTemplateDialog";

type TemplateParameter = {
	name: string;
	type: "string" | "number" | "boolean" | "url" | "selector" | "json";
	description?: string;
	required: boolean;
	defaultValue?: unknown;
};

type Props = {
	templateId?: string;
	organizationId?: string;
};

export function TemplateEditor({ templateId, organizationId }: Props) {
	const router = useRouter();
	// Where a freshly-saved template lands: the tree the editor was opened in,
	// not always the personal one (R11).
	const basePath = useBasePath();
	const queryClient = useQueryClient();
	const isNew = !templateId;

	// Form state
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [category, setCategory] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [tagInput, setTagInput] = useState("");
	const [isPublic, setIsPublic] = useState(false);
	const [parameters, setParameters] = useState<TemplateParameter[]>([]);
	const [executeDialogOpen, setExecuteDialogOpen] = useState(false);

	// Fetch existing template
	const { data: templateData, isLoading } = useQuery(
		orpc.automationTemplates.get.queryOptions({
			input: { id: templateId ?? "", organizationId },
		}),
	);

	// Populate form when template loads
	useEffect(() => {
		if (templateData?.template) {
			const t = templateData.template;
			setName(t.name);
			setDescription(t.description ?? "");
			setCategory(t.category ?? "");
			setTags(t.tags ?? []);
			setIsPublic(t.isPublic);
			setParameters((t.parameters as TemplateParameter[]) ?? []);
		}
	}, [templateData]);

	// Create mutation
	const createMutation = useMutation(
		orpc.automationTemplates.create.mutationOptions({
			onSuccess: (data) => {
				toast.success("Template created");
				queryClient.invalidateQueries({
					queryKey: ["automationTemplates"],
				});
				router.push(
					`${basePath}/automation-templates/${data.template.id}`,
				);
			},
			onError: (error) => {
				toast.error("Failed to create template", {
					description: error.message,
				});
			},
		}),
	);

	// Update mutation
	const updateMutation = useMutation(
		orpc.automationTemplates.update.mutationOptions({
			onSuccess: () => {
				toast.success("Template updated");
				queryClient.invalidateQueries({
					queryKey: ["automationTemplates"],
				});
			},
			onError: (error) => {
				toast.error("Failed to update template", {
					description: error.message,
				});
			},
		}),
	);

	const handleSave = () => {
		if (isNew) {
			createMutation.mutate({
				name,
				description: description || undefined,
				category: category || undefined,
				tags,
				isPublic,
				parameters,
				workflowSteps: [], // Empty for now - can be populated via workflow builder
				organizationId,
			});
		} else {
			updateMutation.mutate({
				// biome-ignore lint/style/noNonNullAssertion: templateId is guaranteed in edit mode
				id: templateId!,
				name,
				description: description || undefined,
				category: category || undefined,
				tags,
				isPublic,
				parameters,
				organizationId,
				incrementVersion: true,
			});
		}
	};

	const addTag = () => {
		if (tagInput && !tags.includes(tagInput)) {
			setTags([...tags, tagInput]);
			setTagInput("");
		}
	};

	const removeTag = (tag: string) => {
		setTags(tags.filter((t) => t !== tag));
	};

	const addParameter = () => {
		setParameters([
			...parameters,
			{ name: "", type: "string", required: true },
		]);
	};

	const updateParameter = (
		index: number,
		updates: Partial<TemplateParameter>,
	) => {
		const newParams = [...parameters];
		newParams[index] = { ...newParams[index], ...updates };
		setParameters(newParams);
	};

	const removeParameter = (index: number) => {
		setParameters(parameters.filter((_, i) => i !== index));
	};

	if (!isNew && isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Spinner />
			</div>
		);
	}

	const isSaving = createMutation.isPending || updateMutation.isPending;

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-4">
					<Button
						variant="ghost"
						size="icon"
						onClick={() => router.back()}
					>
						<ArrowLeftIcon className="h-4 w-4" />
					</Button>
					<h1 className="text-2xl font-bold">
						{isNew ? "New Template" : "Edit Template"}
					</h1>
				</div>
				<div className="flex gap-2">
					{!isNew && (
						<Button
							variant="outline"
							onClick={() => setExecuteDialogOpen(true)}
						>
							<PlayIcon className="h-4 w-4 mr-2" />
							Execute
						</Button>
					)}
					<Button onClick={handleSave} disabled={isSaving || !name}>
						{isSaving ? (
							<Spinner className="h-4 w-4 mr-2" />
						) : (
							<SaveIcon className="h-4 w-4 mr-2" />
						)}
						{isNew ? "Create" : "Save"}
					</Button>
				</div>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
				{/* Main Form */}
				<div className="lg:col-span-2 space-y-6">
					<Card>
						<CardHeader>
							<CardTitle>Basic Information</CardTitle>
							<CardDescription>
								Template name and description
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="name">Name *</Label>
								<Input
									id="name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="My Automation Template"
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="description">Description</Label>
								<Textarea
									id="description"
									value={description}
									onChange={(e) =>
										setDescription(e.target.value)
									}
									placeholder="What does this template do?"
									rows={3}
								/>
							</div>
						</CardContent>
					</Card>

					{/* Parameters */}
					<Card>
						<CardHeader>
							<CardTitle>Parameters</CardTitle>
							<CardDescription>
								Define configurable parameters for this template
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							{parameters.map((param, index) => (
								<div
									key={index}
									className="flex gap-2 items-start p-3 border rounded-lg"
								>
									<div className="flex-1 grid grid-cols-2 gap-2">
										<Input
											placeholder="Parameter name"
											value={param.name}
											onChange={(e) =>
												updateParameter(index, {
													name: e.target.value,
												})
											}
										/>
										<select
											className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
											value={param.type}
											onChange={(e) =>
												updateParameter(index, {
													type: e.target
														.value as TemplateParameter["type"],
												})
											}
										>
											<option value="string">
												String
											</option>
											<option value="number">
												Number
											</option>
											<option value="boolean">
												Boolean
											</option>
											<option value="url">URL</option>
											<option value="selector">
												Selector
											</option>
											<option value="json">JSON</option>
										</select>
										<Input
											placeholder="Description"
											value={param.description ?? ""}
											onChange={(e) =>
												updateParameter(index, {
													description: e.target.value,
												})
											}
											className="col-span-2"
										/>
									</div>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => removeParameter(index)}
									>
										<TrashIcon className="h-4 w-4 text-destructive" />
									</Button>
								</div>
							))}
							<Button variant="outline" onClick={addParameter}>
								<PlusIcon className="h-4 w-4 mr-2" />
								Add Parameter
							</Button>
						</CardContent>
					</Card>
				</div>

				{/* Sidebar */}
				<div className="space-y-6">
					<Card>
						<CardHeader>
							<CardTitle>Settings</CardTitle>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="category">Category</Label>
								<Input
									id="category"
									value={category}
									onChange={(e) =>
										setCategory(e.target.value)
									}
									placeholder="e.g., data-extraction"
								/>
							</div>
							<div className="space-y-2">
								<Label>Tags</Label>
								<div className="flex gap-2">
									<Input
										value={tagInput}
										onChange={(e) =>
											setTagInput(e.target.value)
										}
										placeholder="Add tag"
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												addTag();
											}
										}}
									/>
									<Button
										variant="outline"
										size="icon"
										onClick={addTag}
									>
										<PlusIcon className="h-4 w-4" />
									</Button>
								</div>
								{tags.length > 0 && (
									<div className="flex flex-wrap gap-1 mt-2">
										{tags.map((tag) => (
											<Badge
												key={tag}
												variant="secondary"
												className="gap-1"
											>
												{tag}
												<button
													type="button"
													onClick={() =>
														removeTag(tag)
													}
												>
													<XIcon className="h-3 w-3" />
												</button>
											</Badge>
										))}
									</div>
								)}
							</div>
							<div className="flex items-center justify-between pt-4 border-t">
								<Label htmlFor="public">Make public</Label>
								<Switch
									id="public"
									checked={isPublic}
									onCheckedChange={setIsPublic}
								/>
							</div>
						</CardContent>
					</Card>
				</div>
			</div>

			{/* Execute Dialog */}
			{!isNew && templateData?.template && (
				<ExecuteTemplateDialog
					template={templateData.template as any}
					open={executeDialogOpen}
					onOpenChange={setExecuteDialogOpen}
					organizationId={organizationId}
				/>
			)}
		</div>
	);
}
