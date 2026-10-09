"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { DatabaseIcon, LockIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { toast } from "sonner";

/**
 * Marks the provider that turns documents into searchable vectors.
 *
 * - `embeddingsOnly`: the key is restricted to embeddings, enforced — no LLM
 *   path can resolve it.
 * - `onlyForDocuments`: designated for documents and not the default, so in
 *   practice it serves nothing else — chat, agents and generation use the
 *   default provider, or a ChatGPT plan where one serves the member.
 */
export function EmbeddingsBadge({
	onlyForDocuments,
	embeddingsOnly = false,
}: {
	onlyForDocuments: boolean;
	embeddingsOnly?: boolean;
}) {
	const t = useTranslations("settings.aiProviders.embeddingsOnly");
	if (embeddingsOnly) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<Badge
						variant="outline"
						className="shrink-0 text-xs"
						tabIndex={0}
					>
						<LockIcon className="mr-1 size-3" />
						{t("badge")}
					</Badge>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs">
					{t("badgeTooltip")}
				</TooltipContent>
			</Tooltip>
		);
	}
	const badge = (
		<Badge
			variant="outline"
			className="shrink-0 text-xs"
			{...(onlyForDocuments && { tabIndex: 0 })}
		>
			<DatabaseIcon className="mr-1 size-3" />
			{onlyForDocuments ? "Documents only" : "Embeddings"}
		</Badge>
	);
	if (!onlyForDocuments) {
		return badge;
	}
	return (
		<Tooltip>
			<TooltipTrigger asChild>{badge}</TooltipTrigger>
			<TooltipContent className="max-w-xs">
				Used only for document search (embeddings). Chat, agents and
				document generation use the default provider, or a ChatGPT plan
				where one serves the member.
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * Restricts the documents provider's key to embeddings, or lifts that
 * restriction. Only rendered on the provider set to "Use for Documents".
 *
 * `organizationId` is passed through as given: the account form sends an
 * explicit null so the server never falls back to the session's organization.
 */
export function EmbeddingsOnlyToggle({
	provider,
	organizationId,
	checked,
	disabled = false,
}: {
	provider: string;
	organizationId: string | null | undefined;
	checked: boolean;
	disabled?: boolean;
}) {
	const t = useTranslations("settings.aiProviders.embeddingsOnly");
	const id = useId();
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: async (embeddingsOnly: boolean) =>
			await orpcClient.aiConfig.providers.setEmbedding({
				provider: provider as never,
				purpose: embeddingsOnly ? "EMBEDDINGS_ONLY" : "ALL",
				organizationId,
			}),
		onSuccess: (_result, embeddingsOnly) => {
			queryClient.invalidateQueries({ queryKey: ["aiConfigStatus"] });
			queryClient.invalidateQueries({ queryKey: ["aiAvailableModels"] });
			queryClient.invalidateQueries({ queryKey: ["aiTaskDefaults"] });
			toast.success(
				embeddingsOnly ? t("enabledToast") : t("disabledToast"),
			);
		},
		onError: (error) => {
			toast.error(t("failedToast"), {
				description: error instanceof Error ? error.message : undefined,
			});
		},
	});

	return (
		<div className="flex w-full items-start gap-2">
			<Switch
				id={id}
				checked={checked}
				disabled={disabled || mutation.isPending}
				onCheckedChange={(value) => mutation.mutate(value)}
			/>
			<div className="space-y-0.5">
				<Label htmlFor={id} className="font-medium text-xs">
					{t("toggleLabel")}
				</Label>
				<p className="text-muted-foreground text-xs">
					{t("toggleHint")}
				</p>
			</div>
		</div>
	);
}

/**
 * "Embeddings only" in a provider's Configure dialog: saved with the key, so
 * a key meant for document search is never the default provider, not even
 * for the moments before the card's toggle could be used.
 */
export function EmbeddingsOnlyOption({
	checked,
	onCheckedChange,
	disabled = false,
	takenBy,
}: {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled?: boolean;
	/** Another provider already holds the one embeddings-only key. */
	takenBy?: string;
}) {
	const t = useTranslations("settings.aiProviders.embeddingsOnly");
	const id = useId();
	return (
		<div className="flex items-start gap-2">
			<Switch
				checked={checked}
				data-testid="configure-embeddings-only"
				disabled={disabled || Boolean(takenBy)}
				id={id}
				onCheckedChange={onCheckedChange}
			/>
			<div className="space-y-0.5">
				<Label className="font-medium text-sm" htmlFor={id}>
					{t("toggleLabel")}
				</Label>
				<p className="text-muted-foreground text-xs">
					{takenBy
						? t("takenHint", { provider: takenBy })
						: t("toggleHint")}
				</p>
			</div>
		</div>
	);
}
