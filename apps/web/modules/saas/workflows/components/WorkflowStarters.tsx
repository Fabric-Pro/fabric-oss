"use client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
export function WorkflowStarters({
	organizationId,
	onCreated,
}: {
	organizationId: string;
	onCreated: (id: string) => void;
}) {
	const t = useTranslations("workflows.authoring");
	const copy = (key: string, fallback: string) =>
		t.has(key) ? t(key) : fallback;
	const starters = useQuery(
		orpc.workflows.starters.list.queryOptions({
			input: { organizationId },
		}),
	);
	const create = useMutation(
		orpc.workflows.starters.create.mutationOptions({
			onSuccess: ({ workflow }) => onCreated(workflow.id),
			onError: () =>
				toast.error("The starter could not be created. Try again."),
		}),
	);
	return (
		<section
			aria-label="Workflow starters"
			className="space-y-3 border-t pt-4"
		>
			<h3 className="text-sm font-medium">
				{copy("startersTitle", "Start with a delivery workflow")}
			</h3>
			<p className="text-xs text-muted-foreground">
				{copy(
					"starterInfo",
					"Creates a draft. Review instructions and supply notes when running. Nothing runs or publishes automatically.",
				)}
			</p>
			{starters.isPending ? (
				<p role="status">
					{copy("loadingStarters", "Loading starters…")}
				</p>
			) : starters.isError ? (
				<Button variant="link" onClick={() => starters.refetch()}>
					{copy("retryStarters", "Retry loading starters")}
				</Button>
			) : (
				<ul className="divide-y">
					{starters.data?.map((s) => (
						<li
							key={s.id}
							className="flex items-center justify-between gap-4 py-3"
						>
							<div>
								<p className="text-sm font-medium">{s.name}</p>
								<p className="text-xs text-muted-foreground">
									{s.description}
								</p>
							</div>
							<Button
								size="sm"
								variant="outline"
								aria-label={`Use ${s.name} starter`}
								disabled={create.isPending}
								onClick={() =>
									create.mutate({
										starterId: s.id,
										organizationId,
									})
								}
							>
								{copy("useStarter", "Use starter")}
							</Button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
