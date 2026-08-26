"use client";

import type { ProjectEnvironmentType } from "@repo/database";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
	CheckIcon,
	KeyRoundIcon,
	Loader2Icon,
	PencilIcon,
	PlusIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EnvironmentCredentialForm } from "./EnvironmentCredentialForm";

/**
 * The type comes from the SCHEMA; the list is derived from the exhaustive label
 * map below.
 *
 * Two footguns avoided at once. A hand-written union plus an `as EnvironmentType`
 * cast at the seed site compiles while the two happen to agree, so a fourth
 * schema value would coerce silently, leave the Select showing nothing, and ship
 * an unrecognised string into a request the server rejects — failing an edit the
 * user never touched. But importing the enum as a VALUE would drag the Prisma
 * client into the browser bundle, which `tsc` does not catch and only a real
 * build would. So: `import type` (erased), and `Record<EnvironmentType, string>`
 * on TYPE_LABEL makes a new schema value a compile error here.
 */
type EnvironmentType = ProjectEnvironmentType;

const TYPE_LABEL: Record<EnvironmentType, string> = {
	STAGING: "Staging",
	QA: "QA",
	PRODUCTION: "Production",
};

/** Derived from the exhaustive map, so the two can never list different types. */
const ENVIRONMENT_TYPES = Object.keys(TYPE_LABEL) as EnvironmentType[];

/**
 * Settings ▸ Environments — the project's deployment targets.
 *
 * These are defined once here and referenced by id everywhere else (the QA
 * policy's default target, and the environment picker when a run is dispatched),
 * so a base URL has exactly one source of truth. Deleting a target clears any
 * QA policy pointing at it rather than leaving a dangling reference.
 */
export function ProjectEnvironmentsSettings({
	projectId,
	canEdit,
}: {
	projectId: string;
	canEdit: boolean;
}) {
	const queryClient = useQueryClient();
	const { confirm } = useConfirmationAlert();
	const [draft, setDraft] = useState<{
		type: EnvironmentType;
		name: string;
		baseUrl: string;
	}>({ type: "STAGING", name: "", baseUrl: "" });
	// Per-row Edit buttons, so focus can be handed back to the one that opened
	// the editor. Without this, Cancel/Save unmounts the focused control and the
	// browser drops focus to <body> — a keyboard user is stranded mid-task.
	//
	// The hand-back cannot be a synchronous `.focus()` in the click handler: while
	// a row is being edited its Edit button is NOT mounted, so the ref holds null
	// at that moment. It has to wait for the re-render that brings the button
	// back, which is what `restoreFocusTo` is for.
	const editButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
	const [restoreFocusTo, setRestoreFocusTo] = useState<string | null>(null);
	// Only the row being edited holds a draft. An unsaved edit on one target must
	// not follow the user to another row, and a refetch must not clobber typing —
	// the same rule the pipeline-sources panel follows.
	const [editing, setEditing] = useState<{
		id: string;
		type: EnvironmentType;
		name: string;
		baseUrl: string;
	} | null>(null);

	const listQuery = useQuery(
		orpc.projects.environments.list.queryOptions({ input: { projectId } }),
	);
	// Redacted summaries only — whether a secret exists and when it was written.
	// There is no query anywhere that returns the value.
	const credentialsQuery = useQuery(
		orpc.projects.environments.credentials.list.queryOptions({
			input: { projectId },
		}),
	);
	/** Which row has its credential editor open. One at a time, by design. */
	const [credentialFor, setCredentialFor] = useState<string | null>(null);

	const invalidate = () => {
		queryClient.invalidateQueries({
			queryKey: orpc.projects.environments.list.key(),
		});
		// The QA policy renders these as its run targets, so it must re-read too.
		queryClient.invalidateQueries({
			queryKey: orpc.projects.qaSettings.get.key(),
		});
	};

	const createMutation = useMutation(
		orpc.projects.environments.create.mutationOptions({
			onSuccess: () => {
				toast.success("Environment added");
				setDraft({ type: "STAGING", name: "", baseUrl: "" });
				invalidate();
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const updateMutation = useMutation(
		orpc.projects.environments.update.mutationOptions({
			// `variables`, not the closed-over `editing`: the id that was saved
			// is the one to hand focus back to, and reading it from the request
			// cannot go stale.
			onSuccess: (_data, variables) => {
				toast.success("Environment updated");
				setEditing(null);
				setRestoreFocusTo(variables.environmentId);
				invalidate();
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const deleteMutation = useMutation(
		orpc.projects.environments.delete.mutationOptions({
			onSuccess: () => {
				toast.success("Environment removed");
				invalidate();
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const environments = listQuery.data ?? [];

	useEffect(() => {
		if (!restoreFocusTo) {
			return;
		}
		editButtonRefs.current[restoreFocusTo]?.focus();
		setRestoreFocusTo(null);
	}, [restoreFocusTo]);

	// Abandon a draft whose row is gone — another session deleted it while it was
	// being edited. Without this the edit row simply vanishes on refetch with no
	// explanation, and `editing` lingers as an id pointing at nothing.
	useEffect(() => {
		if (
			editing &&
			!listQuery.isLoading &&
			!environments.some((env) => env.id === editing.id)
		) {
			setEditing(null);
			toast.error(
				"That environment was removed elsewhere; your edit was discarded.",
			);
		}
	}, [editing, environments, listQuery.isLoading]);
	const canSubmit =
		canEdit &&
		draft.name.trim().length > 0 &&
		draft.baseUrl.trim().length > 0 &&
		!createMutation.isPending;

	return (
		<div className="space-y-4">
			<div>
				<p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.2em]">
					Project configuration
				</p>
				<h3 className="mt-2 font-semibold text-foreground text-xl">
					Environments
				</h3>
				<p className="mt-1 text-muted-foreground text-sm">
					Deployment targets shared by QA test runs and other project
					automation — the single source of truth.
				</p>
			</div>

			<div className="rounded-lg border bg-card p-4">
				<h4 className="font-medium text-sm">Deployment targets</h4>
				<p className="mt-1 text-muted-foreground text-xs">
					Each target keeps a stable id and is referenced by id from
					the Testing defaults and the QA run config.
				</p>

				{listQuery.isLoading ? (
					<div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
						<Loader2Icon
							className="size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						Loading environments…
					</div>
				) : (
					<ul className="mt-3 divide-y divide-border rounded-md border">
						{environments.length === 0 && (
							<li className="px-3 py-6 text-center text-muted-foreground text-sm">
								No environments yet. Add the first target below.
							</li>
						)}
						{environments.map((env) => (
							<li
								key={env.id}
								// `flex-wrap` so the credential editor drops onto its
								// own line beneath the row instead of being squashed
								// in as another flex item beside the buttons.
								className="flex flex-wrap items-center gap-3 px-3 py-2.5"
							>
								{editing?.id === env.id ? (
									<>
										<Select
											value={editing.type}
											onValueChange={(value) =>
												setEditing((e) =>
													e
														? {
																...e,
																type: value as EnvironmentType,
															}
														: e,
												)
											}
										>
											<SelectTrigger
												className="h-8 w-24 shrink-0"
												aria-label={`Type for ${env.name}`}
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{ENVIRONMENT_TYPES.map(
													(type) => (
														<SelectItem
															key={type}
															value={type}
														>
															{TYPE_LABEL[type]}
														</SelectItem>
													),
												)}
											</SelectContent>
										</Select>
										<Input
											// Focus lands in the first field
											// rather than on <body>: clicking
											// Edit unmounts the button that had
											// focus.
											autoFocus
											value={editing.name}
											onChange={(e) =>
												setEditing((prev) =>
													prev
														? {
																...prev,
																name: e.target
																	.value,
															}
														: prev,
												)
											}
											aria-label={`Name for ${env.name}`}
											className="h-8 min-w-0 flex-1 text-sm"
										/>
										<Input
											value={editing.baseUrl}
											onChange={(e) =>
												setEditing((prev) =>
													prev
														? {
																...prev,
																baseUrl:
																	e.target
																		.value,
															}
														: prev,
												)
											}
											aria-label={`Base URL for ${env.name}`}
											className="h-8 min-w-0 flex-1 font-mono text-xs"
										/>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											aria-label={`Save ${env.name}`}
											disabled={
												updateMutation.isPending ||
												editing.name.trim().length ===
													0 ||
												editing.baseUrl.trim()
													.length === 0
											}
											onClick={() =>
												updateMutation.mutate({
													projectId,
													environmentId: env.id,
													type: editing.type,
													name: editing.name.trim(),
													baseUrl:
														editing.baseUrl.trim(),
												})
											}
										>
											{updateMutation.isPending ? (
												<Loader2Icon
													className="size-4 motion-safe:animate-spin"
													aria-hidden="true"
												/>
											) : (
												<CheckIcon
													className="size-4"
													aria-hidden="true"
												/>
											)}
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											aria-label={`Cancel editing ${env.name}`}
											onClick={() => {
												setEditing(null);
												setRestoreFocusTo(env.id);
											}}
										>
											<XIcon
												className="size-4"
												aria-hidden="true"
											/>
										</Button>
									</>
								) : (
									<>
										<span className="w-24 shrink-0 text-muted-foreground text-xs uppercase tracking-wide">
											{TYPE_LABEL[
												env.type as EnvironmentType
											] ?? env.type}
										</span>
										<span className="min-w-0 flex-1 truncate font-medium text-sm">
											{env.name}
										</span>
										<span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
											{env.baseUrl}
										</span>
										{canEdit && (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												aria-label={`Sign-in for ${env.name}`}
												title="Sign-in credential"
												onClick={() =>
													setCredentialFor((cur) =>
														cur === env.id
															? null
															: env.id,
													)
												}
											>
												<KeyRoundIcon
													className={
														credentialsQuery.data?.find(
															(c) =>
																c.environmentId ===
																env.id,
														)?.hasSecret
															? "size-4 text-secondary"
															: "size-4"
													}
													aria-hidden="true"
												/>
											</Button>
										)}
										{canEdit && (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												ref={(node) => {
													editButtonRefs.current[
														env.id
													] = node;
												}}
												aria-label={`Edit ${env.name}`}
												onClick={() =>
													setEditing({
														id: env.id,
														type: env.type as EnvironmentType,
														name: env.name,
														baseUrl: env.baseUrl,
													})
												}
											>
												<PencilIcon
													className="size-4"
													aria-hidden="true"
												/>
											</Button>
										)}
										{canEdit && (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												aria-label={`Remove ${env.name}`}
												disabled={
													deleteMutation.isPending
												}
												onClick={() =>
													confirm({
														title: "Remove environment?",
														message: `"${env.name}" will be removed, and any testing policy using it as the default environment will fall back to no default. This cannot be undone.`,
														confirmLabel: "Remove",
														cancelLabel: "Cancel",
														destructive: true,
														// `.mutate()` (not mutateAsync): the confirm
														// provider awaits onConfirm without a
														// try/catch, so a rejecting delete would
														// leave the dialog stuck open.
														onConfirm: () => {
															deleteMutation.mutate(
																{
																	projectId,
																	environmentId:
																		env.id,
																},
															);
														},
													})
												}
											>
												<Trash2Icon
													className="size-4 text-destructive"
													aria-hidden="true"
												/>
											</Button>
										)}
									</>
								)}
								{credentialFor === env.id && (
									<div className="mt-3 w-full">
										<EnvironmentCredentialForm
											projectId={projectId}
											environmentId={env.id}
											environmentName={env.name}
											isProduction={
												env.type === "PRODUCTION"
											}
											baseUrl={env.baseUrl}
											signInUrl={env.signInUrl ?? null}
											summary={credentialsQuery.data?.find(
												(c) =>
													c.environmentId === env.id,
											)}
											canEdit={canEdit}
											onDone={() =>
												setCredentialFor(null)
											}
										/>
									</div>
								)}
							</li>
						))}
					</ul>
				)}

				{canEdit && (
					<div className="mt-4 grid gap-3 sm:grid-cols-[9rem_1fr_1fr_auto] sm:items-end">
						<div className="space-y-1.5">
							<Label htmlFor="env-type">Type</Label>
							<Select
								value={draft.type}
								onValueChange={(value) =>
									setDraft((d) => ({
										...d,
										type: value as EnvironmentType,
									}))
								}
							>
								<SelectTrigger id="env-type">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{ENVIRONMENT_TYPES.map((type) => (
										<SelectItem key={type} value={type}>
											{TYPE_LABEL[type]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="env-name">Name</Label>
							<Input
								id="env-name"
								value={draft.name}
								placeholder="Staging"
								onChange={(e) =>
									setDraft((d) => ({
										...d,
										name: e.target.value,
									}))
								}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="env-url">Base URL</Label>
							<Input
								id="env-url"
								value={draft.baseUrl}
								placeholder="https://staging.example.com"
								onChange={(e) =>
									setDraft((d) => ({
										...d,
										baseUrl: e.target.value,
									}))
								}
							/>
						</div>
						<Button
							type="button"
							disabled={!canSubmit}
							onClick={() =>
								createMutation.mutate({
									projectId,
									type: draft.type,
									name: draft.name.trim(),
									baseUrl: draft.baseUrl.trim(),
								})
							}
							className="gap-1.5"
						>
							{createMutation.isPending ? (
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : (
								<PlusIcon
									className="size-4"
									aria-hidden="true"
								/>
							)}
							Add
						</Button>
					</div>
				)}
			</div>

			<div className="rounded-lg border bg-muted/30 p-4">
				<p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.2em]">
					Referenced by
				</p>
				<ul className="mt-2 space-y-1 text-muted-foreground text-sm">
					<li>
						<span className="text-foreground">
							Settings ▸ Testing
						</span>{" "}
						— default environment for planned runs
					</li>
					<li>
						<span className="text-foreground">
							QA ▸ Test run config
						</span>{" "}
						— environment picker when dispatching a run
					</li>
				</ul>
			</div>
		</div>
	);
}
