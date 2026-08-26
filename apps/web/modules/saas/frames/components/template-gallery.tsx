"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { ScrollArea } from "@ui/components/scroll-area";
import { SearchInput } from "@ui/components/search-input";
import { Skeleton } from "@ui/components/skeleton";
import {
	BarChart3,
	FileCode,
	FormInput,
	Layout,
	Presentation,
	Search,
	Sparkles,
} from "lucide-react";
import { useState } from "react";
import { useFrameTemplates } from "../hooks/use-frame-templates";
import { TemplateVariableForm } from "./template-variable-form";

interface TemplateGalleryProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onFrameCreated?: (frameId: string) => void;
}

const categoryIcons: Record<string, React.ReactNode> = {
	Dashboard: <BarChart3 className="h-5 w-5" />,
	Form: <FormInput className="h-5 w-5" />,
	Presentation: <Presentation className="h-5 w-5" />,
	Layout: <Layout className="h-5 w-5" />,
	Code: <FileCode className="h-5 w-5" />,
};

export function TemplateGallery({
	open,
	onOpenChange,
	onFrameCreated,
}: TemplateGalleryProps) {
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedCategory, setSelectedCategory] = useState<string | null>(
		null,
	);
	const [selectedTemplate, setSelectedTemplate] = useState<string | null>(
		null,
	);

	const { templates, categories, isLoading, isError } = useFrameTemplates({
		category: selectedCategory || undefined,
	});

	const filteredTemplates = templates.filter((template) =>
		template.name.toLowerCase().includes(searchQuery.toLowerCase()),
	);

	const handleTemplateSelect = (templateId: string) => {
		setSelectedTemplate(templateId);
	};

	const handleBackToGallery = () => {
		setSelectedTemplate(null);
	};

	const handleFrameCreated = (frameId: string) => {
		onFrameCreated?.(frameId);
		onOpenChange(false);
		setSelectedTemplate(null);
		setSearchQuery("");
		setSelectedCategory(null);
	};

	const selectedTemplateData = templates.find(
		(t) => t.id === selectedTemplate,
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-4xl max-h-[85vh] p-0">
				{selectedTemplate && selectedTemplateData ? (
					<div className="p-6">
						<div className="flex items-center gap-2 mb-6">
							<Button
								variant="ghost"
								size="sm"
								onClick={handleBackToGallery}
							>
								← Back to templates
							</Button>
						</div>
						<TemplateVariableForm
							template={selectedTemplateData}
							onCancel={handleBackToGallery}
							onSuccess={handleFrameCreated}
						/>
					</div>
				) : (
					<>
						<DialogHeader className="px-6 pt-6 pb-2">
							<DialogTitle className="flex items-center gap-2">
								<Sparkles className="h-5 w-5 text-primary" />
								Create Frame from Template
							</DialogTitle>
							<DialogDescription>
								Choose a template to get started quickly with
								pre-built frame structures
							</DialogDescription>
						</DialogHeader>

						<div className="px-6 py-4 space-y-4">
							{/* Search */}
							<div className="relative">
								<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
								<SearchInput
									placeholder="Search templates..."
									value={searchQuery}
									onChange={(e) =>
										setSearchQuery(e.target.value)
									}
									className="pl-9"
								/>
							</div>

							{/* Categories */}
							<div className="flex flex-wrap gap-2">
								<Button
									variant={
										selectedCategory === null
											? "default"
											: "outline"
									}
									size="sm"
									onClick={() => setSelectedCategory(null)}
								>
									All
								</Button>
								{categories.map((category) => (
									<Button
										key={category}
										variant={
											selectedCategory === category
												? "default"
												: "outline"
										}
										size="sm"
										onClick={() =>
											setSelectedCategory(category)
										}
									>
										{categoryIcons[category] || (
											<Layout className="h-4 w-4 mr-1" />
										)}
										{category}
									</Button>
								))}
							</div>
						</div>

						{/* Template Grid */}
						<ScrollArea className="h-[400px] px-6 pb-6">
							{isLoading ? (
								<TemplateGallerySkeleton />
							) : isError ? (
								<div className="text-center py-12">
									<p className="text-muted-foreground">
										Failed to load templates. Please try
										again.
									</p>
									<Button
										variant="outline"
										onClick={() => window.location.reload()}
										className="mt-4"
									>
										Retry
									</Button>
								</div>
							) : filteredTemplates.length === 0 ? (
								<div className="text-center py-12">
									<Layout className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
									<p className="text-muted-foreground">
										{searchQuery
											? "No templates match your search"
											: "No templates available"}
									</p>
								</div>
							) : (
								<div className="grid grid-cols-2 md:grid-cols-3 gap-4">
									{filteredTemplates.map((template) => (
										<button
											type="button"
											key={template.id}
											onClick={() =>
												handleTemplateSelect(
													template.id,
												)
											}
											className="text-left p-4 rounded-lg border hover:border-primary hover:shadow-sm transition-all group"
										>
											<div className="flex items-start justify-between mb-2">
												<div className="p-2 rounded-md bg-muted group-hover:bg-primary/10 transition-colors">
													{categoryIcons[
														template.category
													] || (
														<Layout className="h-5 w-5" />
													)}
												</div>
												{template.isSystem && (
													<Badge
														variant="secondary"
														className="text-xs"
													>
														System
													</Badge>
												)}
											</div>
											<h3 className="font-medium mb-1">
												{template.name}
											</h3>
											{template.description && (
												<p className="text-sm text-muted-foreground line-clamp-2">
													{template.description}
												</p>
											)}
											<div className="mt-3 flex items-center gap-2">
												<Badge
													variant="outline"
													className="text-xs"
												>
													{template.category}
												</Badge>
												{template.variables &&
													Object.keys(
														template.variables,
													).length > 0 && (
														<Badge
															variant="outline"
															className="text-xs"
														>
															{
																Object.keys(
																	template.variables,
																).length
															}{" "}
															variables
														</Badge>
													)}
											</div>
										</button>
									))}
								</div>
							)}
						</ScrollArea>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function TemplateGallerySkeleton() {
	return (
		<div className="grid grid-cols-2 md:grid-cols-3 gap-4">
			{Array.from({ length: 6 }).map((_, i) => (
				<div key={i} className="p-4 rounded-lg border">
					<Skeleton className="h-10 w-10 rounded-md mb-3" />
					<Skeleton className="h-5 w-3/4 mb-2" />
					<Skeleton className="h-4 w-full mb-1" />
					<Skeleton className="h-4 w-2/3" />
				</div>
			))}
		</div>
	);
}
