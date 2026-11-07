"use client";

import type { ArtifactBrandSelection } from "@repo/utils/artifact-brand-snapshot";
import type { ArtifactBrandSource } from "@repo/utils/artifact-brand-theme";
import { useSession } from "@saas/auth/hooks/use-session";
import { ArtifactBrandPreview } from "@saas/shared/components/ArtifactBrandPreview";
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
import { useId, useState } from "react";

type Props = {
	organizationId?: string | null;
	projectId?: string;
	value?: ArtifactBrandSelection;
	outputFormat?: string;
	onChange: (value: ArtifactBrandSelection | undefined) => void;
};
/** Existing report settings own the save; this reviews the brand version they will pin. */
export function ReportBrandingSettings(props: Props) {
	const t = useTranslations("artifactBranding");
	const [open, setOpen] = useState(false);
	const supported = ["MARKDOWN", "HTML", "PDF", "MULTI_FORMAT"].includes(
		props.outputFormat ?? "",
	);
	return (
		<section aria-label={t("title")} className="space-y-3 border-t pt-4">
			<h3 className="font-medium text-sm">{t("title")}</h3>
			<p className="text-muted-foreground text-sm">
				{props.value
					? t("reportSelected", {
							source: t(`source.${props.value.source}`),
							version: props.value.expectedBrandVersion,
						})
					: t("reportUnbranded")}
			</p>
			{!supported && (
				<p className="text-muted-foreground text-xs">
					{t("reportFormatRequired")}
				</p>
			)}
			{!supported && props.value && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => props.onChange(undefined)}
				>
					{t("removeReportTheme")}
				</Button>
			)}
			<Collapsible open={open && supported} onOpenChange={setOpen}>
				<CollapsibleTrigger asChild>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={!supported}
					>
						{t(open ? "closeReview" : "review")}
					</Button>
				</CollapsibleTrigger>
				<CollapsibleContent className="mt-4">
					{open && supported && <ReportBrandingPicker {...props} />}
				</CollapsibleContent>
			</Collapsible>
		</section>
	);
}
function ReportBrandingPicker(props: Props) {
	const { user } = useSession();
	return (
		<ReportBrandingSession
			key={`${props.organizationId}:${props.projectId}:${user?.id ?? "unresolved"}`}
			{...props}
			userId={user?.id}
		/>
	);
}
function ReportBrandingSession({
	organizationId,
	projectId,
	value,
	onChange,
	userId,
}: Props & { userId?: string }) {
	const t = useTranslations("artifactBranding");
	const id = useId();
	const [source, setSource] = useState<ArtifactBrandSource>(
		value?.source ?? "COMPANY",
	);
	const query = useQuery({
		queryKey: [
			"report-branding",
			organizationId,
			projectId ?? null,
			userId,
		],
		queryFn: () =>
			orpcClient.reports.branding.get({
				organizationId: organizationId ?? undefined,
				projectId,
			}),
		enabled: Boolean(organizationId && userId),
		refetchOnWindowFocus: false,
		retry: false,
	});
	const data = query.isError ? undefined : query.data;
	const choice = source === "CLIENT" ? data?.client : data?.company;
	const changed =
		value &&
		choice &&
		source === value.source &&
		value.expectedBrandVersion !== choice.version;
	return (
		<div className="space-y-4">
			<p className="text-muted-foreground text-sm">{t("reportHelp")}</p>
			{query.isPending ? (
				<output className="text-muted-foreground text-sm">
					{t("loading")}
				</output>
			) : query.isError ? (
				<div className="space-y-2">
					<p className="text-destructive text-sm">
						{t("loadFailed")}
					</p>
					<Button
						type="button"
						variant="outline"
						onClick={() => query.refetch()}
					>
						{t("retry")}
					</Button>
				</div>
			) : data ? (
				<>
					<RadioGroup
						value={source}
						onValueChange={(next) => {
							if (next === "COMPANY" || next === "CLIENT") {
								setSource(next);
							}
						}}
						aria-label={t("sourceLabel")}
						className="grid gap-3 sm:grid-cols-2"
					>
						<div className="flex items-center gap-2">
							<RadioGroupItem
								id={`${id}-company`}
								value="COMPANY"
							/>
							<Label htmlFor={`${id}-company`}>
								{t("source.COMPANY")}
							</Label>
						</div>
						<div className="flex items-center gap-2">
							<RadioGroupItem
								id={`${id}-client`}
								value="CLIENT"
								disabled={!data.client?.hasPalette}
							/>
							<Label htmlFor={`${id}-client`}>
								{t("source.CLIENT")}
							</Label>
						</div>
					</RadioGroup>
					{choice && (
						<ArtifactBrandPreview
							value={choice}
							companyName={data.company.name}
							clientName={data.client?.name}
						/>
					)}
					{choice && (
						<p className="text-muted-foreground text-xs">
							{t("brandVersion", { version: choice.version })}
						</p>
					)}
					{changed && (
						<output className="block text-muted-foreground text-sm">
							{t("reportBrandChanged")}
						</output>
					)}
					{!data.client?.hasPalette && (
						<p className="text-muted-foreground text-xs">
							{t(projectId ? "clientMissing" : "noProject")}
						</p>
					)}
					<div className="flex flex-wrap gap-3">
						<Button
							type="button"
							size="sm"
							disabled={
								!choice ||
								query.isFetching ||
								(source === "CLIENT" && !choice.hasPalette)
							}
							onClick={() => {
								if (choice) {
									onChange({
										source,
										expectedBrandVersion: choice.version,
									});
								}
							}}
						>
							{t("useReviewedTheme")}
						</Button>
						{value && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => onChange(undefined)}
							>
								{t("removeReportTheme")}
							</Button>
						)}
					</div>
				</>
			) : null}
		</div>
	);
}
