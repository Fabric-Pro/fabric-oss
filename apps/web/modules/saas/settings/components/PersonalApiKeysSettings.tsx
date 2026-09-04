"use client";

import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import { KeyIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

/**
 * Personal (`fab_`) keys — list and revoke only.
 *
 * These are not created here, and that is deliberate. Fabric issues one place
 * on purpose: the organization key above, which carries your access within a
 * named organization. A personal key resolves its organization per request
 * instead, which made sense while a personal workspace existed and now mostly
 * means "whichever organization you were last in".
 *
 * They still get made, though — authorizing the Fabric Code extension mints
 * one — and the screen that could show or revoke them was removed with the
 * personal settings tree. So keys existed that their owner could not see, let
 * alone cancel, and cancelling one meant asking someone with database access.
 * This is that screen, doing only the half that was actually missing.
 *
 * It renders nothing when there are no such keys, so the common case — a person
 * who has never connected the extension — sees no vestigial empty section.
 */
export function PersonalApiKeysSettings() {
	const queryClient = useQueryClient();

	const { data: apiKeys, isLoading } = useQuery({
		queryKey: ["personalApiKeys"],
		queryFn: async () => await orpcClient.users.apiKeys.list({}),
	});

	const deleteMutation = useMutation({
		mutationFn: async (id: string) =>
			await orpcClient.users.apiKeys.delete({ id }),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["personalApiKeys"] });
			toast.success("API key revoked");
		},
		onError: () => {
			toast.error("Failed to revoke API key");
		},
	});

	const handleRevoke = (id: string, name: string) => {
		if (
			window.confirm(
				`Revoke "${name}"? Anything still using it will stop working immediately.`,
			)
		) {
			deleteMutation.mutate(id);
		}
	};

	const formatDate = (date: Date | null) =>
		date ? new Date(date).toLocaleDateString() : "Never";

	// Nothing to manage, nothing to show.
	if (isLoading || !apiKeys || apiKeys.length === 0) {
		return null;
	}

	return (
		<SettingsItem
			title="Personal Keys"
			description="Keys issued to you directly rather than within an organization — the Fabric Code extension creates one when you authorize it. New keys are created above; these can be revoked here."
		>
			<div className="rounded-md border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Name</TableHead>
							<TableHead>Key</TableHead>
							<TableHead>Scopes</TableHead>
							<TableHead>Last Used</TableHead>
							<TableHead className="w-[50px]" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{apiKeys.map((key) => (
							<TableRow key={key.id}>
								<TableCell className="font-medium">
									<div className="flex items-center gap-2">
										<KeyIcon className="size-4 text-muted-foreground" />
										{key.name}
									</div>
								</TableCell>
								<TableCell>
									<code className="rounded bg-muted px-2 py-1 text-xs">
										{key.keyPrefix}...
									</code>
								</TableCell>
								<TableCell>
									<div className="flex flex-wrap gap-1">
										{key.scopes.map((scope) => (
											<Badge
												key={scope}
												variant="secondary"
												className="text-xs"
											>
												{scope}
											</Badge>
										))}
									</div>
								</TableCell>
								<TableCell className="text-muted-foreground text-sm">
									{formatDate(key.lastUsedAt)}
								</TableCell>
								<TableCell>
									<Button
										variant="ghost"
										size="icon"
										aria-label={`Revoke ${key.name}`}
										onClick={() =>
											handleRevoke(key.id, key.name)
										}
										disabled={deleteMutation.isPending}
									>
										<Trash2Icon className="size-4 text-destructive" />
									</Button>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</SettingsItem>
	);
}
