"use client";

import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";

export function NewWorkflowRedirect() {
	const router = useRouter();

	const createMutation = useMutation(
		orpc.workflows.create.mutationOptions({
			onSuccess: (data) => {
				router.replace(`/app/workflows/${data.workflow.id}`);
			},
			onError: (_error) => {
				toast.error("Failed to create workflow");
				router.replace("/app/workflows");
			},
		}),
	);

	useEffect(() => {
		// Create workflow immediately on mount
		createMutation.mutate({
			name: "Untitled Workflow",
			triggerType: "MANUAL",
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	return (
		<div className="flex h-[60vh] items-center justify-center">
			<div className="flex flex-col items-center gap-4">
				<Spinner className="h-8 w-8" />
				<p className="text-muted-foreground">Creating workflow...</p>
			</div>
		</div>
	);
}
