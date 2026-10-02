"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import type {
	ContextSourceAdded,
	ContextSourceSubmitAdapter,
} from "../lib/submit-adapter";

interface UseTextSourceFormOptions {
	adapter: ContextSourceSubmitAdapter;
	/** Fires when the pasted text was saved. */
	onSourceAdded?: (added: ContextSourceAdded) => void;
	/** Saved: close and reset the dialog. */
	onComplete: () => void;
}

/** State and submit for the Text tab. Rendered by `TextSourceTabContent`. */
export function useTextSourceForm({
	adapter,
	onSourceAdded,
	onComplete,
}: UseTextSourceFormOptions) {
	const queryClient = useQueryClient();
	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");

	const createTextMutation = useMutation({
		mutationFn: (text: { title: string; content: string }) =>
			adapter.createText(text),
		onSuccess: () => {
			// Fires on every successful TEXT submit. The Text tab's only call
			// site is `submit` ⇒ one report per row, matching the File / Link
			// patterns.
			onSourceAdded?.({ contextType: "TEXT" });
			toast.success("Context added successfully");
			queryClient.invalidateQueries({ queryKey: adapter.listQueryKey });
			onComplete();
		},
		onError: (error) => {
			toast.error(`Failed to add context: ${error.message}`);
		},
	});

	const submit = () => {
		if (!title.trim() || !content.trim()) {
			toast.error("Please enter both title and content");
			return;
		}

		createTextMutation.mutate({
			title: title.trim(),
			content: content.trim(),
		});
	};

	const reset = () => {
		setTitle("");
		setContent("");
	};

	return {
		title,
		setTitle,
		content,
		setContent,
		submit,
		reset,
		isLoading: createTextMutation.isPending,
	};
}

export type TextSourceForm = ReturnType<typeof useTextSourceForm>;
