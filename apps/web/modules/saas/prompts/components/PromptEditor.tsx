"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { Loader2, SaveIcon, XIcon } from "lucide-react";
import { useState } from "react";

type PromptFormat =
	| "PLAIN_TEXT"
	| "MARKDOWN"
	| "HANDLEBARS"
	| "MUSTACHE"
	| "LIQUID"
	| "JINJA2";
type PromptScope = "SYSTEM" | "ORG" | "USER";

type Props = {
	initialData: {
		name: string;
		description?: string;
		scope: PromptScope;
		format: PromptFormat;
		category?: string;
		tags: string[];
		isPublic: boolean;
		content: string;
	};
	onSave: (data: {
		name: string;
		description?: string;
		scope: PromptScope;
		format: PromptFormat;
		category?: string;
		tags: string[];
		isPublic: boolean;
		content: string;
		changeNote?: string;
	}) => void;
	onCancel: () => void;
	isLoading?: boolean;
	canEditScope?: boolean;
};

export function PromptEditor({
	initialData,
	onSave,
	onCancel,
	isLoading = false,
	canEditScope = true,
}: Props) {
	const [name, setName] = useState(initialData.name);
	const [description, setDescription] = useState(
		initialData.description ?? "",
	);
	const [scope, setScope] = useState<PromptScope>(initialData.scope);
	const [format, setFormat] = useState<PromptFormat>(initialData.format);
	const [category, setCategory] = useState(initialData.category ?? "");
	const [tags, setTags] = useState<string[]>(initialData.tags);
	const [tagInput, setTagInput] = useState("");
	const [isPublic] = useState(initialData.isPublic);
	const [content, setContent] = useState(initialData.content);
	const [changeNote, setChangeNote] = useState("");

	const handleAddTag = () => {
		const trimmedTag = tagInput.trim();
		if (trimmedTag && !tags.includes(trimmedTag)) {
			setTags([...tags, trimmedTag]);
			setTagInput("");
		}
	};

	const handleRemoveTag = (tagToRemove: string) => {
		setTags(tags.filter((tag) => tag !== tagToRemove));
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		onSave({
			name,
			description: description || undefined,
			scope,
			format,
			category: category || undefined,
			tags,
			isPublic,
			content,
			changeNote: changeNote || undefined,
		});
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-6">
			{/* Content Editor - First and prominent */}
			<Card className="p-6">
				<h2 className="text-xl font-semibold mb-4">Prompt Content</h2>
				<div className="space-y-4">
					<Textarea
						value={content}
						onChange={(e) => setContent(e.target.value)}
						placeholder="Enter your prompt content here..."
						className="min-h-[300px] font-mono text-sm leading-relaxed"
						required
					/>
					<div>
						<Label htmlFor="changeNote">
							Change Note{" "}
							<span className="text-muted-foreground font-normal">
								(optional)
							</span>
						</Label>
						<Input
							id="changeNote"
							value={changeNote}
							onChange={(e) => setChangeNote(e.target.value)}
							placeholder="Describe what you changed"
						/>
					</div>
				</div>
			</Card>

			{/* Metadata Editor */}
			<Card className="p-6">
				<h2 className="text-xl font-semibold mb-4">Metadata</h2>
				<div className="space-y-4">
					{/* Name */}
					<div>
						<Label htmlFor="name">Name *</Label>
						<Input
							id="name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Enter prompt name"
							required
						/>
					</div>

					{/* Description */}
					<div>
						<Label htmlFor="description">Description</Label>
						<Input
							id="description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Describe what this prompt does"
						/>
					</div>

					{/* Scope and Format */}
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						<div>
							<Label htmlFor="scope">Scope *</Label>
							<Select
								value={scope}
								onValueChange={(value) =>
									setScope(value as PromptScope)
								}
								disabled={!canEditScope}
							>
								<SelectTrigger id="scope">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="USER">
										Personal
									</SelectItem>
									<SelectItem value="ORG">
										Organization
									</SelectItem>
									<SelectItem value="SYSTEM">
										System
									</SelectItem>
								</SelectContent>
							</Select>
						</div>

						<div>
							<Label htmlFor="format">Format *</Label>
							<Select
								value={format}
								onValueChange={(value) =>
									setFormat(value as PromptFormat)
								}
							>
								<SelectTrigger id="format">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="PLAIN_TEXT">
										Plain Text
									</SelectItem>
									<SelectItem value="MARKDOWN">
										Markdown
									</SelectItem>
									<SelectItem value="HANDLEBARS">
										Handlebars
									</SelectItem>
									<SelectItem value="MUSTACHE">
										Mustache
									</SelectItem>
									<SelectItem value="LIQUID">
										Liquid
									</SelectItem>
									<SelectItem value="JINJA2">
										Jinja2
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>

					{/* Category */}
					<div>
						<Label htmlFor="category">Category</Label>
						<Input
							id="category"
							value={category}
							onChange={(e) => setCategory(e.target.value)}
							placeholder="e.g., document-generation, agent-instructions"
						/>
					</div>

					{/* Tags */}
					<div>
						<Label htmlFor="tags">Tags</Label>
						<div className="flex gap-2 mb-2">
							<Input
								id="tags"
								value={tagInput}
								onChange={(e) => setTagInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										handleAddTag();
									}
								}}
								placeholder="Add tags (press Enter)"
							/>
							<Button
								type="button"
								onClick={handleAddTag}
								variant="secondary"
							>
								Add
							</Button>
						</div>
						{tags.length > 0 && (
							<div className="flex flex-wrap gap-2">
								{tags.map((tag) => (
									<Badge key={tag} variant="secondary">
										{tag}
										<button
											type="button"
											onClick={() => handleRemoveTag(tag)}
											className="ml-1 hover:text-destructive"
										>
											<XIcon className="h-3 w-3" />
										</button>
									</Badge>
								))}
							</div>
						)}
					</div>
				</div>
			</Card>

			{/* Actions */}
			<div className="flex justify-end gap-2">
				<Button
					type="button"
					variant="outline"
					onClick={onCancel}
					disabled={isLoading}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={isLoading || !name || !content}>
					{isLoading ? (
						<>
							<Loader2 className="h-4 w-4 mr-2 animate-spin" />
							Saving...
						</>
					) : (
						<>
							<SaveIcon className="h-4 w-4 mr-2" />
							Save Changes
						</>
					)}
				</Button>
			</div>
		</form>
	);
}
