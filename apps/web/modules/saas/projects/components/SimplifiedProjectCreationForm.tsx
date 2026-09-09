"use client";

import { MIN_DESCRIPTION_LENGTH } from "@repo/api/modules/projects/lib/readiness/thresholds";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
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
import { Textarea } from "@ui/components/textarea";
import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";

type ProjectPhase = "DISCOVERY_PLANNING" | "DEVELOPMENT_EXECUTION";

interface SimplifiedFormData {
	name: string;
	description: string;
	projectPhase: ProjectPhase | "";
	/** `YYYY-MM-DD`, as the native date input produces it. */
	expectedDevelopmentStartDate: string;
}

const EMPTY_FORM: SimplifiedFormData = {
	name: "",
	description: "",
	projectPhase: "",
	expectedDevelopmentStartDate: "",
};

function createDraftKey(): string {
	return crypto.randomUUID
		? crypto.randomUUID()
		: "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
				const r = (Math.random() * 16) | 0;
				const v = c === "x" ? r : (r & 0x3) | 0x8;
				return v.toString(16);
			});
}

/** Local calendar day, not UTC — the same basis the date input's `min` uses. */
function todayIsoDate(): string {
	return new Date().toLocaleDateString("en-CA");
}

export interface SimplifiedProjectCreationFormProps {
	organizationId?: string;
	/** Present when resuming a DRAFT from the banner or an edit link. */
	projectId?: string;
}

/**
 * The single-step new-project form (Fizzy #2247).
 *
 * Collects only what the readiness checklist cannot infer or ask for later —
 * title, brief, phase, and a development start date while the project is still
 * in Discovery — then activates the project and hands the user to the project
 * Overview, where the checklist takes over as the guidance surface. It
 * deliberately starts nothing: no codebase analysis, no document generation.
 *
 * Served in place of `ProjectCreationWizard` when SIMPLIFIED_PROJECT_CREATION
 * resolves true; the wizard is left intact behind that switch, so turning it
 * off restores the previous flow exactly.
 */
export function SimplifiedProjectCreationForm({
	organizationId: propsOrganizationId,
	projectId,
}: SimplifiedProjectCreationFormProps = {}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { organizationId: contextOrgId, basePath } = useOrganizationContext();
	const effectiveOrganizationId = propsOrganizationId || contextOrgId;
	const projectsBasePath = `${basePath}/projects`;

	const [formData, setFormData] = useState<SimplifiedFormData>(EMPTY_FORM);
	const [draftKey, setDraftKey] = useState<string>("");

	/**
	 * Set once the project has been activated. Autosave reads it before every
	 * write so a debounced save that was already in flight cannot land on a
	 * project that is no longer a DRAFT.
	 */
	const hasActivatedRef = useRef(false);
	const hasHydratedRef = useRef(false);

	/**
	 * The DRAFT being resumed, if any. Submitting one goes through
	 * `projects.update`, never `projects.create({ draftKey })`: create's
	 * activation branch writes `techStack: input.techStack || []` — and the
	 * same for features, projectTypes and tags — so a four-field payload would
	 * blank whatever a draft abandoned in the five-step wizard had saved.
	 * `projects.update` passes those fields bare, so absent means untouched.
	 */
	const [resumedDraftId, setResumedDraftId] = useState<string | null>(null);

	// A fresh project autosaves under a key this form generates. A resumed
	// DRAFT reuses the key already stored on the row, so continuing one and
	// closing the tab again updates that draft instead of writing a second.
	useEffect(() => {
		if (!projectId) {
			setDraftKey((prev) => prev || createDraftKey());
		}
	}, [projectId]);

	const { data: existingProjectData, isLoading: isLoadingProject } = useQuery(
		{
			queryKey: ["project", projectId, effectiveOrganizationId],
			queryFn: () =>
				orpc.projects.get.call({
					id: projectId as string,
					organizationId: effectiveOrganizationId ?? null,
				}),
			enabled: !!projectId,
		},
	);

	useEffect(() => {
		const project = existingProjectData?.project;
		if (!project || hasHydratedRef.current) {
			return;
		}
		hasHydratedRef.current = true;

		setFormData({
			name: project.name ?? "",
			description: project.description ?? "",
			projectPhase: (project.projectPhase as ProjectPhase | null) ?? "",
			expectedDevelopmentStartDate: project.expectedDevelopmentStartDate
				? new Date(project.expectedDevelopmentStartDate)
						.toISOString()
						.slice(0, 10)
				: "",
		});

		if (project.status === "DRAFT") {
			setResumedDraftId(project.id);
			// A DRAFT written by the v1 API or the agent tool carries no
			// draftKey. Leaving the key empty disables autosave for it rather
			// than minting one, which would upsert a SECOND draft alongside the
			// row being resumed. Nothing is lost: the row already exists, and
			// submitting goes through `projects.update` either way.
			if (project.draftKey) {
				setDraftKey(project.draftKey);
			}
		}
	}, [existingProjectData]);

	const todayIso = todayIsoDate();

	// Mirrors the uniqueness rules creation itself applies, so the message
	// cannot disagree with the failure.
	const [debouncedName] = useDebounceValue(formData.name, 500);
	const trimmedDebouncedName = debouncedName.trim();
	const { data: nameCheckData } = useQuery({
		...orpc.projects.checkName.queryOptions({
			input: {
				name: trimmedDebouncedName,
				organizationId: effectiveOrganizationId ?? null,
			},
		}),
		enabled: !resumedDraftId && trimmedDebouncedName.length >= 1,
	});
	const isDuplicateName =
		!resumedDraftId &&
		trimmedDebouncedName.length >= 1 &&
		nameCheckData?.available === false;

	const briefLength = formData.description.trim().length;
	const briefTooShort = briefLength <= MIN_DESCRIPTION_LENGTH;

	/**
	 * Ported verbatim from the wizard's `basicsAnswered`. Note the predicate is
	 * `>` and not `>=`: the effective floor is MIN_DESCRIPTION_LENGTH + 1
	 * characters, and loosening it here would re-open the gap #2165 closed.
	 */
	const canSubmit =
		formData.name.trim().length > 0 &&
		!isDuplicateName &&
		!briefTooShort &&
		!!formData.projectPhase &&
		(formData.projectPhase !== "DISCOVERY_PLANNING" ||
			(!!formData.expectedDevelopmentStartDate &&
				formData.expectedDevelopmentStartDate >= todayIso));

	const updateFormData = (patch: Partial<SimplifiedFormData>) => {
		setFormData((prev) => ({ ...prev, ...patch }));
	};

	const saveDraftMutation = useMutation(
		orpc.projects.saveDraft.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.projects.listDrafts.queryOptions({
						input: {
							organizationId: effectiveOrganizationId ?? null,
						},
					}).queryKey,
				});
			},
		}),
	);

	const saveDraftToServer = useCallback(
		(data: SimplifiedFormData) => {
			// Deliberately NOT skipped while a previous save is in flight. The
			// debounce fires only when the form data changes, so a save dropped
			// for being concurrent would never be retried, and an edit made
			// while the last one was still going would be lost the moment the
			// user closed the tab. `upsertDraftProjectByKey` is idempotent by
			// draftKey and carries an explicit P2002 race branch, so overlapping
			// saves are a case the server already handles.
			if (hasActivatedRef.current || !draftKey || !data.name.trim()) {
				return;
			}
			saveDraftMutation.mutate({
				draftKey,
				name: data.name.trim(),
				organizationId: effectiveOrganizationId ?? null,
				description: data.description,
				// The two fields the simplified form makes required. Sent as
				// typed columns so a resumed draft can submit without the user
				// re-answering them; `null` clears a start date a Development
				// project no longer has a use for.
				projectPhase: data.projectPhase || null,
				expectedDevelopmentStartDate:
					data.projectPhase === "DISCOVERY_PLANNING" &&
					data.expectedDevelopmentStartDate
						? new Date(data.expectedDevelopmentStartDate)
						: null,
				currentStep: 1,
			});
		},
		[draftKey, effectiveOrganizationId, saveDraftMutation.mutate],
	);

	// A ref keeps the effect's dependency list stable, so the debounce is not
	// restarted by every re-render of the callback.
	const saveDraftRef = useRef(saveDraftToServer);
	saveDraftRef.current = saveDraftToServer;
	const [debouncedFormData] = useDebounceValue(formData, 500);
	useEffect(() => {
		saveDraftRef.current(debouncedFormData);
	}, [debouncedFormData]);

	const goToProject = (id: string) => {
		hasActivatedRef.current = true;
		queryClient.invalidateQueries({
			queryKey: orpc.projects.listDrafts.queryOptions({
				input: { organizationId: effectiveOrganizationId ?? null },
			}).queryKey,
		});
		toast.success("Project created successfully");
		// Overview is the first tab and the readiness checklist mounts above the
		// tab bar, so the checklist is on screen the moment the project opens.
		router.push(`${projectsBasePath}/${id}`);
	};

	const createMutation = useMutation(
		orpc.projects.create.mutationOptions({
			onSuccess: (data) => goToProject(data.project.id),
			onError: (error: unknown) => {
				toast.error(
					error instanceof Error
						? error.message
						: "Could not create the project",
				);
			},
		}),
	);

	const updateMutation = useMutation(
		orpc.projects.update.mutationOptions({
			onSuccess: (data) => goToProject(data.project.id),
			onError: (error: unknown) => {
				toast.error(
					error instanceof Error
						? error.message
						: "Could not create the project",
				);
			},
		}),
	);

	const isSubmitting = createMutation.isPending || updateMutation.isPending;

	const handleSubmit = (event: React.FormEvent) => {
		event.preventDefault();

		if (!formData.name.trim()) {
			toast.error("Please enter a project name");
			return;
		}
		if (isDuplicateName) {
			toast.error("A project with this name already exists");
			return;
		}
		if (briefTooShort) {
			toast.error(
				`Give the project a brief of more than ${MIN_DESCRIPTION_LENGTH} characters — it is the first thing Fabric reads`,
			);
			return;
		}
		if (!formData.projectPhase) {
			toast.error("Choose which phase this project is in");
			return;
		}
		if (formData.projectPhase === "DISCOVERY_PLANNING") {
			if (!formData.expectedDevelopmentStartDate) {
				toast.error("Choose when development is expected to start");
				return;
			}
			// The picker's `min` stops the calendar offering a past day; typing
			// one still gets through.
			if (formData.expectedDevelopmentStartDate < todayIso) {
				toast.error(
					"Expected development start can't be in the past — pick today or later",
				);
				return;
			}
		}

		// Stop the debounced autosave before either write, so a trailing
		// `saveDraft` cannot land on the project once it is no longer a DRAFT.
		hasActivatedRef.current = true;

		const startDate =
			formData.projectPhase === "DISCOVERY_PLANNING" &&
			formData.expectedDevelopmentStartDate
				? new Date(formData.expectedDevelopmentStartDate)
				: undefined;

		if (resumedDraftId) {
			updateMutation.mutate({
				id: resumedDraftId,
				organizationId: effectiveOrganizationId ?? null,
				name: formData.name.trim(),
				description: formData.description,
				projectPhase: formData.projectPhase as ProjectPhase,
				expectedDevelopmentStartDate: startDate ?? null,
				status: "ACTIVE",
			});
			return;
		}

		createMutation.mutate({
			name: formData.name.trim(),
			description: formData.description,
			projectPhase: formData.projectPhase as ProjectPhase,
			expectedDevelopmentStartDate: startDate,
			organizationId: effectiveOrganizationId ?? null,
			// Activates the draft this form has been autosaving instead of
			// leaving it behind as a second row.
			draftKey: draftKey || undefined,
		});
	};

	if (projectId && isLoadingProject) {
		return (
			<div
				className="flex items-center justify-center py-16"
				data-testid="simplified-creation-loading"
			>
				<Loader2Icon className="size-5 animate-spin text-muted-foreground" />
			</div>
		);
	}

	return (
		<div className="mx-auto w-full max-w-2xl">
			<div className="mb-8">
				<h1
					className="font-normal text-3xl leading-tight"
					style={{ fontFamily: "var(--font-serif)" }}
				>
					{resumedDraftId ? "Continue your project" : "New project"}
				</h1>
				<p className="mt-2 text-muted-foreground text-sm">
					Start a project with the basics. Fabric will guide setup
					after creation.
				</p>
			</div>

			<form
				onSubmit={handleSubmit}
				className="space-y-6"
				data-testid="simplified-project-creation-form"
			>
				<div className="space-y-2">
					<Label htmlFor="project-name">Project title</Label>
					<Input
						id="project-name"
						value={formData.name}
						onChange={(e) =>
							updateFormData({ name: e.target.value })
						}
						placeholder="e.g. Customer portal"
						aria-invalid={isDuplicateName || undefined}
						aria-describedby={
							isDuplicateName ? "project-name-error" : undefined
						}
						data-testid="simplified-project-name"
					/>
					{isDuplicateName && (
						<p
							id="project-name-error"
							className="text-destructive text-xs"
						>
							A project with this name already exists
						</p>
					)}
				</div>

				<div className="space-y-2">
					<Label htmlFor="project-description">
						What is this project?
					</Label>
					<Textarea
						id="project-description"
						value={formData.description}
						onChange={(e) =>
							updateFormData({ description: e.target.value })
						}
						rows={4}
						placeholder="A couple of sentences on what you are building and who it is for."
						aria-describedby="project-description-help"
						data-testid="simplified-project-description"
					/>
					<p
						id="project-description-help"
						className="text-muted-foreground text-xs"
					>
						{briefTooShort
							? `A little more — ${
									MIN_DESCRIPTION_LENGTH + 1 - briefLength
								} character${
									MIN_DESCRIPTION_LENGTH + 1 - briefLength ===
									1
										? ""
										: "s"
								} to go. It is the first thing Fabric reads.`
							: "It is the first thing Fabric reads."}
					</p>
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor="project-phase">
							Where is this project now?
						</Label>
						<Select
							value={formData.projectPhase}
							onValueChange={(value) => {
								// Radix re-emits the empty value while it syncs
								// a controlled value that changed from outside
								// the trigger — which is what hydrating a
								// resumed draft does. No SelectItem carries an
								// empty value, so a real choice never looks like
								// this, and without the guard the phase restored
								// from a draft is wiped one render later.
								if (!value) {
									return;
								}
								updateFormData({
									projectPhase: value as ProjectPhase,
									// A development project has no expected
									// start date to give.
									...(value === "DEVELOPMENT_EXECUTION"
										? { expectedDevelopmentStartDate: "" }
										: {}),
								});
							}}
						>
							<SelectTrigger
								id="project-phase"
								data-testid="simplified-project-phase"
							>
								<SelectValue placeholder="Choose a phase" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="DISCOVERY_PLANNING">
									Discovery / Planning
								</SelectItem>
								<SelectItem value="DEVELOPMENT_EXECUTION">
									Development / Execution
								</SelectItem>
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							Fabric asks for different things in each phase. You
							can change this later.
						</p>
					</div>

					{formData.projectPhase === "DISCOVERY_PLANNING" && (
						<div className="space-y-2">
							<Label htmlFor="expected-dev-start">
								When is development expected to start?
							</Label>
							<Input
								id="expected-dev-start"
								type="date"
								min={todayIso}
								aria-describedby="expected-dev-start-help"
								value={formData.expectedDevelopmentStartDate}
								onChange={(e) =>
									updateFormData({
										expectedDevelopmentStartDate:
											e.target.value,
									})
								}
								data-testid="simplified-expected-dev-start"
							/>
							<p
								id="expected-dev-start-help"
								className="text-muted-foreground text-xs"
							>
								Until then, Fabric will not ask you to connect a
								codebase.
							</p>
						</div>
					)}
				</div>

				<div className="flex items-center justify-end gap-3 border-t pt-6">
					<Button
						type="button"
						variant="ghost"
						onClick={() => router.push(projectsBasePath)}
						disabled={isSubmitting}
					>
						Cancel
					</Button>
					<Button
						type="submit"
						disabled={!canSubmit || isSubmitting}
						data-testid="simplified-create-project"
					>
						{isSubmitting && (
							<Loader2Icon className="mr-2 size-4 animate-spin" />
						)}
						Create Project
					</Button>
				</div>
			</form>
		</div>
	);
}
