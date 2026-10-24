"use client";

/**
 * The project's log source — which application-log workspace the recurring-
 * error scan and bug analysis read. Without one the project uses the
 * deployment's default, when there is one.
 *
 * Saved explicitly rather than on change: a workspace id is typed, and a
 * half-typed one is not worth a request. Written through `projects.update`
 * (`logSource`), which validates the id and keeps the edit admin-only.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const AZURE_MONITOR = "azure-monitor";

/** The same shape `projects.update` accepts (zod `guid`). */
const GUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The stored config is the provider's own JSON; read only what is shown. */
function readWorkspaceId(config: unknown): string {
	if (config && typeof config === "object" && "workspaceId" in config) {
		const { workspaceId } = config;
		return typeof workspaceId === "string" ? workspaceId : "";
	}
	return "";
}

type LogSourceInput = { provider: typeof AZURE_MONITOR; workspaceId: string };

export function ProjectLogSourceSettings({
	project,
	canEdit,
}: {
	project: {
		id: string;
		organizationId?: string | null;
		logSourceProvider?: string | null;
		logSourceConfig?: unknown;
	};
	canEdit: boolean;
}) {
	const t = useTranslations("projects.recurringErrors.logSource");
	const queryClient = useQueryClient();
	const projectId = project.id;
	const organizationId = project.organizationId ?? null;
	const storedProvider = project.logSourceProvider ?? null;
	const storedWorkspaceId = readWorkspaceId(project.logSourceConfig);
	const [workspaceId, setWorkspaceId] = useState(storedWorkspaceId);

	// Re-seed when the project reloads, so a save made in another tab is not
	// overwritten by a stale draft.
	useEffect(() => {
		setWorkspaceId(storedWorkspaceId);
	}, [storedWorkspaceId]);

	const mutation = useMutation({
		mutationFn: async (logSource: LogSourceInput | null) =>
			orpcClient.projects.update({
				id: projectId,
				organizationId,
				logSource,
			}),
		onSuccess: (_data, logSource) => {
			toast.success(logSource ? t("saved") : t("cleared"));
			queryClient.invalidateQueries({
				queryKey: orpc.projects.get.queryKey({
					input: { id: projectId, organizationId },
				}),
			});
		},
		onError: (error) =>
			toast.error(
				error instanceof Error ? error.message : t("saveFailed"),
			),
	});

	const draft = workspaceId.trim();
	const draftValid = GUID_PATTERN.test(draft);
	const unchanged =
		storedProvider === AZURE_MONITOR &&
		draft.toLowerCase() === storedWorkspaceId.toLowerCase();
	const disabled = !canEdit || mutation.isPending;

	return (
		<div className="space-y-3 border-t pt-4">
			<div className="space-y-1">
				<p className="font-medium text-sm">{t("title")}</p>
				<p className="text-muted-foreground text-xs">
					{t("description")}
				</p>
			</div>

			<p className="text-muted-foreground text-xs">
				{storedProvider ? (
					<>
						<span>
							{t("current", {
								provider:
									storedProvider === AZURE_MONITOR
										? t("providerAzureMonitor")
										: storedProvider,
							})}
						</span>{" "}
						<code className="font-mono">
							{storedWorkspaceId || t("noWorkspace")}
						</code>
					</>
				) : (
					t("none")
				)}
			</p>

			<div className="space-y-1">
				<Label htmlFor="qa-log-source-provider">
					{t("providerLabel")}
				</Label>
				<Select value={AZURE_MONITOR} disabled={disabled}>
					<SelectTrigger id="qa-log-source-provider">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={AZURE_MONITOR}>
							{t("providerAzureMonitor")}
						</SelectItem>
					</SelectContent>
				</Select>
			</div>

			<div className="space-y-1">
				<Label htmlFor="qa-log-source-workspace">
					{t("workspaceIdLabel")}
				</Label>
				<Input
					id="qa-log-source-workspace"
					value={workspaceId}
					onChange={(e) => setWorkspaceId(e.target.value)}
					placeholder="00000000-0000-0000-0000-000000000000"
					disabled={disabled}
					autoComplete="off"
					spellCheck={false}
					aria-describedby="qa-log-source-help"
					aria-invalid={draft.length > 0 && !draftValid}
					className="font-mono text-xs"
				/>
				{draft.length > 0 && !draftValid && (
					<p className="text-destructive text-xs">
						{t("workspaceIdInvalid")}
					</p>
				)}
				<p
					id="qa-log-source-help"
					className="text-muted-foreground text-xs"
				>
					{t("identityHelp")}
				</p>
			</div>

			<div className="flex items-center gap-2">
				<Button
					size="sm"
					onClick={() =>
						mutation.mutate({
							provider: AZURE_MONITOR,
							workspaceId: draft,
						})
					}
					disabled={disabled || !draftValid || unchanged}
				>
					{mutation.isPending && (
						<Loader2Icon
							className="mr-1.5 size-3.5 motion-safe:animate-spin"
							aria-hidden="true"
						/>
					)}
					{t("save")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => mutation.mutate(null)}
					disabled={disabled || !storedProvider}
				>
					{t("clear")}
				</Button>
			</div>
		</div>
	);
}
