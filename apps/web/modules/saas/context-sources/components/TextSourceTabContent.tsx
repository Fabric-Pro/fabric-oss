"use client";

import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import type { TextSourceForm } from "../hooks/use-text-source-form";

type TextSourceTabContentProps = {
	form: TextSourceForm;
	isLoading: boolean;
};

/** The Text tab body: a title and the pasted content. */
export function TextSourceTabContent({
	form,
	isLoading,
}: TextSourceTabContentProps) {
	const { title, setTitle, content, setContent } = form;

	return (
		<div
			className="space-y-4 motion-safe:animate-stagger"
			role="tabpanel"
			id="context-tabpanel-text"
			aria-labelledby="context-tab-text"
		>
			<div>
				<Label htmlFor="text-title">Title</Label>
				<Input
					id="text-title"
					placeholder="Enter a title for this content"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					disabled={isLoading}
					className="mt-2"
				/>
			</div>

			<div>
				<Label htmlFor="text-content">Content</Label>
				<Textarea
					id="text-content"
					placeholder="Paste or type your content here. This could be notes, requirements, specifications, or any other relevant text."
					value={content}
					onChange={(e) => setContent(e.target.value)}
					disabled={isLoading}
					rows={8}
					className="mt-2 resize-none"
				/>
				<p className="mt-1 text-muted-foreground text-sm">
					{content.length} characters
				</p>
			</div>
		</div>
	);
}
