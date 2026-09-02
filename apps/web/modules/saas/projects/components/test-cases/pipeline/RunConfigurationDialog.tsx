"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Loader2Icon, PlayIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	BROWSER_LABEL,
	BROWSERS,
	type Browser,
	SUGGESTED_RESOLUTIONS,
} from "../../qa-settings/qa-settings-constants";

/**
 * The run-configuration dialog, and the saved configurations it offers.
 *
 * Before this, dispatching was a bare Run button: the environment came from the
 * QA policy and the browser and resolution from whatever that policy listed
 * first, with no way to say "this run, on Firefox, against staging" without
 * editing project settings — and no way to say it twice without repeating
 * yourself.
 *
 * **A configuration says HOW a run executes, never WHICH cases.** The selection
 * stays where the user made it, on the Cases tab. Saving a case list would go
 * stale the moment somebody added a case, and would keep looking like a
 * regression suite while silently no longer covering new work.
 *
 * Every field can be left as "project default", which is the honest option
 * rather than a hidden one: a configuration that pins today's policy values
 * would silently stop tracking the policy.
 */

/** Sentinel — Radix Select cannot hold an empty value. */
const USE_PROJECT_DEFAULT = "__default__";

type RunMode = "MODE_A" | "MODE_B";

export function RunConfigurationDialog({
	projectId,
	open,
	onOpenChange,
	caseCount,
	onDispatch,
	dispatching,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** How many cases the user selected — shown so the dialog states its scope. */
	caseCount: number;
	onDispatch: (overrides: {
		environmentId?: string;
		browser?: Browser;
		resolution?: string;
		runMode: RunMode;
	}) => void;
	dispatching: boolean;
}) {
	const t = useTranslations(
		"projects.stories.maturation.qa.pipelineRuns.runConfiguration",
	);
	const queryClient = useQueryClient();

	const configurationsQuery = useQuery({
		...orpc.projects.agenticRuns.configurations.list.queryOptions({
			input: { projectId },
		}),
		// The list seeds a system row on read, so only ask while the dialog can
		// show it.
		enabled: open,
	});
	const environmentsQuery = useQuery({
		...orpc.projects.environments.list.queryOptions({
			input: { projectId },
		}),
		enabled: open,
	});

	const configurations = configurationsQuery.data ?? [];
	const environments = environmentsQuery.data ?? [];

	const [configurationId, setConfigurationId] = useState<string | null>(null);
	const [environmentId, setEnvironmentId] = useState(USE_PROJECT_DEFAULT);
	const [browser, setBrowser] = useState(USE_PROJECT_DEFAULT);
	const [resolution, setResolution] = useState(USE_PROJECT_DEFAULT);
	const [runMode, setRunMode] = useState<RunMode>("MODE_A");
	const [saveAsName, setSaveAsName] = useState("");

	// Adopt the first configuration once they load, so the dialog opens on a
	// concrete choice rather than an empty picker the user must fill in.
	useEffect(() => {
		if (!open || configurationId || configurations.length === 0) {
			return;
		}
		const first = configurations[0];
		setConfigurationId(first.id);
		setEnvironmentId(first.environmentId ?? USE_PROJECT_DEFAULT);
		setBrowser(
			first.runMode === "MODE_B"
				? "chromium"
				: (first.browser ?? USE_PROJECT_DEFAULT),
		);
		setResolution(first.resolution ?? USE_PROJECT_DEFAULT);
		setRunMode(first.runMode ?? "MODE_A");
	}, [open, configurationId, configurations]);

	const applyConfiguration = (id: string) => {
		const chosen = configurations.find((c) => c.id === id);
		setConfigurationId(id);
		if (chosen) {
			setEnvironmentId(chosen.environmentId ?? USE_PROJECT_DEFAULT);
			setBrowser(
				chosen.runMode === "MODE_B"
					? "chromium"
					: (chosen.browser ?? USE_PROJECT_DEFAULT),
			);
			setResolution(chosen.resolution ?? USE_PROJECT_DEFAULT);
			setRunMode(chosen.runMode ?? "MODE_A");
		}
	};

	const saveMutation = useMutation(
		orpc.projects.agenticRuns.configurations.create.mutationOptions({
			onSuccess: (created) => {
				toast.success(t("saved", { name: created.name }));
				setSaveAsName("");
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.agenticRuns.configurations.list.key(),
				});
				setConfigurationId(created.id);
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	/** Undefined for "project default" — the server then reads the QA policy. */
	const asOverride = (value: string) =>
		value === USE_PROJECT_DEFAULT ? undefined : value;

	const overrides = {
		environmentId: asOverride(environmentId),
		// Narrowed against the closed set rather than cast: the picker can only
		// offer these, but the state is a string and a cast would hide a real
		// mismatch if the two ever drifted apart.
		browser:
			runMode === "MODE_B"
				? "chromium"
				: BROWSERS.find((b) => b === browser),
		resolution: asOverride(resolution),
		runMode,
	};
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>
						{t("description", { count: caseCount })}
					</DialogDescription>
				</DialogHeader>

				{configurationsQuery.isLoading ? (
					<div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
						<Loader2Icon
							className="size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						{t("loading")}
					</div>
				) : (
					<div className="space-y-4">
						{configurations.length > 0 && (
							<div className="space-y-1.5">
								<Label htmlFor="run-configuration">
									{t("savedConfiguration")}
								</Label>
								<Select
									value={configurationId ?? undefined}
									onValueChange={applyConfiguration}
								>
									<SelectTrigger id="run-configuration">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{configurations.map((c) => (
											<SelectItem key={c.id} value={c.id}>
												{c.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}

						<div className="space-y-1.5">
							<Label htmlFor="run-mode">{t("runner")}</Label>
							<Select
								value={runMode}
								onValueChange={(value: RunMode) => {
									setRunMode(value);
									if (value === "MODE_B") {
										setBrowser("chromium");
									}
								}}
							>
								<SelectTrigger id="run-mode">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="MODE_A">
										{t("runnerAgentic")}
									</SelectItem>
									<SelectItem value="MODE_B">
										{t("runnerScripted")}
									</SelectItem>
								</SelectContent>
							</Select>
							<p className="text-muted-foreground text-xs">
								{runMode === "MODE_B"
									? t("runnerHintScripted")
									: t("runnerHintAgentic")}
							</p>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="run-environment">
								{t("environment")}
							</Label>
							<Select
								value={environmentId}
								onValueChange={setEnvironmentId}
							>
								<SelectTrigger id="run-environment">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={USE_PROJECT_DEFAULT}>
										{t("projectDefault")}
									</SelectItem>
									{environments.map((e) => (
										<SelectItem key={e.id} value={e.id}>
											{t("environmentOption", {
												name: e.name,
												type: e.type,
											})}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1.5">
								<Label htmlFor="run-browser">
									{t("browser")}
								</Label>
								<Select
									value={browser}
									onValueChange={setBrowser}
									disabled={runMode === "MODE_B"}
								>
									<SelectTrigger id="run-browser">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={USE_PROJECT_DEFAULT}>
											{t("projectDefault")}
										</SelectItem>
										{BROWSERS.map((b) => (
											<SelectItem key={b} value={b}>
												{BROWSER_LABEL[b]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="run-resolution">
									{t("resolution")}
								</Label>
								<Select
									value={resolution}
									onValueChange={setResolution}
								>
									<SelectTrigger id="run-resolution">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={USE_PROJECT_DEFAULT}>
											{t("projectDefault")}
										</SelectItem>
										{SUGGESTED_RESOLUTIONS.map((r) => (
											<SelectItem key={r} value={r}>
												{r}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>

						<div className="space-y-1.5 border-border border-t pt-3">
							<Label htmlFor="run-save-as">
								{t("saveAs")}{" "}
								<span className="font-normal text-muted-foreground">
									{t("saveAsOptional")}
								</span>
							</Label>
							<div className="flex gap-2">
								<Input
									id="run-save-as"
									value={saveAsName}
									onChange={(e) =>
										setSaveAsName(e.target.value)
									}
									placeholder={t("saveAsPlaceholder")}
								/>
								<Button
									type="button"
									variant="outline"
									disabled={
										saveAsName.trim().length === 0 ||
										saveMutation.isPending
									}
									onClick={() =>
										saveMutation.mutate({
											projectId,
											name: saveAsName.trim(),
											environmentId:
												overrides.environmentId ?? null,
											browser: overrides.browser ?? null,
											resolution:
												overrides.resolution ?? null,
											runMode: overrides.runMode,
										})
									}
								>
									{t("save")}
								</Button>
							</div>
							{/*
							 * Says what a saved configuration does NOT include, because
							 * "save" beside a run dialog reads as "save this run" —
							 * and a saved case list would quietly stop covering cases
							 * added later.
							 */}
							<p className="text-muted-foreground text-xs">
								{t("saveHint")}
							</p>
						</div>
					</div>
				)}

				<DialogFooter>
					<p className="mr-auto text-muted-foreground text-xs">
						{runMode === "MODE_A"
							? t("costHintAgentic")
							: t("costHintScripted")}
					</p>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						{t("cancel")}
					</Button>
					<Button
						type="button"
						disabled={dispatching || caseCount === 0}
						onClick={() => onDispatch(overrides)}
					>
						{dispatching ? (
							<Loader2Icon
								className="mr-1.5 size-3.5 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : (
							<PlayIcon
								className="mr-1.5 size-3.5"
								aria-hidden="true"
							/>
						)}
						{t("start")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
