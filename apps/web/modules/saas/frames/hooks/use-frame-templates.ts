"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { toast } from "sonner";

interface UseFrameTemplatesOptions {
	category?: string;
	includeSystem?: boolean;
}

export function useFrameTemplates(options: UseFrameTemplatesOptions = {}) {
	const params = useParams();
	const organizationSlug = params?.organizationSlug as string | undefined;

	const query = useQuery({
		queryKey: [
			"frame-templates",
			organizationSlug,
			options.category,
			options.includeSystem,
		],
		queryFn: async () => {
			const result = await orpcClient.frames.listTemplates({
				organizationId: organizationSlug || null,
				category: options.category,
				includeSystem: options.includeSystem ?? true,
			});
			return result;
		},
	});

	return {
		templates: query.data?.templates ?? [],
		categories: query.data?.categories ?? [],
		isLoading: query.isLoading,
		isError: query.isError,
		error: query.error,
		refetch: query.refetch,
	};
}

export function useCreateFrameFromTemplate() {
	const queryClient = useQueryClient();
	const params = useParams();
	const organizationSlug = params?.organizationSlug as string | undefined;

	const mutation = useMutation({
		mutationFn: async ({
			templateId,
			variables,
			title,
			description,
		}: {
			templateId: string;
			variables: Record<string, string>;
			title?: string;
			description?: string;
		}) => {
			const result = await orpcClient.frames.createFromTemplate({
				organizationId: organizationSlug || null,
				templateId,
				variables,
				title,
				description,
			});
			return result;
		},
		onSuccess: (data) => {
			if (data.success && data.frame) {
				toast.success("Frame created from template");
				// Invalidate frames list to show the new frame
				queryClient.invalidateQueries({
					queryKey: ["frames", organizationSlug],
				});
			} else {
				toast.error(
					data.error || "Failed to create frame from template",
				);
			}
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to create frame from template",
			);
		},
	});

	return {
		createFromTemplate: mutation.mutateAsync,
		isPending: mutation.isPending,
		isSuccess: mutation.isSuccess,
		isError: mutation.isError,
		data: mutation.data,
		error: mutation.error,
		reset: mutation.reset,
	};
}
