"use client";

import {
	CONTEXT_UPLOAD_ACCEPT_ATTR,
	contextUploadConfigFor,
	formatSizeLimit,
	resolveContextUploadCategory,
	UPLOAD_SIZE_LIMITS,
} from "@repo/utils";
import {
	DOCUMENT_TYPE_OPTIONS,
	documentTypeLabel,
} from "@repo/utils/document-type-catalog";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PromptSelector } from "@saas/prompts/components/PromptSelector";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

type DocumentType = (typeof DOCUMENT_TYPE_OPTIONS)[number]["value"];

const DEFAULT_DOCUMENT_TYPE: DocumentType = "GENERAL";

/**
 * Whether this tenant can generate at all.
 *
 * The check has four outcomes and each one is pinned deliberately:
 *
 * - `available`   — a provider is configured; Generate with AI is offered and
 *                   starts on.
 * - `unavailable` — no provider is configured; the control is not rendered at
 *                   all and creating from a title alone is allowed, so an
 *                   AI-unconfigured tenant keeps a way to create documents.
 * - `pending`     — the check has not settled. The toggle row renders as
 *                   pending and submit is disabled rather than assuming
 *                   availability: this dialog reopens far more often than the
 *                   onboarding step it borrows the check from, so an optimistic
 *                   default would flash the toggle on and then remove it on
 *                   every open in a tenant without AI.
 * - errored       — folded into `unavailable`. Failing closed to the manual
 *                   path is never harmful; failing open offers a generation
 *                   the tenant may not be able to run.
 */
type AiAvailability = "pending" | "available" | "unavailable";

/**
 * How the source content the user supplied is used.
 *
 * The names match the create procedure's own `sourceUsage` input so the client
 * and the server say the same word for the same thing. They deliberately do
 * NOT reuse story attachments' `designation` vocabulary, which encodes
 * delete-protection plus AI visibility — an unrelated axis. Blurring the two
 * is a documented failure mode, so this flow keeps its own term.
 */
type SourceUsage = "CONTEXT" | "AS_IS";

/**
 * How long the source textarea must be quiet before the usage-mode control
 * appears or disappears.
 *
 * Bound directly to the textarea's value the control would mount on the first
 * character and unmount on the last, so every paste-and-clear would jump the
 * layout. What is debounced is the *presence boolean*, not the text: a burst of
 * typing schedules at most one transition, and text pasted then cleared inside
 * the window never moves the control at all.
 */
const SOURCE_PRESENCE_DEBOUNCE_MS = 300;

type Props = {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

/**
 * One branch per outcome, in the order the availability contract lists them:
 * an errored check fails closed to the manual path, an unresolved one holds
 * the toggle pending, and only a resolved, configured tenant reads available.
 */
function resolveAiAvailability({
	checkFailed,
	hasAnswer,
	configured,
}: {
	checkFailed: boolean;
	hasAnswer: boolean;
	configured: boolean | undefined;
}): AiAvailability {
	if (checkFailed) {
		return "unavailable";
	}
	if (!hasAnswer) {
		return "pending";
	}
	return configured ? "available" : "unavailable";
}

/**
 * Ties the visible "Prompt" label to the selector's trigger.
 *
 * The selector falls back to a generic accessible name when no caller supplies
 * one, which keeps it from ever being unnamed — but a real association is
 * better: it makes the visible text the accessible name, so the two cannot
 * drift, and it makes the label clickable. Stable across the `key={type}`
 * remount below, since only one selector is mounted at a time.
 */
/**
 * Refusal reason for a chosen file, or null when it is acceptable.
 *
 * Every rule comes from the shared context-upload allowlist rather than being
 * restated here: the accept attribute, the type gate, and the per-category size
 * ceiling are the same ones the Context tab and the project wizard use, and the
 * same ones the server will apply. A second copy would be a picker that
 * advertises what the server refuses, which is how this drifted before.
 *
 * The browser reports an empty `File.type` whenever the OS has no registration
 * for the extension — `.md` on a stock Windows box — so the type is resolved
 * from the filename first, exactly as the upload procedure does.
 */
function describeFileRefusal(file: File): string | null {
	const { resolvedMimeType, category } = resolveContextUploadCategory(
		file.type,
		file.name,
	);
	if (!contextUploadConfigFor(resolvedMimeType)) {
		return "unsupported";
	}
	if (file.size > UPLOAD_SIZE_LIMITS[category]) {
		return formatSizeLimit(UPLOAD_SIZE_LIMITS[category]);
	}
	if (file.size === 0) {
		return "empty";
	}
	return null;
}

/**
 * Put the chosen file where the extraction workflow will find it.
 *
 * The same three-step sequence the Context tab uses — signed URL, PUT, process
 * — with the create flow's own metadata attached, so the workflow knows the
 * upload belongs to a document that already exists and how it is meant to be
 * used. Runs after the document row is created, because the second step needs
 * that row's id.
 */
async function uploadSourceFile({
	projectId,
	documentId,
	documentType,
	file,
}: {
	projectId: string;
	documentId: string;
	documentType: string;
	file: File;
}): Promise<void> {
	const { signedUploadUrl, contextId, contentType } =
		await orpcClient.projects.contexts.createUploadUrl({
			projectId,
			filename: file.name,
			mimeType: file.type,
			size: file.size,
			documentTag: documentType,
			// A file has one use, so this is stated here rather than passed in.
			// It was a parameter fed from the dialog's mode state, and that
			// state does not hold: an effect resets the mode to Use as Context
			// on a debounce once a source is noticed, landing just after
			// choosing a file had set As-Is. The dialog looked right — the mode
			// control is not shown for a file — while the upload carried the
			// mode the server refuses, and the document sat on "generating".
			//
			// Structural rather than derived: with no parameter there is no
			// ordering to get right, and nothing a caller can pass that will
			// not work.
			documentUsage: "AS_IS",
			targetDocumentId: documentId,
		});

	if (!signedUploadUrl) {
		throw new Error("uploads-unsupported");
	}

	const response = await fetch(signedUploadUrl, {
		method: "PUT",
		body: file,
		headers: {
			// The type the server resolved, not the browser's placeholder, so
			// the stored object matches the row that was persisted.
			"Content-Type":
				contentType ??
				resolveContextUploadCategory(file.type, file.name)
					.resolvedMimeType,
		},
	});
	if (!response.ok) {
		throw new Error("upload-failed");
	}

	await orpcClient.projects.contexts.processFile({ projectId, contextId });
}

const PROMPT_TRIGGER_ID = "create-document-prompt";

export function CreateDocumentDialog({ projectId, open, onOpenChange }: Props) {
	const t = useTranslations("projects.documents.create");
	const router = useRouter();
	const queryClient = useQueryClient();
	const { organizationId, basePath } = useOrganizationContext();

	const [title, setTitle] = useState(
		documentTypeLabel(DEFAULT_DOCUMENT_TYPE),
	);
	const [type, setType] = useState<DocumentType>(DEFAULT_DOCUMENT_TYPE);
	/**
	 * Source material the user pasted. Distinct from `aiInstructions`: one is
	 * the raw material the document is written from, the other steers how this
	 * one run writes it. A single field toggling between the two conflated them.
	 */
	const [sourceText, setSourceText] = useState("");
	/**
	 * One file, not many. The dialog produces one document, so it takes one
	 * source; the Context tab remains the place to bring several in at once.
	 */
	const [sourceFile, setSourceFile] = useState<File | null>(null);
	const [fileRefusal, setFileRefusal] = useState<string | null>(null);
	const [sourceUsage, setSourceUsage] = useState<SourceUsage>("CONTEXT");
	const [aiInstructions, setAiInstructions] = useState("");
	/**
	 * Prompt selection is per document type. The selector resolves the bound
	 * default for whatever type it is given, so holding `undefined` here means
	 * "whatever that type's default is" rather than "no prompt" — which is why
	 * a type change clears it instead of carrying a prompt that belongs to the
	 * type the user just left.
	 */
	/**
	 * Which input a refusal belongs to, so the message can be associated with
	 * it rather than only shown near it. `null` is "nothing refused".
	 */
	const [validationError, setValidationError] = useState<
		"title" | "source" | null
	>(null);
	const [promptId, setPromptId] = useState<string | undefined>(undefined);
	const [promptVersionId, setPromptVersionId] = useState<string | undefined>(
		undefined,
	);
	const dialogContentRef = useRef<HTMLDivElement | null>(null);
	/**
	 * The submit chain can outlive this component — the user can navigate away
	 * while a create is in flight. Closing a dialog that is gone is harmless;
	 * pushing a route is not, and would yank them out of wherever they went.
	 */
	const isMountedRef = useRef(true);
	/**
	 * `null` means "the user has not touched the toggle", which is what makes
	 * the default derivable rather than stored: with AI available the toggle
	 * reads on until the user says otherwise, and it can never read on in a
	 * tenant where it is not offered.
	 */
	const [generateWithAiOverride, setGenerateWithAiOverride] = useState<
		boolean | null
	>(null);
	/**
	 * Tracks the whole submit chain (create + cache invalidation + navigation).
	 * The mutation's own pending flag flips back to false the moment create
	 * resolves, leaving a window where a second click fires a second create —
	 * the sibling story dialog documents the same gap. This flag stays set
	 * until the chain settles in `finally`.
	 */
	const [isOrchestrating, setIsOrchestrating] = useState(false);

	// Same tenant AI-availability status the onboarding generation step reads.
	const { data: aiConfigStatus, isError: aiConfigCheckFailed } = useQuery({
		queryKey: ["aiConfigStatus", organizationId],
		queryFn: async () => {
			return await orpcClient.aiConfig.resolution.getStatus({
				organizationId,
			});
		},
		// The documents list mounts this dialog rather than opening it, so an
		// ungated check runs on every visit to the tab for users who never
		// create a document.
		enabled: open,
	});

	const aiAvailability: AiAvailability = resolveAiAvailability({
		checkFailed: aiConfigCheckFailed,
		// "No answer yet", not "a request is in flight". Gating the query on
		// `open` means there is a moment after opening where nothing is
		// loading and nothing has resolved; keying on the loading flag would
		// read that as unavailable and flash the toggle away.
		hasAnswer: aiConfigStatus !== undefined,
		configured: aiConfigStatus?.isConfigured,
	});

	const sourceIsNonEmpty =
		sourceText.trim().length > 0 || sourceFile !== null;
	const [hasSourceContent, setHasSourceContent] = useState(false);

	/**
	 * R12/R34: the mode only exists where there is something to apply it to,
	 * and only where the alternative means anything. A tenant that cannot
	 * generate has one route for supplied text, so offering a choice between
	 * two would be offering a choice between one.
	 */
	/**
	 * The mode choice belongs to pasted text only.
	 *
	 * An attached file is used as it is, and cannot be generation input: the run
	 * could only start once extraction finishes, by which point the request that
	 * could issue an AI token is gone. Offering the choice and then producing a
	 * document that never finishes is worse than not offering it, so the control
	 * gives way to a line saying what happens instead.
	 */
	const showUsageMode =
		aiAvailability === "available" && hasSourceContent && !sourceFile;

	/**
	 * R15: Use As-Is turns generation off for this action. Deriving it from the
	 * mode rather than writing into the toggle's own state is what makes R13
	 * hold for free — clear the source, the mode control goes, and generation
	 * comes back on without a second piece of state to keep in step.
	 */
	const useSourceAsIs = showUsageMode && sourceUsage === "AS_IS";

	const generateWithAI =
		aiAvailability === "available" && !useSourceAsIs
			? (generateWithAiOverride ?? true)
			: false;

	const titleErrorId = useId();
	const sourceErrorId = useId();
	const usageModeLabelId = useId();
	const asIsHintId = useId();

	const createMutation = useMutation(
		orpc.projects.documents.create.mutationOptions(),
	);

	useEffect(
		() => () => {
			isMountedRef.current = false;
		},
		[],
	);

	// Reset on open rather than on close: a close-time timer leaves the next
	// open showing whatever the last one was mid-way through if the dialog is
	// reopened inside the timer's window.
	useEffect(() => {
		if (!open) {
			return;
		}
		setTitle(documentTypeLabel(DEFAULT_DOCUMENT_TYPE));
		setType(DEFAULT_DOCUMENT_TYPE);
		setSourceText("");
		setSourceFile(null);
		setFileRefusal(null);
		setSourceUsage("CONTEXT");
		setAiInstructions("");
		setPromptId(undefined);
		setPromptVersionId(undefined);
		setValidationError(null);
		setGenerateWithAiOverride(null);
		setHasSourceContent(false);
	}, [open]);

	/**
	 * Commit the source-presence flip only once the field has been quiet.
	 *
	 * Hand-rolled rather than reached for from the shared debounce hook, for
	 * two reasons. That hook debounces a *value*, so it reschedules on every
	 * keystroke where this only needs the boolean's own transition — a burst of
	 * typing schedules exactly one timer, and a paste immediately undone never
	 * flips the boolean at all. And it leaks its timer past unmount, which is
	 * why the suite stubs it out globally; a control whose whole point is that
	 * it does not appear per-keystroke has to be able to prove that it doesn't.
	 */
	useEffect(() => {
		if (sourceIsNonEmpty === hasSourceContent) {
			return;
		}
		const timer = setTimeout(
			() => setHasSourceContent(sourceIsNonEmpty),
			SOURCE_PRESENCE_DEBOUNCE_MS,
		);
		return () => clearTimeout(timer);
	}, [sourceIsNonEmpty, hasSourceContent]);

	/**
	 * R13: Use as Context is selected whenever source content becomes present,
	 * and clearing the source returns the flow to that default rather than
	 * leaving a mode set with nothing to apply it to.
	 */
	useEffect(() => {
		setSourceUsage("CONTEXT");
	}, [hasSourceContent]);

	/**
	 * Whether the title still belongs to the flow rather than the user.
	 *
	 * Derived, not a sticky "user has edited" flag. An empty field and a field
	 * still holding the type's own label both count as untouched — the same
	 * test `buildDocumentTitle` applies server-side for the one type with a
	 * dynamic default, so the two sides agree on what "default" means.
	 *
	 * A sticky flag would also strand a user who clears the field: the flag
	 * would stay set, the type would stop refreshing the title, and submit
	 * would sit disabled on an empty title with no way back short of typing
	 * one. Deriving it means clearing the field re-arms the default.
	 */
	const titleIsStillDefault =
		title.trim() === "" || title === documentTypeLabel(type);

	const handleTypeChange = (nextType: DocumentType) => {
		if (titleIsStillDefault) {
			setTitle(documentTypeLabel(nextType));
		}
		// Prompt options are scoped to the document type, so a selection made
		// for the previous one must not survive. Clearing lets the selector
		// re-resolve the new type's default rather than showing a prompt that
		// is not offered for it.
		setPromptId(undefined);
		setPromptVersionId(undefined);
		setType(nextType);
	};

	/**
	 * R16: turning Generate with AI back on is how the user leaves Use As-Is,
	 * and doing so returns the mode to Use as Context.
	 *
	 * Turning it off moves the other way, because with no run there is nothing
	 * to consume a source held as context — Use As-Is is the only mode that
	 * still means something. This used to leave the mode alone, which was
	 * harmless while pasted text was the only source: the server derives the
	 * mode when the client sends none, and it derived As-Is. A file always
	 * sends its mode explicitly, so the stale Use as Context travelled with it
	 * and the upload was routed to a generation the user had just switched off.
	 */
	const handleGenerateWithAiChange = (checked: boolean) => {
		setGenerateWithAiOverride(checked);
		setSourceUsage(checked ? "CONTEXT" : "AS_IS");
	};

	const isSubmitting = createMutation.isPending || isOrchestrating;
	const canSubmit =
		!isSubmitting &&
		title.trim().length > 0 &&
		aiAvailability !== "pending";

	const handleCreate = async () => {
		const trimmedTitle = title.trim();
		if (!trimmedTitle) {
			setValidationError("title");
			toast.error(t("titleRequired"));
			return;
		}

		const trimmedSource = sourceText.trim();
		const hasPastedSource = trimmedSource.length > 0;
		// A file is a source too. Counting only the paste here refused every
		// file submitted with generation off — the Use As-Is combination, which
		// is the one case where a file needs no model at all.
		const hasSource = hasPastedSource || sourceFile !== null;

		/*
		 * Nothing to generate from and nothing to publish. Whitespace counts
		 * as nothing — it would otherwise be the cheapest way to satisfy the
		 * guard while producing an empty document.
		 *
		 * Only where generation is possible. Where it is not, a title alone
		 * is the sanctioned route (R27) and blocking it would leave that
		 * tenant unable to create documents at all.
		 */
		if (aiAvailability === "available" && !generateWithAI && !hasSource) {
			setValidationError("source");
			toast.error(t("blockedEmptyCreation"));
			return;
		}

		setValidationError(null);

		const toastId = toast.loading(t("creating"));
		setIsOrchestrating(true);
		try {
			/*
			 * Three routes, one call. The server owns the create-and-dispatch
			 * decision so "document created" and "generation started" cannot
			 * fail independently:
			 *
			 *   Use As-Is      — the text becomes the body, nothing generates.
			 *   Use as Context — the text is kept and carried into the run.
			 *   No source      — generate from project context alone. This is
			 *                    the common route, and the only one keyed to
			 *                    no usage mode, because there is no source to
			 *                    have a mode about.
			 */
			const data = await createMutation.mutateAsync({
				projectId,
				title: trimmedTitle,
				type,
				generateWithAi: generateWithAI,
				...(sourceFile ? { awaitingSourceFile: true } : {}),
				...(hasPastedSource && !sourceFile
					? {
							sourceText: trimmedSource,
							sourceUsage,
						}
					: {}),
				...(generateWithAI && aiInstructions.trim()
					? { prompt: aiInstructions.trim() }
					: {}),
				// Carried so the run uses the prompt the user saw, resolved
				// against the type submitted alongside it. Attribution needs
				// the version; neither writes binding configuration.
				...(generateWithAI && promptId ? { promptId } : {}),
				...(generateWithAI && promptVersionId
					? { promptVersionId }
					: {}),
				timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			});

			/*
			 * A response without a document is a failure, whatever its status
			 * said. Treating it as success would close the dialog and navigate
			 * to nothing, and the user would be told their document exists
			 * when only the source was written.
			 */
			if (!data?.document?.id) {
				throw new Error("create-returned-no-document");
			}

			/*
			 * The row exists; now give it something to become. A failure here
			 * leaves that row generating with no upload behind it, which is
			 * precisely the shape the stale-generation sweep clears — so the
			 * user is told plainly rather than left to wonder, and nothing has
			 * to be unwound by hand.
			 */
			if (sourceFile) {
				try {
					await uploadSourceFile({
						projectId,
						documentId: data.document.id,
						documentType: type,
						file: sourceFile,
					});
				} catch {
					toast.error(t("fileUploadFailed"), { id: toastId });
					return;
				}
			}

			// Invalidate before closing so the list the user returns to is
			// already refetching rather than showing yesterday's rows.
			queryClient.invalidateQueries({
				queryKey: orpc.projects.documents.list.queryKey({
					input: { projectId, organizationId },
				}),
			});

			const generated = Boolean(data.generation);
			toast.success(generated ? t("createdWithAi") : t("created"), {
				id: toastId,
			});

			// This one took over as the active document of its type, standing an
			// earlier one down. Said out loud: only active documents reach
			// retrieval, so the displacement changes what every future
			// generation reads, and the person who wrote the older one is not
			// necessarily the person doing this.
			if (data.displacedActive) {
				toast.warning(t("displacedActive"));
			}

			// The model's copy carries a truncation marker; the user's view has
			// to say so too, and the dialog is about to go away.
			if (data.suppliedTextOutcome?.status === "truncated") {
				toast.warning(t("sourceTruncated"));
			}

			if (!isMountedRef.current) {
				return;
			}

			onOpenChange(false);

			/*
			 * No generate flag. The server already dispatched, and the editor
			 * fires its own generation when it sees that flag — the two would
			 * race writes to one document, the second run using the editor's
			 * prompt rather than the one chosen here. The row is marked
			 * generating before the workflow starts, so the editor picks its
			 * in-flight state up from the document's status instead.
			 */
			router.push(
				`${basePath}/projects/${projectId}/documents/${data.document.id}`,
			);
		} catch (_error) {
			// Deliberately generic. The server already replaces internal
			// failures with a fixed message, and anything that reaches here
			// from the transport has no business being read by a user.
			toast.error(t("createFailed"), { id: toastId });
		} finally {
			setIsOrchestrating(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// Escape, the backdrop, and the built-in close button are their
				// own dismissal paths — Cancel being disabled does not cover
				// them. Letting one through mid-submit does not cancel the
				// chain; it leaves it running to close and navigate over
				// whatever the user opened next.
				if (isSubmitting && !next) {
					return;
				}
				onOpenChange(next);
			}}
		>
			<DialogContent className="max-w-2xl" ref={dialogContentRef}>
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription>{t("description")}</DialogDescription>
				</DialogHeader>

				{/*
				 * Control order is load-bearing and reads as three decisions:
				 *   1. what the document is        — type, title
				 *   2. how it gets written         — AI toggle, prompt, instructions
				 *   3. what it is written from     — source content, usage mode
				 * Later units add controls inside these groups; they do not
				 * reorder the groups.
				 */}
				<div className="space-y-4">
					{/* 1. What the document is */}
					<div>
						<Label htmlFor="type">{t("typeLabel")}</Label>
						<Select
							value={type}
							onValueChange={(value) =>
								handleTypeChange(value as DocumentType)
							}
						>
							<SelectTrigger id="type">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DOCUMENT_TYPE_OPTIONS.map((docType) => (
									<SelectItem
										key={docType.value}
										value={docType.value}
									>
										<span className="flex items-center gap-2">
											<span>{docType.icon}</span>
											<span>{docType.label}</span>
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div>
						<Label htmlFor="title">{t("titleLabel")}</Label>
						<Input
							id="title"
							placeholder={t("titlePlaceholder")}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							aria-invalid={validationError === "title"}
							aria-describedby={
								validationError === "title"
									? titleErrorId
									: undefined
							}
						/>
						{validationError === "title" && (
							<p
								id={titleErrorId}
								role="alert"
								className="mt-1 text-destructive text-sm"
							>
								{t("titleRequired")}
							</p>
						)}
					</div>

					{/* 2. How it gets written */}
					{aiAvailability === "pending" && (
						<output
							data-testid="ai-availability-pending"
							aria-busy="true"
							className="flex w-full items-center gap-3 rounded-lg border p-4"
						>
							<Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground motion-safe:animate-spin" />
							<span className="text-muted-foreground text-sm">
								{t("aiAvailabilityPending")}
							</span>
						</output>
					)}

					{aiAvailability === "available" && (
						<div className="flex items-start space-x-2 rounded-lg border p-4">
							{/*
							 * R16: never `disabled`, not even while Use As-Is
							 * has forced it off. Radix makes a disabled
							 * checkbox inert to pointer AND keyboard, and
							 * turning this back on is the only way out of Use
							 * As-Is — a disabled control here is a state with
							 * no exit. It reads unchecked and stays fully
							 * operable, the way the codebase's
							 * disabled-but-focusable controls do, with the
							 * exit spelled out in `aria-describedby` rather
							 * than implied.
							 */}
							<Checkbox
								id="generate-ai"
								className="mt-0.5"
								checked={generateWithAI}
								aria-describedby={
									useSourceAsIs ? asIsHintId : undefined
								}
								onCheckedChange={(checked) =>
									handleGenerateWithAiChange(
										checked as boolean,
									)
								}
							/>
							<div className="flex-1">
								<Label
									htmlFor="generate-ai"
									className="flex cursor-pointer items-center gap-2"
								>
									<SparklesIcon className="size-4 text-primary" />
									<span>{t("generateWithAiLabel")}</span>
								</Label>
								<p className="text-muted-foreground text-sm">
									{t("generateWithAiDescription")}
								</p>
								{useSourceAsIs && (
									<p
										id={asIsHintId}
										data-testid="as-is-turns-ai-off-hint"
										className="mt-1 text-muted-foreground text-xs"
									>
										{t("generateWithAiAsIsHint")}
									</p>
								)}
							</div>
						</div>
					)}

					{aiAvailability === "unavailable" && (
						<p
							data-testid="ai-unavailable-notice"
							className="text-muted-foreground text-sm"
						>
							{t("aiUnavailableNotice")}
						</p>
					)}

					{/*
					 * The same selector the onboarding generation step uses,
					 * under the same agent name, so both surfaces resolve
					 * prompts through one binding model rather than two.
					 */}
					{generateWithAI && (
						<div>
							<Label
								className="mb-2 block"
								htmlFor={PROMPT_TRIGGER_ID}
							>
								{t("promptLabel")}
							</Label>
							<PromptSelector
								triggerId={PROMPT_TRIGGER_ID}
								// Remount per type: the selector notifies its
								// default once per mount, so without this a
								// second type's default never reaches the
								// payload — the dropdown shows it, the
								// submitted attribution does not.
								key={type}
								agentName="project_document_generator"
								documentType={type}
								value={promptId}
								onValueChange={setPromptId}
								onPromptVersionChange={setPromptVersionId}
								disabled={isSubmitting}
								placeholder={t("promptPlaceholder")}
								tooltipCollisionBoundaryRef={dialogContentRef}
							/>
						</div>
					)}

					{generateWithAI && (
						<div>
							<Label htmlFor="ai-instructions">
								{t("instructionsLabel")}
							</Label>
							<Textarea
								id="ai-instructions"
								placeholder={t("instructionsPlaceholder")}
								value={aiInstructions}
								onChange={(e) =>
									setAiInstructions(e.target.value)
								}
								rows={4}
							/>
							<p className="mt-1 text-muted-foreground text-xs">
								{t("instructionsHelp")}
							</p>
						</div>
					)}

					{/*
					 * 3. What it is written from — the source content and,
					 * once there is any, how it should be used.
					 */}
					<div className="space-y-2">
						{/*
						 * The field is offered in every availability state
						 * (R11, R34), but it is not the same thing in each.
						 * Where AI can generate, this is source material that
						 * either feeds the run or becomes the document. Where
						 * it cannot, there is no second route: whatever is
						 * pasted IS the document body. The label says which
						 * one the user is looking at rather than naming it
						 * after a route this tenant does not have.
						 */}
						<Label htmlFor="source-content">
							{aiAvailability === "unavailable"
								? t("contentLabel")
								: t("sourceContentLabel")}
						</Label>
						<Textarea
							id="source-content"
							placeholder={
								aiAvailability === "unavailable"
									? t("contentPlaceholder")
									: t("sourceContentPlaceholder")
							}
							value={sourceText}
							onChange={(e) => setSourceText(e.target.value)}
							disabled={sourceFile !== null}
							rows={8}
							aria-invalid={validationError === "source"}
							aria-describedby={
								validationError === "source"
									? sourceErrorId
									: undefined
							}
						/>
						{validationError === "source" && (
							<p
								id={sourceErrorId}
								role="alert"
								className="text-destructive text-sm"
							>
								{t("blockedEmptyCreation")}
							</p>
						)}

						{/*
						 * One file, and it stands in for the paste rather than
						 * joining it: the dialog makes one document, so it has
						 * one source. Choosing a file disables the textarea
						 * instead of hiding it, so what the choice cost stays
						 * on screen.
						 */}
						<div className="flex flex-wrap items-center gap-2">
							<input
								id="source-file"
								data-testid="source-file-input"
								type="file"
								className="sr-only"
								accept={CONTEXT_UPLOAD_ACCEPT_ATTR}
								onChange={(e) => {
									const chosen = e.target.files?.[0] ?? null;
									// Reset first, so re-picking the same file
									// after a refusal fires change again.
									e.target.value = "";
									if (!chosen) {
										return;
									}
									const refusal = describeFileRefusal(chosen);
									if (refusal) {
										setFileRefusal(refusal);
										setSourceFile(null);
										return;
									}
									setFileRefusal(null);
									setSourceFile(chosen);
									// A file has one possible use, so the two
									// controls that would have expressed a
									// choice are settled here rather than left
									// showing one the submit cannot honour.
									setSourceUsage("AS_IS");
									setGenerateWithAiOverride(false);
								}}
							/>
							<Button
								type="button"
								variant="outline"
								size="sm"
								asChild
							>
								<label htmlFor="source-file">
									{t("attachFile")}
								</label>
							</Button>
							{sourceFile && (
								<span
									data-testid="source-file-chosen"
									className="text-muted-foreground text-xs"
								>
									{sourceFile.name}
								</span>
							)}
							{sourceFile && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => {
										setSourceFile(null);
										setFileRefusal(null);
									}}
								>
									{t("removeFile")}
								</Button>
							)}
						</div>
						{fileRefusal && (
							<p
								data-testid="source-file-refusal"
								role="alert"
								className="text-destructive text-sm"
							>
								{t("fileRefused", { reason: fileRefusal })}
							</p>
						)}
						<p
							data-testid="source-file-hint"
							className="text-muted-foreground text-xs"
						>
							{t("sourceFileHint")}
						</p>
						{sourceFile && (
							<p
								data-testid="file-used-as-is"
								className="text-muted-foreground text-xs"
							>
								{t("fileIsUsedAsIs")}
							</p>
						)}

						{aiAvailability === "unavailable" && (
							<p
								data-testid="source-retention-no-ai"
								className="text-muted-foreground text-xs"
							>
								{t("sourceBecomesDocumentNotice")}
							</p>
						)}

						{aiAvailability === "available" && (
							/*
							 * The height is reserved rather than collapsed, so
							 * the footer does not walk up and down the dialog
							 * as source content comes and goes. The entrance is
							 * motion-safe on top of that.
							 */
							<div className="min-h-[8.5rem]">
								{showUsageMode && (
									<div
										data-testid="source-usage-mode"
										className="rounded-lg border bg-muted/30 p-4 motion-safe:animate-in motion-safe:fade-in-0"
									>
										<p
											id={usageModeLabelId}
											className="mb-2 font-medium text-sm"
										>
											{t("sourceUsageLabel")}
										</p>
										<RadioGroup
											value={sourceUsage}
											onValueChange={(value) =>
												setSourceUsage(
													value as SourceUsage,
												)
											}
											aria-labelledby={usageModeLabelId}
											className="gap-3"
										>
											{/*
											 * R33: each option carries what
											 * happens to the pasted words, not
											 * just its name. The two names
											 * differ by two words and their
											 * consequences are opposite, so the
											 * outcome line is the part that
											 * actually decides.
											 */}
											<label
												htmlFor="source-usage-context"
												className="flex cursor-pointer items-start gap-2 text-sm"
											>
												<RadioGroupItem
													value="CONTEXT"
													id="source-usage-context"
													className="mt-0.5"
												/>
												<span className="block">
													<span className="block font-medium">
														{t(
															"sourceUsageContextLabel",
														)}
													</span>
													<span className="block text-muted-foreground text-xs">
														{t(
															"sourceUsageContextOutcome",
														)}
													</span>
												</span>
											</label>
											<label
												htmlFor="source-usage-as-is"
												className="flex cursor-pointer items-start gap-2 text-sm"
											>
												<RadioGroupItem
													value="AS_IS"
													id="source-usage-as-is"
													className="mt-0.5"
												/>
												<span className="block">
													<span className="block font-medium">
														{t(
															"sourceUsageAsIsLabel",
														)}
													</span>
													<span className="block text-muted-foreground text-xs">
														{t(
															"sourceUsageAsIsOutcome",
														)}
													</span>
												</span>
											</label>
										</RadioGroup>
									</div>
								)}
							</div>
						)}
					</div>
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={isSubmitting}
					>
						{t("cancel")}
					</Button>
					<Button onClick={handleCreate} disabled={!canSubmit}>
						{isSubmitting ? (
							<>
								<Loader2Icon className="mr-2 size-4 animate-spin motion-safe:animate-spin" />
								{t("submitting")}
							</>
						) : generateWithAI ? (
							<>
								<SparklesIcon className="mr-2 size-4" />
								{t("submitWithAi")}
							</>
						) : (
							t("submit")
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
