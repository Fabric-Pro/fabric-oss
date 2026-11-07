"use client";

import type { ArtifactBrandSnapshot } from "@repo/utils/artifact-brand-snapshot";
import type { FramePresentation } from "@repo/utils/frame-presentation";
import { useSession } from "@saas/auth/hooks/use-session";
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
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { downloadHref } from "../lib/download-file";

type Props = {
	frameId: string;
	organizationId: string;
	updatedAt: string | Date;
	title: string;
	kind: "frame" | "slideshow";
	open: boolean;
	onOpenChange: (open: boolean) => void;
	branding?: ArtifactBrandSnapshot | null;
	presentation?: FramePresentation;
	supportsNativePdf?: boolean;
};
type Job = {
	exportId: string;
	status: string;
	expectedUpdatedAt: string;
	expiresAt?: string;
	error?: string;
};

/** Keep job state across closing/reopening, but never across actor changes. */
export function FrameExportDialog(props: Props) {
	const { user } = useSession();
	return (
		<FrameExportSession
			key={`${props.frameId}:${props.organizationId}:${user?.id ?? "unresolved"}`}
			{...props}
			userId={user?.id}
		/>
	);
}

function FrameExportSession({
	frameId,
	organizationId,
	updatedAt,
	title,
	kind,
	open,
	onOpenChange,
	userId,
	branding,
	presentation = "DOCUMENT",
	supportsNativePdf = true,
}: Props & { userId?: string }) {
	const t = useTranslations("frameExport");
	const tBrand = useTranslations("artifactBranding");
	const queryClient = useQueryClient();
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const jobKey = (exportId: string) => [
		"frame-export",
		organizationId,
		userId,
		frameId,
		exportId,
	];
	const [requestId, setRequestId] = useState(() => crypto.randomUUID());
	const [job, setJob] = useState<Job | null>(null);
	const [jobBranding, setJobBranding] =
		useState<ArtifactBrandSnapshot | null>(null);
	const [jobPresentation, setJobPresentation] =
		useState<FramePresentation>("DOCUMENT");
	const [busy, setBusy] = useState<"start" | "cancel" | "download" | null>(
		null,
	);
	const [error, setError] = useState<
		"startError" | "cancelError" | "downloadError" | null
	>(null);
	const [cancelRequested, setCancelRequested] = useState(false);
	const revision = new Date(updatedAt).toISOString();
	const active = job?.status === "pending" || job?.status === "running";
	const status = useQuery({
		queryKey: [
			"frame-export",
			organizationId,
			userId,
			frameId,
			job?.exportId,
		],
		queryFn: () => {
			if (!job) {
				throw new Error("Export is unavailable");
			}
			return orpcClient.frames.getExport({
				id: frameId,
				organizationId,
				exportId: job.exportId,
			});
		},
		enabled:
			open &&
			Boolean(userId) &&
			Boolean(job?.exportId) &&
			Boolean(active),
		refetchInterval: (query) =>
			open &&
			["pending", "running"].includes(
				query.state.data?.status ?? job?.status ?? "",
			)
				? 1500
				: false,
		retry: false,
	});
	const current = status.data?.exportId === job?.exportId ? status.data : job;
	const terminal =
		current && !["pending", "running"].includes(current.status);
	const reviewedBranding = job ? jobBranding : branding;
	const reviewedPresentation = job ? jobPresentation : presentation;
	const start = async () => {
		if (busy || !userId || !supportsNativePdf) {
			return;
		}
		setBusy("start");
		setError(null);
		try {
			const result = await orpcClient.frames.startExport({
				id: frameId,
				organizationId,
				expectedUpdatedAt: revision,
				requestId,
				orientation: kind === "slideshow" ? "landscape" : "portrait",
			});
			if (!mounted.current) {
				return;
			}
			setJob(result);
			setJobBranding(branding ?? null);
			setJobPresentation(presentation);
			queryClient.setQueryData(jobKey(result.exportId), result);
			setCancelRequested(false);
		} catch {
			setError("startError");
		} finally {
			setBusy(null);
		}
	};
	const cancel = async () => {
		if (busy || !job) {
			return;
		}
		setBusy("cancel");
		setError(null);
		try {
			const result = await orpcClient.frames.cancelExport({
				id: frameId,
				organizationId,
				exportId: job.exportId,
			});
			if (!mounted.current) {
				return;
			}
			setJob(result);
			queryClient.setQueryData(jobKey(result.exportId), result);
			setCancelRequested(
				result.status === "pending" || result.status === "running",
			);
			if (result.status === "pending" || result.status === "running") {
				await status.refetch();
			}
		} catch {
			setError("cancelError");
		} finally {
			setBusy(null);
		}
	};
	const download = async () => {
		if (busy || !job) {
			return;
		}
		setBusy("download");
		setError(null);
		try {
			const result = await orpcClient.frames.downloadExport({
				id: frameId,
				organizationId,
				exportId: job.exportId,
			});
			if (mounted.current) {
				downloadHref(result.url, `${title || "frame"}.pdf`);
			}
		} catch {
			setError("downloadError");
		} finally {
			setBusy(null);
		}
	};
	const displayedStatus = current?.status;
	const statusKey =
		displayedStatus &&
		[
			"pending",
			"running",
			"completed",
			"failed",
			"cancelled",
			"expired",
		].includes(displayedStatus)
			? displayedStatus
			: null;
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!busy) {
					onOpenChange(value);
				}
			}}
		>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>
						{t("description", { title })}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3 text-sm">
					<p>{t("staticCopy")}</p>
					{!job && !supportsNativePdf && (
						<p className="text-muted-foreground">
							{t("interfaceBlockLimit")}
						</p>
					)}
					<p className="text-muted-foreground">
						{reviewedPresentation === "INTERFACE"
							? t("interfaceCopy")
							: reviewedBranding
								? tBrand("exportTheme", {
										source: tBrand(
											`source.${reviewedBranding.source}`,
										),
										heading:
											reviewedBranding.displayFontFamily,
										body: reviewedBranding.bodyFontFamily,
										cover: tBrand(
											`cover.${reviewedBranding.coverStyle}`,
										),
									})
								: tBrand("exportUnbranded")}
					</p>
					{job && job.expectedUpdatedAt !== revision && (
						<p className="text-muted-foreground">
							{tBrand("exportOlderRevision")}
						</p>
					)}
					{!userId && <p role="alert">{t("signIn")}</p>}
					{statusKey && (
						<output className="block font-medium">
							{t(statusKey)}
						</output>
					)}
					{active && !terminal && (
						<p className="text-muted-foreground">
							{t(cancelRequested ? "cancelling" : "canClose")}
						</p>
					)}
					{current?.expiresAt && current.status === "completed" && (
						<p className="text-muted-foreground">
							{t("expires", {
								date: new Date(
									current.expiresAt,
								).toLocaleString(),
							})}
						</p>
					)}
					{error && (
						<p role="alert" className="text-destructive">
							{t(error)}
						</p>
					)}
					{status.isError && !terminal && (
						<div role="alert" className="space-y-2">
							<p>{t("statusError")}</p>
							<Button
								variant="outline"
								onClick={() => status.refetch()}
							>
								{t("retryStatus")}
							</Button>
						</div>
					)}
				</div>
				<DialogFooter className="flex-wrap gap-2">
					<Button
						variant="outline"
						disabled={Boolean(busy)}
						onClick={() => onOpenChange(false)}
					>
						{t("close")}
					</Button>
					{!job && (
						<Button
							disabled={
								Boolean(busy) || !userId || !supportsNativePdf
							}
							onClick={start}
						>
							{t(
								busy === "start"
									? "starting"
									: error === "startError"
										? "retryStart"
										: "create",
							)}
						</Button>
					)}
					{active && !terminal && (
						<Button
							variant="outline"
							disabled={Boolean(busy) || cancelRequested}
							onClick={cancel}
						>
							{t(
								busy === "cancel" || cancelRequested
									? "cancelling"
									: "cancel",
							)}
						</Button>
					)}
					{current?.status === "completed" && (
						<Button disabled={Boolean(busy)} onClick={download}>
							{t(
								busy === "download"
									? "downloading"
									: "download",
							)}
						</Button>
					)}
					{terminal && current?.status !== "completed" && (
						<Button
							disabled={Boolean(busy)}
							onClick={() => {
								setJob(null);
								setRequestId(crypto.randomUUID());
								setCancelRequested(false);
								setError(null);
							}}
						>
							{t("newExport")}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
