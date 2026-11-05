"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { Alert, AlertDescription } from "@ui/components/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
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
import { useEffect, useId, useRef, useState } from "react";
import { getOrpcCode } from "./field-mapping/orpc-error";

type Configuration = Awaited<
	ReturnType<typeof orpcClient.contextQuality.bindings.get>
>;
type Operation = "save" | "disable" | "delete";

function errorKey(error: unknown, operation: Operation) {
	switch (getOrpcCode(error)) {
		case "FORBIDDEN":
		case "UNAUTHORIZED":
			return "errorDenied";
		case "NOT_FOUND":
			return "errorUnavailable";
		case "BAD_REQUEST":
			return "errorInvalid";
		case "CONFLICT":
			return operation === "delete" ? "deleteBlocked" : "errorConflict";
		case "PRECONDITION_FAILED":
			if (operation === "save") return "errorQualification";
	}
	return operation === "save"
		? "saveError"
		: operation === "disable"
			? "disableError"
			: "deleteError";
}

function validResourceId(value: string) {
	return (
		/^[1-9][0-9]*$/.test(value.trim()) &&
		Number.isSafeInteger(Number(value.trim()))
	);
}

interface Props {
	projectId: string;
	organizationId: string;
	onSaved: () => void;
}
/** Existing Quality dialog's administrator settings; credentials stay in Connections. */
export function ContextQualitySettings(props: Props) {
	return (
		<Settings
			key={JSON.stringify([props.projectId, props.organizationId])}
			{...props}
		/>
	);
}
function Settings({ projectId, organizationId, onSaved }: Props) {
	const t = useTranslations("projects.contexts.quality.setup");
	const id = useId();
	const mounted = useRef(true);
	const [data, setData] = useState<Configuration | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState(false);
	const [operationError, setOperationError] = useState<
		ReturnType<typeof errorKey> | "invalidIds" | null
	>(null);
	const [status, setStatus] = useState<"saved" | "disabled" | null>(null);
	const [busy, setBusy] = useState<Operation | null>(null);
	const pending = useRef(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [approved, setApproved] = useState(false);
	const [enabled, setEnabled] = useState(true);
	const [integrationId, setIntegrationId] = useState("");
	const [workspaceOrigin, setWorkspaceOrigin] = useState("");
	const [jobId, setJobId] = useState("");
	const [experimentId, setExperimentId] = useState("");
	const [volumeRoot, setVolumeRoot] = useState("");
	const [reload, setReload] = useState(0);
	useEffect(() => {
		mounted.current = true;
		let active = true;
		setLoading(true);
		setLoadError(false);
		setOperationError(null);
		setStatus(null);
		setApproved(false);
		void orpcClient.contextQuality.bindings
			.get({ projectId, organizationId })
			.then((result) => {
				if (!active) return;
				setData(result);
				const binding = result.binding;
				setIntegrationId(binding?.integrationId ?? "");
				setWorkspaceOrigin(binding?.workspaceOrigin ?? "");
				setJobId(binding?.jobId ?? "");
				setExperimentId(binding?.experimentId ?? "");
				setVolumeRoot(binding?.volumeRoot ?? "");
				setEnabled(binding?.enabled ?? true);
			})
			.catch(() => {
				if (active) setLoadError(true);
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
			mounted.current = false;
		};
	}, [projectId, organizationId, reload]);
	function changed() {
		setApproved(false);
		setStatus(null);
		setOperationError(null);
	}
	async function save(event: React.FormEvent) {
		event.preventDefault();
		if (
			pending.current ||
			deleteOpen ||
			!data ||
			(enabled ? !approved || !integrationId : !data.binding)
		)
			return;
		setOperationError(null);
		setStatus(null);
		if (
			enabled &&
			(!validResourceId(jobId) || !validResourceId(experimentId))
		) {
			setOperationError("invalidIds");
			return;
		}
		const operation = enabled ? "save" : "disable";
		pending.current = true;
		setBusy(operation);
		try {
			const result = enabled
				? await orpcClient.contextQuality.bindings.save({
						projectId,
						organizationId,
						integrationId,
						workspaceOrigin: workspaceOrigin.trim(),
						jobId: jobId.trim(),
						experimentId: experimentId.trim(),
						volumeRoot: volumeRoot.trim(),
						exportApproved: true,
						enabled: true,
					})
				: await orpcClient.contextQuality.bindings.disable({
						projectId,
						organizationId,
					});
			if (!mounted.current) return;
			setData(result);
			setStatus(enabled ? "saved" : "disabled");
			setApproved(false);
			onSaved();
		} catch (error) {
			if (mounted.current) setOperationError(errorKey(error, operation));
		} finally {
			if (mounted.current) {
				pending.current = false;
				setBusy(null);
			}
		}
	}
	async function disconnect() {
		if (pending.current || !data?.binding || !deleteOpen) return;
		pending.current = true;
		setBusy("delete");
		setOperationError(null);
		setStatus(null);
		try {
			await orpcClient.contextQuality.bindings.delete({
				projectId,
				organizationId,
				confirmHistoryDeletion: true,
			});
			if (!mounted.current) return;
			setDeleteOpen(false);
			setReload((value) => value + 1);
			onSaved();
		} catch (error) {
			if (mounted.current) setOperationError(errorKey(error, "delete"));
		} finally {
			if (mounted.current) {
				pending.current = false;
				setBusy(null);
			}
		}
	}
	if (loading)
		return (
			<p
				role="status"
				className="flex items-center gap-2 text-sm text-muted-foreground"
			>
				<Loader2Icon className="size-4 animate-spin" aria-hidden />
				{t("loading")}
			</p>
		);
	if (loadError)
		return (
			<Alert variant="error">
				<AlertDescription>
					{t("error")}{" "}
					<Button
						type="button"
						variant="link"
						onClick={() => setReload((n) => n + 1)}
					>
						{t("retry")}
					</Button>
				</AlertDescription>
			</Alert>
		);
	return (
		<form onSubmit={save} className="space-y-4" aria-busy={busy !== null}>
			<p className="text-sm text-muted-foreground">{t("description")}</p>
			{operationError && !deleteOpen && (
				<Alert variant="error">
					<AlertDescription>{t(operationError)}</AlertDescription>
				</Alert>
			)}
			{status && (
				<p role="status" className="text-sm text-success">
					{t(status)}
				</p>
			)}
			{data?.connections.length === 0 && (
				<Alert>
					<AlertDescription>{t("noConnections")}</AlertDescription>
				</Alert>
			)}
			<fieldset
				className="space-y-4"
				disabled={busy !== null || deleteOpen}
			>
				<div className="space-y-2">
					<Label htmlFor={`${id}-connection`}>
						{t("connection")}
					</Label>
					<Select
						value={integrationId}
						onValueChange={(v) => {
							setIntegrationId(v);
							changed();
						}}
						disabled={!enabled || busy !== null || deleteOpen}
					>
						<SelectTrigger id={`${id}-connection`}>
							<SelectValue placeholder={t("select")} />
						</SelectTrigger>
						<SelectContent>
							{data?.connections.map((connection) => (
								<SelectItem
									key={connection.id}
									value={connection.id}
								>
									{connection.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-2">
					<Label htmlFor={`${id}-workspace`}>{t("workspace")}</Label>
					<Input
						id={`${id}-workspace`}
						type="url"
						required={enabled}
						disabled={!enabled}
						value={workspaceOrigin}
						placeholder="https://example.cloud.databricks.com"
						onChange={(e) => {
							setWorkspaceOrigin(e.target.value);
							changed();
						}}
					/>
				</div>
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor={`${id}-job`}>{t("job")}</Label>
						<Input
							id={`${id}-job`}
							inputMode="numeric"
							pattern={enabled ? "[1-9][0-9]{0,15}" : undefined}
							required={enabled}
							disabled={!enabled}
							value={jobId}
							onChange={(e) => {
								setJobId(e.target.value);
								changed();
							}}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${id}-experiment`}>
							{t("experiment")}
						</Label>
						<Input
							id={`${id}-experiment`}
							inputMode="numeric"
							pattern={enabled ? "[1-9][0-9]{0,15}" : undefined}
							required={enabled}
							disabled={!enabled}
							value={experimentId}
							onChange={(e) => {
								setExperimentId(e.target.value);
								changed();
							}}
						/>
					</div>
				</div>
				<div className="space-y-2">
					<Label htmlFor={`${id}-volume`}>{t("volume")}</Label>
					<Input
						id={`${id}-volume`}
						required={enabled}
						disabled={!enabled}
						value={volumeRoot}
						placeholder="/Volumes/example_catalog/example_schema/example_volume"
						onChange={(e) => {
							setVolumeRoot(e.target.value);
							changed();
						}}
					/>
					<p className="text-xs text-muted-foreground">
						{t("resources")}
					</p>
				</div>
				<div className="flex items-start gap-2">
					<Checkbox
						id={`${id}-enabled`}
						checked={enabled}
						onCheckedChange={(v) => {
							setEnabled(v === true);
							changed();
						}}
					/>
					<Label htmlFor={`${id}-enabled`}>{t("enabled")}</Label>
				</div>
				<div className="flex items-start gap-2">
					<Checkbox
						id={`${id}-approval`}
						checked={approved}
						disabled={!enabled}
						onCheckedChange={(v) => {
							setApproved(v === true);
							setStatus(null);
							setOperationError(null);
						}}
					/>
					<Label
						htmlFor={`${id}-approval`}
						className="leading-relaxed"
					>
						{t("approval")}
					</Label>
				</div>
			</fieldset>
			<Button
				type="submit"
				formNoValidate={!enabled}
				disabled={
					busy !== null ||
					deleteOpen ||
					(enabled ? !approved || !integrationId : !data?.binding)
				}
			>
				{(busy === "save" || busy === "disable") && (
					<Loader2Icon className="size-4 animate-spin" aria-hidden />
				)}
				{enabled
					? t(busy === "save" ? "saving" : "save")
					: t(busy === "disable" ? "disabling" : "disable")}
			</Button>
			{data?.binding && (
				<AlertDialog
					open={deleteOpen}
					onOpenChange={(open) => {
						if (!pending.current) {
							setDeleteOpen(open);
							if (open) {
								setOperationError(null);
								setStatus(null);
							}
						}
					}}
				>
					<AlertDialogTrigger asChild>
						<Button
							type="button"
							variant="destructive"
							disabled={busy !== null}
						>
							{t("disconnect")}
						</Button>
					</AlertDialogTrigger>
					<AlertDialogContent aria-busy={busy === "delete"}>
						<AlertDialogHeader>
							<AlertDialogTitle>
								{t("deleteTitle")}
							</AlertDialogTitle>
							<AlertDialogDescription>
								{t("deleteDescription")}
							</AlertDialogDescription>
						</AlertDialogHeader>
						{operationError && (
							<Alert variant="error">
								<AlertDescription>
									{t(operationError)}
								</AlertDescription>
							</Alert>
						)}
						<AlertDialogFooter>
							<AlertDialogCancel disabled={busy !== null}>
								{t("cancel")}
							</AlertDialogCancel>
							<AlertDialogAction
								variant="destructive"
								disabled={busy !== null}
								onClick={(event) => {
									event.preventDefault();
									void disconnect();
								}}
							>
								{busy === "delete" && (
									<Loader2Icon
										className="size-4 animate-spin"
										aria-hidden
									/>
								)}
								{t(
									busy === "delete"
										? "deleting"
										: "confirmDelete",
								)}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</form>
	);
}
