"use client";

/**
 * Publish Workflow Dialog
 * Dialog for publishing workflows with options for webhooks and versioning
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import {
	CheckCircle2Icon,
	CopyIcon,
	GlobeIcon,
	Loader2Icon,
	RocketIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

interface PublishDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workflowId: string;
	workflowName: string;
	currentVersion: number;
	status: "DRAFT" | "PUBLISHED" | "ACTIVE" | "PAUSED" | "ARCHIVED";
	onPublished?: () => void;
}

export function PublishDialog({
	open,
	onOpenChange,
	workflowId,
	workflowName,
	currentVersion,
	status,
	onPublished,
}: PublishDialogProps) {
	const [changelog, setChangelog] = useState("");
	const [enableWebhook, setEnableWebhook] = useState(false);
	const [publishResult, setPublishResult] = useState<{
		version: number;
		webhookUrl?: string;
		webhookSecret?: string;
	} | null>(null);
	const [validationErrors, setValidationErrors] = useState<string[] | null>(
		null,
	);

	const queryClient = useQueryClient();

	const publishMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.workflows.publish.publish({
				workflowId,
				changelog: changelog || undefined,
				enableWebhook,
			});
		},
		onSuccess: (data) => {
			// A refused publish resolves rather than throws: the procedure
			// answers `success: false` with the validation errors and no
			// version. Treating every resolved mutation as a publish rendered
			// "Workflow Published! Version 1 is now live" over a workflow that
			// was still a draft, with no webhook URL and no secret to copy —
			// and the commonest way to get here is publishing before saving,
			// where the stored graph is still empty.
			if (!data.success) {
				setValidationErrors(
					data.validation.errors.length > 0
						? data.validation.errors
						: ["Publishing was refused."],
				);
				return;
			}

			setValidationErrors(null);
			setPublishResult({
				version: data.version,
				webhookUrl: data.webhookUrl,
				webhookSecret: data.webhookSecret,
			});
			queryClient.invalidateQueries({
				queryKey: ["workflow", workflowId],
			});
			queryClient.invalidateQueries({ queryKey: ["workflows"] });
			onPublished?.();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to publish workflow",
			);
		},
	});

	const unpublishMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.workflows.publish.unpublish({ workflowId });
		},
		onSuccess: () => {
			toast.success("Workflow unpublished");
			queryClient.invalidateQueries({
				queryKey: ["workflow", workflowId],
			});
			queryClient.invalidateQueries({ queryKey: ["workflows"] });
			onOpenChange(false);
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to unpublish workflow",
			);
		},
	});

	const handlePublish = useCallback(() => {
		setValidationErrors(null);
		publishMutation.mutate();
	}, [publishMutation]);

	const handleUnpublish = useCallback(() => {
		unpublishMutation.mutate();
	}, [unpublishMutation]);

	const copyToClipboard = useCallback((text: string, label: string) => {
		navigator.clipboard.writeText(text);
		toast.success(`${label} copied to clipboard`);
	}, []);

	const handleClose = useCallback(() => {
		setPublishResult(null);
		setValidationErrors(null);
		setChangelog("");
		setEnableWebhook(false);
		onOpenChange(false);
	}, [onOpenChange]);

	const isPublished = status === "PUBLISHED" || status === "ACTIVE";

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-[500px]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<RocketIcon className="h-5 w-5" />
						{isPublished
							? "Manage Published Workflow"
							: "Publish Workflow"}
					</DialogTitle>
					<DialogDescription>
						{isPublished
							? "This workflow is currently published and can be triggered externally."
							: "Publishing makes this workflow available for external triggers."}
					</DialogDescription>
				</DialogHeader>

				{publishResult ? (
					// Success state
					<div className="space-y-4 py-4">
						<div className="flex items-center gap-3 p-4 rounded-lg bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800">
							<CheckCircle2Icon className="h-8 w-8 text-success" />
							<div>
								<p className="font-medium text-green-700 dark:text-green-300">
									Workflow Published!
								</p>
								<p className="text-sm text-success dark:text-green-400">
									Version {publishResult.version} is now live
								</p>
							</div>
						</div>

						{publishResult.webhookUrl && (
							<div className="space-y-3">
								<div>
									<Label className="text-sm font-medium">
										Webhook URL
									</Label>
									<div className="flex items-center gap-2 mt-1">
										<Input
											value={publishResult.webhookUrl}
											readOnly
											className="font-mono text-sm"
										/>
										<Button
											variant="outline"
											size="icon"
											onClick={() =>
												copyToClipboard(
													// biome-ignore lint/style/noNonNullAssertion: webhookUrl is present when webhook is configured
													publishResult.webhookUrl!,
													"Webhook URL",
												)
											}
										>
											<CopyIcon className="h-4 w-4" />
										</Button>
									</div>
								</div>

								{publishResult.webhookSecret && (
									<div>
										<Label className="text-sm font-medium">
											Webhook Secret
										</Label>
										<p className="text-xs text-muted-foreground mb-1">
											Use this to verify webhook
											signatures. Keep it secret!
										</p>
										<div className="flex items-center gap-2 mt-1">
											<Input
												value={
													publishResult.webhookSecret
												}
												readOnly
												type="password"
												className="font-mono text-sm"
											/>
											<Button
												variant="outline"
												size="icon"
												onClick={() =>
													copyToClipboard(
														// biome-ignore lint/style/noNonNullAssertion: webhookSecret is present when webhook is configured
														publishResult.webhookSecret!,
														"Webhook secret",
													)
												}
											>
												<CopyIcon className="h-4 w-4" />
											</Button>
										</div>
									</div>
								)}
							</div>
						)}
					</div>
				) : (
					// Form state
					<div className="space-y-4 py-4">
						{validationErrors && (
							<div
								className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
								role="alert"
							>
								<p className="font-medium text-destructive text-sm">
									Not published — the workflow did not pass
									validation
								</p>
								<ul className="list-disc space-y-1 pl-5 text-muted-foreground text-sm">
									{validationErrors.map((error) => (
										<li key={error}>{error}</li>
									))}
								</ul>
								<p className="text-muted-foreground text-xs">
									Publishing uses the last saved graph. Save
									your changes, then publish again.
								</p>
							</div>
						)}

						{/* Current status */}
						<div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
							<div>
								<p className="font-medium">{workflowName}</p>
								<p className="text-sm text-muted-foreground">
									Current version: {currentVersion}
								</p>
							</div>
							<Badge
								variant={isPublished ? "default" : "secondary"}
								className={cn(
									isPublished &&
										"bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
								)}
							>
								{status}
							</Badge>
						</div>

						{!isPublished && (
							<>
								{/* New version info */}
								<div className="text-sm text-muted-foreground">
									Publishing will create version{" "}
									<span className="font-medium">
										{currentVersion + 1}
									</span>
								</div>

								{/* Changelog */}
								<div className="space-y-2">
									<Label htmlFor="changelog">
										Changelog (optional)
									</Label>
									<Textarea
										id="changelog"
										placeholder="Describe what changed in this version..."
										value={changelog}
										onChange={(e) =>
											setChangelog(e.target.value)
										}
										rows={3}
									/>
								</div>

								{/* Webhook toggle */}
								<div className="flex items-start space-x-3 p-3 rounded-lg border">
									<Checkbox
										id="enable-webhook"
										checked={enableWebhook}
										onCheckedChange={(checked) =>
											setEnableWebhook(checked === true)
										}
									/>
									<div className="space-y-1">
										<Label
											htmlFor="enable-webhook"
											className="flex items-center gap-2 cursor-pointer"
										>
											<GlobeIcon className="h-4 w-4" />
											Enable Webhook Trigger
										</Label>
										<p className="text-sm text-muted-foreground">
											Allow this workflow to be triggered
											via HTTP POST requests
										</p>
									</div>
								</div>
							</>
						)}
					</div>
				)}

				<DialogFooter>
					{publishResult ? (
						<Button onClick={handleClose}>Done</Button>
					) : isPublished ? (
						<>
							<Button variant="outline" onClick={handleClose}>
								Cancel
							</Button>
							<Button
								variant="destructive"
								onClick={handleUnpublish}
								disabled={unpublishMutation.isPending}
							>
								{unpublishMutation.isPending && (
									<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
								)}
								Unpublish
							</Button>
							<Button
								onClick={handlePublish}
								disabled={publishMutation.isPending}
							>
								{publishMutation.isPending && (
									<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
								)}
								Publish New Version
							</Button>
						</>
					) : (
						<>
							<Button variant="outline" onClick={handleClose}>
								Cancel
							</Button>
							<Button
								onClick={handlePublish}
								disabled={publishMutation.isPending}
							>
								{publishMutation.isPending && (
									<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
								)}
								<RocketIcon className="mr-2 h-4 w-4" />
								Publish
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
