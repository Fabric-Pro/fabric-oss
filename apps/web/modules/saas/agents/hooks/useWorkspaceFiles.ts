"use client";

/**
 * useWorkspaceFiles - Hook for managing agent workspace files
 *
 * Provides:
 * - File tree fetching
 * - File CRUD operations
 * - File content management
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceFile } from "../components/WorkspacePanel";

interface UseWorkspaceFilesOptions {
	conversationId?: string | null;
	organizationId?: string;
}

export function useWorkspaceFiles(options: UseWorkspaceFilesOptions = {}) {
	const { conversationId, organizationId } = options;
	const queryClient = useQueryClient();

	// Query key for this workspace
	const queryKey = ["workspace", "files", organizationId, conversationId];

	// Fetch file tree
	const {
		data: files = [],
		isLoading,
		error,
		refetch,
	} = useQuery({
		queryKey,
		queryFn: async (): Promise<WorkspaceFile[]> => {
			try {
				// Call the workspace API to get file tree
				const result = await orpcClient.workspace.getFileTree({
					organizationId,
					conversationId: conversationId ?? undefined,
				});
				return result as WorkspaceFile[];
			} catch (e) {
				console.warn("[useWorkspaceFiles] Failed to fetch files:", e);
				return [];
			}
		},
		staleTime: 30000,
		enabled: true,
	});

	// Create file mutation
	const createFileMutation = useMutation({
		mutationFn: async (input: {
			path: string;
			name: string;
			content: string;
			fileType?:
				| "DOCUMENT"
				| "CODE"
				| "DATA"
				| "CONFIG"
				| "OUTPUT"
				| "ARTIFACT"
				| "FRAME"
				| "SLIDESHOW";
		}) => {
			return orpcClient.workspace.createFile({
				organizationId,
				conversationId: conversationId ?? undefined,
				...input,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey });
		},
	});

	// Update file mutation
	const updateFileMutation = useMutation({
		mutationFn: async (input: {
			id: string;
			content?: string;
			name?: string;
		}) => {
			return orpcClient.workspace.updateFile(input);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey });
		},
	});

	// Delete file mutation
	const deleteFileMutation = useMutation({
		mutationFn: async (id: string) => {
			return orpcClient.workspace.deleteFile({ id });
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey });
		},
	});

	// Get file content
	const getFileContent = async (id: string) => {
		try {
			const result = await orpcClient.workspace.getFile({ id });
			return result;
		} catch (e) {
			console.error("[useWorkspaceFiles] Failed to get file:", e);
			throw e;
		}
	};

	return {
		files,
		isLoading,
		error,
		refetch,
		createFile: createFileMutation.mutateAsync,
		updateFile: updateFileMutation.mutateAsync,
		deleteFile: deleteFileMutation.mutateAsync,
		getFileContent,
		isCreating: createFileMutation.isPending,
		isUpdating: updateFileMutation.isPending,
		isDeleting: deleteFileMutation.isPending,
	};
}
