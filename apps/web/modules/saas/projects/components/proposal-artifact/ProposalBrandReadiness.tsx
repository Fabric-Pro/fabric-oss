"use client";

import { proposalClientPaletteFromColors } from "@repo/utils/proposal-artifact/theme-tokens";
import { useRecipientBrandQueryIdentity } from "@saas/projects/hooks/use-recipient-brand-query-identity";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { useTranslations } from "next-intl";
import { useCallback, useId, useState } from "react";
import { ProjectRecipientBrandCard } from "../ProjectRecipientBrandCard";

/** Reuses the project's reviewed brand rather than keeping a creation-only copy. */
export function useProposalBrandReadiness(projectId: string, enabled: boolean) {
	const identity = useRecipientBrandQueryIdentity(projectId);
	return useQuery({
		queryKey: identity.queryKey,
		queryFn: () => orpcClient.projects.recipientBrand.get({ projectId }),
		enabled: enabled && identity.enabled,
		retry: false,
	});
}

export function ProposalBrandReadiness({
	projectId,
	query,
	value,
	onValueChange,
	disabled = false,
	onDraftStateChange,
}: {
	projectId: string;
	query: ReturnType<typeof useProposalBrandReadiness>;
	value: "CLIENT" | "COMPANY";
	onValueChange: (value: "CLIENT" | "COMPANY") => void;
	disabled?: boolean;
	onDraftStateChange: (blocked: boolean) => void;
}) {
	const t = useTranslations("projects.proposalArtifact.brandReadiness");
	const [expanded, setExpanded] = useState(false);
	const [draftBlocked, setDraftBlocked] = useState(false);
	const handleDraftStateChange = useCallback(
		(blocked: boolean) => {
			setDraftBlocked(blocked);
			onDraftStateChange(blocked);
		},
		[onDraftStateChange],
	);
	const fieldId = useId();
	const brand = query.isError ? null : query.data?.recipientBrand;
	const clientPalette = proposalClientPaletteFromColors(brand?.colors ?? []);

	return (
		<section aria-label={t("title")} className="space-y-3 border-t pt-4">
			<h3 className="font-medium text-sm">{t("title")}</h3>
			<dl className="grid gap-3 sm:grid-cols-2">
				<div className="min-w-0 space-y-1">
					<dt className="text-muted-foreground text-xs">
						{t("preparedBy")}
					</dt>
					<dd className="break-words text-sm">
						{(!query.isError && query.data?.companyName) ||
							t("yourCompany")}
					</dd>
				</div>
				<div className="min-w-0 space-y-1">
					<dt className="text-muted-foreground text-xs">
						{t("preparedFor")}
					</dt>
					<dd className="break-words text-sm">
						{query.isPending
							? t("loading")
							: query.isError
								? t("unavailable")
								: brand?.name || t("clientMissing")}
					</dd>
				</div>
			</dl>
			<RadioGroup
				value={value}
				onValueChange={(next) =>
					onValueChange(next as "CLIENT" | "COMPANY")
				}
				disabled={disabled}
				aria-label={t("palette")}
				className="grid gap-3 sm:grid-cols-2"
			>
				<div className="flex items-start gap-2">
					<RadioGroupItem
						id={`${fieldId}-client-colors`}
						value="CLIENT"
						className="mt-0.5"
					/>
					<Label htmlFor={`${fieldId}-client-colors`}>
						{t("clientColors")}
					</Label>
				</div>
				<div className="flex items-start gap-2">
					<RadioGroupItem
						id={`${fieldId}-company-colors`}
						value="COMPANY"
						className="mt-0.5"
					/>
					<Label htmlFor={`${fieldId}-company-colors`}>
						{t("companyColors")}
					</Label>
				</div>
			</RadioGroup>
			{query.isError ? (
				<div className="flex flex-wrap items-center gap-3">
					<p className="text-muted-foreground text-sm">
						{t("loadFailed")}
					</p>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => query.refetch()}
					>
						{t("retry")}
					</Button>
				</div>
			) : query.data ? (
				<>
					<p className="text-muted-foreground text-xs">
						{brand?.colors.length
							? t("colorsSaved", { count: brand.colors.length })
							: t("colorsMissing")}
						{" · "}
						{brand?.logoUrl ? t("logoSaved") : t("logoMissing")}
					</p>
					{clientPalette && (
						<p className="text-sm">
							<span className="text-muted-foreground">
								{t("savedClientPalette")}:{" "}
							</span>
							{brand?.colors.join(" · ")}
						</p>
					)}
					{value === "CLIENT" && (
						<p className="text-muted-foreground text-xs">
							{t("themeSummary", {
								heading: brand?.displayFontFamily ?? "Poppins",
								body: brand?.bodyFontFamily ?? "Inter",
								cover: t(
									`cover.${brand?.coverStyle ?? "DARK"}`,
								),
							})}
						</p>
					)}
					<p className="text-muted-foreground text-xs">{t("help")}</p>
					{value === "CLIENT" && !clientPalette && (
						<output className="block text-muted-foreground text-sm">
							{t(
								query.data.canEdit
									? "clientRequired"
									: "clientRequiredReadOnly",
							)}
						</output>
					)}
					<Collapsible open={expanded} onOpenChange={setExpanded}>
						<CollapsibleTrigger asChild>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={disabled || draftBlocked}
							>
								{expanded
									? t("close")
									: query.data.canEdit
										? t("review")
										: t("view")}
							</Button>
						</CollapsibleTrigger>
						<CollapsibleContent className="mt-3">
							<ProjectRecipientBrandCard
								projectId={projectId}
								canEdit={query.data.canEdit}
								onDraftStateChange={handleDraftStateChange}
							/>
						</CollapsibleContent>
					</Collapsible>
					{draftBlocked && (
						<output className="block text-muted-foreground text-xs">
							{t("saveClientEdits")}
						</output>
					)}
				</>
			) : null}
		</section>
	);
}
