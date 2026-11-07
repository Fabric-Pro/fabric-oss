"use client";

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "sonner";

interface UseFrameTemplatesOptions {
	category?: string;
	includeSystem?: boolean;
}

export function useFrameTemplates(options: UseFrameTemplatesOptions = {}) {
	const organizationId = useOrganizationId();

	const query = useQuery({
		enabled: !!organizationId,
		retry: false,
		queryKey: [
			"frame-templates",
			organizationId,
			options.category,
			options.includeSystem,
		],
		queryFn: async () => {
			const result = await orpcClient.frames.listTemplates({
				organizationId,
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
	const organizationId = useOrganizationId();

	const requests = useRef(new Map<string, string>());
	const mutation = useMutation({
		retry: false,
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
			if (!organizationId) {
				throw new Error(
					"Select an organization before creating a page.",
				);
			}
			const intent = JSON.stringify([
				organizationId,
				templateId,
				variables,
				title,
				description,
			]);
			const requestId =
				requests.current.get(intent) ?? crypto.randomUUID();
			requests.current.set(intent, requestId);
			const result = await orpcClient.frames.createFromTemplate({
				requestId,
				organizationId,
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
					queryKey: ["frames", organizationId],
				});
			} else {
				toast.error("Failed to create frame from template");
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
		reset: () => {
			requests.current.clear();
			mutation.reset();
		},
	};
}
