"use client";

import type { ArtifactBrandSource } from "@repo/utils/artifact-brand-theme";
import { useSession } from "@saas/auth/hooks/use-session";
import { ArtifactBrandPreview } from "@saas/shared/components/ArtifactBrandPreview";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

type Props = {
	frameId: string;
	organizationId: string;
	updatedAt: string | Date;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};
export function FrameBrandingDialog(props: Props) {
	const { user } = useSession();
	return (
		<FrameBrandingSession
			key={`${props.frameId}:${props.organizationId}:${user?.id ?? "unresolved"}`}
			{...props}
			userId={user?.id}
		/>
	);
}
function FrameBrandingSession({
	frameId,
	organizationId,
	updatedAt,
	open,
	onOpenChange,
	userId,
}: Props & { userId?: string }) {
	const t = useTranslations("artifactBranding");
	const id = useId();
	const queryClient = useQueryClient();
	const queryKey = ["frame-branding", frameId, organizationId, userId];
	const query = useQuery({
		queryKey,
		queryFn: () =>
			orpcClient.frames.branding.get({ id: frameId, organizationId }),
		enabled: open && Boolean(userId),
		refetchOnWindowFocus: false,
		retry: false,
	});
	const [selection, setSelection] = useState<ArtifactBrandSource | null>(
		null,
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<"applyFailed" | "changed" | null>(null);
	const data = query.isError ? undefined : query.data;
	const source = selection ?? data?.current?.source ?? "COMPANY";
	const choice = source === "CLIENT" ? data?.client : data?.company;
	const outdated =
		data && data.frameUpdatedAt !== new Date(updatedAt).toISOString();
	const missingClient = source === "CLIENT" && !choice?.hasPalette;
	const apply = async () => {
		if (
			!data ||
			!choice ||
			!data.canApply ||
			busy ||
			outdated ||
			missingClient
		) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await orpcClient.frames.branding.apply({
				id: frameId,
				organizationId,
				source,
				expectedBrandVersion: choice.version,
				expectedUpdatedAt: data.frameUpdatedAt,
			});
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: ["frame", frameId, organizationId, userId],
				}),
				queryClient.invalidateQueries({
					queryKey: ["frames", organizationId],
				}),
				queryClient.invalidateQueries({ queryKey }),
			]);
			onOpenChange(false);
		} catch (failure) {
			const conflict =
				failure &&
				typeof failure === "object" &&
				"code" in failure &&
				failure.code === "CONFLICT";
			setError(conflict ? "changed" : "applyFailed");
			if (conflict) {
				await query.refetch();
			}
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!busy) {
					onOpenChange(next);
				}
			}}
		>
			<DialogContent className="flex max-w-xl flex-col overflow-hidden">
				<DialogHeader className="shrink-0">
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("frameHelp")}</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
					{query.isPending ? (
						<output className="text-muted-foreground text-sm">
							{t("loading")}
						</output>
					) : query.isError ? (
						<div className="space-y-3">
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
						<div className="space-y-4">
							<p className="text-muted-foreground text-xs">
								{data.current
									? t("current", {
											source: t(
												`source.${data.current.source}`,
											),
										})
									: t("unbranded")}
							</p>
							<RadioGroup
								value={source}
								onValueChange={(next) => {
									if (
										next === "COMPANY" ||
										next === "CLIENT"
									) {
										setSelection(next);
										setError(null);
									}
								}}
								disabled={busy || !data.canApply}
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
									{t("brandVersion", {
										version: choice.version,
									})}
								</p>
							)}
							{!data.client?.hasPalette && (
								<p className="text-muted-foreground text-xs">
									{t(
										data.projectId
											? "clientMissing"
											: "noProject",
									)}
								</p>
							)}
							{data.blockedReason && (
								<p className="text-muted-foreground text-sm">
									{t(`blocked.${data.blockedReason}`)}
								</p>
							)}
							{outdated && (
								<div className="space-y-2">
									<p className="text-muted-foreground text-sm">
										{t("contentChanged")}
									</p>
									<Button
										type="button"
										variant="outline"
										onClick={async () => {
											await queryClient.invalidateQueries(
												{
													queryKey: [
														"frame",
														frameId,
														organizationId,
														userId,
													],
												},
											);
											onOpenChange(false);
										}}
									>
										{t("reloadFrame")}
									</Button>
								</div>
							)}
						</div>
					) : null}
					{error && (
						<p role="alert" className="text-destructive text-sm">
							{t(error)}
						</p>
					)}
				</div>
				<DialogFooter className="shrink-0 border-t pt-4">
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() => onOpenChange(false)}
					>
						{t("cancel")}
					</Button>
					<Button
						type="button"
						loading={busy}
						disabled={
							!data?.canApply ||
							!choice ||
							Boolean(outdated) ||
							missingClient ||
							query.isFetching
						}
						onClick={apply}
					>
						{t("apply")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
