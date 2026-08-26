"use client";

import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
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
import { Textarea } from "@ui/components/textarea";
import {
	ExternalLinkIcon,
	GlobeIcon,
	SaveIcon,
	ServerIcon,
	ShieldIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type Props = {
	agentId: string;
	organizationId?: string | null;
	basePath: string;
};

export function EditRegisteredAgentPage({
	agentId,
	organizationId,
	basePath: _basePath,
}: Props) {
	const queryClient = useQueryClient();
	const agentsPath = useContextPath("agents");
	const [displayName, setDisplayName] = useState("");
	const [description, setDescription] = useState("");
	const [deploymentUrl, setDeploymentUrl] = useState("");

	const { data: agent, isLoading } = useQuery({
		queryKey: ["agent", "registry", "edit", agentId, organizationId],
		queryFn: async () =>
			orpcClient.agents.registry.get({
				id: agentId,
				organizationId: organizationId ?? null,
			}),
	});

	useEffect(() => {
		if (!agent) {
			return;
		}

		setDisplayName(agent.displayName ?? "");
		setDescription(agent.description ?? "");
		setDeploymentUrl(agent.deploymentUrl ?? "");
	}, [agent]);

	const updateMutation = useMutation({
		mutationFn: async () =>
			orpcClient.agents.registry.update({
				id: agentId,
				organizationId: organizationId ?? null,
				displayName: displayName.trim(),
				description: description.trim(),
				deploymentUrl: deploymentUrl.trim(),
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["agents", "registry"],
			});
			toast.success("Agent updated successfully");
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update agent",
			);
		},
	});

	const scopeLabel = useMemo(() => {
		switch (agent?.scope) {
			case "SYSTEM":
				return "System";
			case "ORGANIZATION":
				return "Organization";
			default:
				return "Personal";
		}
	}, [agent?.scope]);

	if (isLoading) {
		return (
			<div className="flex justify-center py-12">
				<Spinner className="h-8 w-8" />
			</div>
		);
	}

	if (!agent) {
		return (
			<Card>
				<CardContent className="py-12 text-center text-sm text-muted-foreground">
					Agent not found.
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
			<Card>
				<CardHeader>
					<CardTitle>Edit Registered Agent</CardTitle>
					<CardDescription>
						Update the registry-facing metadata and connection
						details for this external agent.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6">
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="registered-agent-name">
								Display Name
							</Label>
							<Input
								id="registered-agent-name"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label>Scope</Label>
							<div className="flex h-10 items-center rounded-md border px-3 text-sm text-muted-foreground">
								{scopeLabel}
							</div>
						</div>
					</div>

					<div className="space-y-2">
						<Label htmlFor="registered-agent-url">
							Deployment URL
						</Label>
						<Input
							id="registered-agent-url"
							value={deploymentUrl}
							onChange={(e) => setDeploymentUrl(e.target.value)}
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="registered-agent-description">
							Description
						</Label>
						<Textarea
							id="registered-agent-description"
							rows={6}
							value={description}
							onChange={(e) => setDescription(e.target.value)}
						/>
					</div>

					<div className="flex items-center justify-end gap-2">
						<Button variant="outline" asChild>
							<Link href={`${agentsPath}/${agentId}`}>
								View Details
							</Link>
						</Button>
						<Button
							onClick={() => updateMutation.mutate()}
							disabled={updateMutation.isPending}
						>
							<SaveIcon className="mr-2 h-4 w-4" />
							{updateMutation.isPending
								? "Saving..."
								: "Save Changes"}
						</Button>
					</div>
				</CardContent>
			</Card>

			<div className="space-y-4">
				<Card>
					<CardHeader>
						<CardTitle className="text-base">
							Registry Summary
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						<div className="flex flex-wrap gap-2">
							<Badge variant="secondary">
								<ServerIcon className="mr-1 h-3 w-3" />
								{agent.framework}
							</Badge>
							<Badge variant="outline">
								<ShieldIcon className="mr-1 h-3 w-3" />
								{scopeLabel}
							</Badge>
							<Badge variant="outline">
								<GlobeIcon className="mr-1 h-3 w-3" />
								{agent.status}
							</Badge>
						</div>
						{agent.deploymentUrl ? (
							<Button
								variant="outline"
								className="w-full justify-start"
								asChild
							>
								<a
									href={agent.deploymentUrl}
									target="_blank"
									rel="noopener noreferrer"
								>
									<ExternalLinkIcon className="mr-2 h-4 w-4" />
									Open deployment
								</a>
							</Button>
						) : null}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="text-base">
							Editing Notes
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2 text-sm text-muted-foreground">
						<p>
							This page is for external registry agents. Use the
							main agent builder for instance-backed Fabric
							agents.
						</p>
						<p>
							Clicking a registry card now opens the internal
							details page first, so deployment URLs are explicit
							actions instead of surprise navigation.
						</p>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
