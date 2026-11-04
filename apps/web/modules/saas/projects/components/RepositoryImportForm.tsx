"use client";

/**
 * New Project → "Import from a repository" (specs/2026-10-23-repository-import
 * §6a). Pick or paste the product repository; the preview proposes the
 * title, description and tech stack, which stay editable. Create creates the
 * project, connects the repositories with the same GitHub connection, starts
 * the code analysis (`existingSetup.start`) and the repository import
 * (`repositoryImport.start`), then opens the project's overview, where the
 * import's checklist and proposal are reviewed.
 *
 * "My coding instructions live in a separate repository" picks a second
 * repository. It is connected with the product repository and configured as
 * the project's Coding Instructions sync (`repositorySync.configure`) before
 * the import starts, so the import does not offer to move the product
 * repository's AI tool files.
 *
 * "Other code repositories" connects more of the product's code (a backend,
 * a frontend, a service) beside the product repository; the analysis reads
 * them all as one product. "Keep documentation in Living Memory" connects a
 * repository (or one already listed) and syncs its folders into Living Memory
 * (`contexts.repositorySync.configure`, then the first sync). Each repository
 * reaches the analysis with its role (`repoRoles`), so the instructions and
 * the documentation are not read as product code.
 *
 * A pasted token, while the credential manager is on, is saved there by
 * default ("Save in the credential manager", `credentialManager.saveGitHubToken`)
 * instead of as the person's GitHub connection. The saved credential reads
 * the repository (`previewRepositoryImport`) and the import binds it to the
 * GitHub repositories it connects (`existingSetup.start`). When the person
 * already saved a token for the same account, the form asks: "Use it" reads
 * with that one, "Save as new" saves the token once more.
 */

import {
	GitHubTokenChecklist,
	type GitHubTokenRefusal,
	needsGitHubTokenConfirmation,
	readGitHubTokenRefusal,
} from "@saas/credential-manager/components/GitHubTokenChecklist";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { openOAuthPopup, POPUP_BLOCKED_MESSAGE } from "@shared/lib/oauth-popup";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
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
import { Textarea } from "@ui/components/textarea";
import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import {
	type ContextSyncNowResult,
	contextSyncConfigureErrorMessage,
	contextSyncNowResultMessage,
} from "../lib/context-repository-sync";
import {
	configureErrorMessage,
	repositorySyncTreeSelection,
} from "../lib/instructions-repository-sync";
import {
	type ExistingSavedToken,
	SavedTokenReusePrompt,
	SaveInCredentialManagerFields,
} from "./SavePastedTokenFields";
import { type GitHubRepo, GitHubRepoPicker } from "./wizard/GitHubRepoPicker";

type ImportedRepository = {
	owner: string;
	name: string;
	htmlUrl: string;
	defaultBranch: string;
};

type RepositoryReference = { owner: string; repo: string };

type ProjectPhase = "DISCOVERY_PLANNING" | "DEVELOPMENT_EXECUTION";

/** Local calendar day, not UTC — the same basis the date input's `min` uses. */
function todayIsoDate(): string {
	return new Date().toLocaleDateString("en-CA");
}

/** `owner/name`, `github.com/owner/name`, or its https / .git address. */
function parseRepositoryReference(value: string): RepositoryReference | null {
	const match = value
		.trim()
		.match(
			/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([A-Za-z0-9-]{1,100})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/,
		);
	return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : null;
}

/** "React, Vite" → ["React", "Vite"]: trimmed, without blanks or repeats. */
export function parseTechStack(value: string): string[] {
	const names: string[] = [];
	for (const part of value.split(",")) {
		const name = part.trim();
		if (name !== "" && !names.includes(name)) {
			names.push(name);
		}
	}
	return names;
}

function sameRepository(
	a: { owner: string; name: string },
	b: { repositoryOwner: string; repositoryName: string },
): boolean {
	return (
		a.owner.toLowerCase() === b.repositoryOwner.toLowerCase() &&
		a.name.toLowerCase() === b.repositoryName.toLowerCase()
	);
}

/** `owner/name`, lower-cased: one repository however it was typed. */
function repositoryKey(reference: RepositoryReference): string {
	return `${reference.owner}/${reference.repo}`.toLowerCase();
}

function githubUrl(reference: RepositoryReference): string {
	return `https://github.com/${reference.owner}/${reference.repo}`;
}

/**
 * "docs, adr/" → ["docs", "adr"]: the folders Living Memory syncs, without
 * the slashes around them; none typed is the whole repository (`""`).
 */
export function parseMemoryFolders(value: string): string[] {
	const folders: string[] = [];
	for (const part of value.split(",")) {
		const folder = part.trim().replace(/^\/+|\/+$/g, "");
		if (folder !== "" && !folders.includes(folder)) {
			folders.push(folder);
		}
	}
	return folders.length > 0 ? folders : [""];
}

export function RepositoryImportForm({
	organizationId,
	projectsBasePath,
	initialSource = "",
}: {
	organizationId: string;
	projectsBasePath: string;
	/** A repository to read on mount: the return from a GitHub sign-in. */
	initialSource?: string;
}) {
	const t = useTranslations("projects.newProjectStart.import");
	const tSync = useTranslations("projects.codingInstructions.repositorySync");
	const tMemory = useTranslations(
		"projects.contexts.livingMemory.repositorySync",
	);
	const id = useId();
	const router = useRouter();
	/** The repository the preview resolved; set once GitHub has answered. */
	const [repo, setRepo] = useState<ImportedRepository | null>(null);
	const [source, setSource] = useState(initialSource);
	/** GitHub could not be reached with the saved connection: offer one here. */
	const [needsAccess, setNeedsAccess] = useState(false);
	const [token, setToken] = useState("");
	const [savingToken, setSavingToken] = useState(false);
	const credentialManagerEnabled = useFeatureFlag("CREDENTIAL_MANAGER");
	const [saveTokenAsCredential, setSaveTokenAsCredential] = useState(true);
	const [tokenLabel, setTokenLabel] = useState("");
	const [existingSavedToken, setExistingSavedToken] =
		useState<ExistingSavedToken | null>(null);
	/** Why the server would not save the pasted token, as a checklist. */
	const [tokenCheck, setTokenCheck] = useState<GitHubTokenRefusal | null>(
		null,
	);
	const [permissionsConfirmed, setPermissionsConfirmed] = useState(false);
	/**
	 * The saved credential the import reads and connects with. A ref as well,
	 * so the read that follows choosing it already sends it.
	 */
	const [credentialId, setCredentialId] = useState<string | null>(null);
	const credentialIdRef = useRef<string | null>(null);
	/** Which field the repository picker fills while it is open. */
	const [pickerFor, setPickerFor] = useState<
		"product" | "instructions" | "code" | "memory" | null
	>(null);
	/** More of the product's code, as `owner/name`, beside the product repository. */
	const [codeRepositories, setCodeRepositories] = useState<string[]>([]);
	const [codeSource, setCodeSource] = useState("");
	const [codeProblem, setCodeProblem] = useState<string | null>(null);
	const [livingMemory, setLivingMemory] = useState(false);
	const [memorySource, setMemorySource] = useState("");
	const [memoryBranch, setMemoryBranch] = useState("");
	const [memoryFolders, setMemoryFolders] = useState("");
	const [memoryProblem, setMemoryProblem] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [techStack, setTechStack] = useState("");
	/** Proposed by the preview, or chosen; required, as on the scratch form. */
	const [phase, setPhase] = useState<ProjectPhase | "">("");
	const [expectedStart, setExpectedStart] = useState("");
	const [phaseProblem, setPhaseProblem] = useState<string | null>(null);
	const [separateInstructions, setSeparateInstructions] = useState(false);
	const [instructionsSource, setInstructionsSource] = useState("");
	/** The picker knows the default branch; a pasted name does not. */
	const [instructionsBranch, setInstructionsBranch] = useState("");
	const [instructionsFolder, setInstructionsFolder] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const [instructionsProblem, setInstructionsProblem] = useState<
		string | null
	>(null);
	const [importing, setImporting] = useState(false);
	const preview = useMutation(
		orpc.projects.previewRepositoryImport.mutationOptions(),
	);

	function errorMessage(error: unknown): string {
		return error instanceof Error && error.message
			? error.message
			: t("errors.generic");
	}

	async function read(input: {
		owner: string;
		repo: string;
		defaultBranch?: string;
		description?: string | null;
		language?: string | null;
	}) {
		setProblem(null);
		setNeedsAccess(false);
		setRepo(null);
		try {
			const proposed = await preview.mutateAsync({
				organizationId,
				...input,
				...(credentialIdRef.current
					? { credentialId: credentialIdRef.current }
					: {}),
			});
			setRepo(proposed.repository);
			setName(proposed.name);
			setDescription(proposed.description);
			setTechStack(proposed.techStack.join(", "));
			setPhase(proposed.projectPhase ?? "");
			setExpectedStart("");
			setPhaseProblem(null);
		} catch (error) {
			setProblem(errorMessage(error));
			const code = (error as { data?: { code?: string } }).data?.code;
			setNeedsAccess(
				code === "REPOSITORY_UNREADABLE" ||
					code === "GITHUB_NOT_CONNECTED",
			);
		}
	}

	// Back from a GitHub sign-in with the repository in the address: read it,
	// once, on mount.
	useEffect(() => {
		if (initialSource !== "") {
			readTyped();
		}
	}, []);

	function adoptSavedCredential(id: string) {
		credentialIdRef.current = id;
		setCredentialId(id);
		setExistingSavedToken(null);
		setToken("");
		setTokenLabel("");
		readTyped();
	}

	/**
	 * Saves the pasted token, then reads again: in the credential manager
	 * when the box is ticked, otherwise as the user's GitHub connection.
	 */
	async function saveToken(saveAsNew = false) {
		setSavingToken(true);
		try {
			if (credentialManagerEnabled && saveTokenAsCredential) {
				const target = parseRepositoryReference(source);
				if (!target) {
					setProblem(t("errors.repositoryFormat"));
					return;
				}
				const result =
					await orpcClient.credentialManager.saveGitHubToken({
						organizationId,
						token: token.trim(),
						owner: target.owner,
						repo: target.repo,
						label: tokenLabel.trim() || undefined,
						saveAsNew,
						confirmFineGrainedPermissions: permissionsConfirmed,
					});
				setTokenCheck(null);
				if (result.existingCredential) {
					setExistingSavedToken(result.existingCredential);
					return;
				}
				if (result.credential) {
					adoptSavedCredential(result.credential.id);
				}
				return;
			}
			await orpcClient.workflows.integrations.save({
				type: "GITHUB",
				credentials: { GITHUB_TOKEN: token.trim() },
				organizationId,
			});
			setToken("");
			readTyped();
		} catch (error) {
			const refusal = readGitHubTokenRefusal(error);
			if (refusal) {
				setTokenCheck(refusal);
				return;
			}
			setProblem(errorMessage(error));
		} finally {
			setSavingToken(false);
		}
	}

	/**
	 * GitHub sign-in in a popup, so this form keeps its state; when the
	 * popup reports success the repository is read again. The popup opens
	 * on the click itself (before the start request) so it is not blocked.
	 */
	async function signInWithGitHub() {
		const popup = openOAuthPopup({
			url: "about:blank",
			name: "github-oauth-import",
		});
		if (!popup) {
			// No popups here (a browser or an embedded view that blocks them):
			// sign in in this tab, and come back to this form with the
			// repository, which is read again on return.
			const back = new URL(window.location.href);
			back.searchParams.set("import", source.trim());
			try {
				const { authorizationUrl } =
					await orpcClient.integrations.github.start({
						redirectUri: `${window.location.origin}/api/integrations/github/oauth/callback`,
						returnUrl: back.pathname + back.search,
						organizationId,
						targetType: "user",
					});
				window.location.assign(authorizationUrl);
			} catch (error) {
				setProblem(`${POPUP_BLOCKED_MESSAGE} ${errorMessage(error)}`);
			}
			return;
		}
		const onMessage = (event: MessageEvent) => {
			const data = event.data as {
				type?: string;
				provider?: string;
			} | null;
			if (
				event.origin !== window.location.origin ||
				(data?.type !== "github_oauth_success" &&
					data?.type !== "github_oauth_error")
			) {
				return;
			}
			window.removeEventListener("message", onMessage);
			if (data.type === "github_oauth_success") {
				readTypedRef.current();
			} else {
				setProblem(t("errors.signInIncomplete"));
			}
		};
		window.addEventListener("message", onMessage);
		try {
			const { authorizationUrl } =
				await orpcClient.integrations.github.start({
					redirectUri: `${window.location.origin}/api/integrations/github/oauth/callback`,
					returnUrl: window.location.pathname,
					organizationId,
					targetType: "user",
				});
			popup.location.href = authorizationUrl;
		} catch (error) {
			popup.close();
			window.removeEventListener("message", onMessage);
			setProblem(errorMessage(error));
		}
	}

	function readTyped() {
		const parsed = parseRepositoryReference(source);
		if (!parsed) {
			setProblem(t("errors.repositoryFormat"));
			return;
		}
		void read(parsed);
	}
	// The popup's message arrives after renders; read with the latest field.
	const readTypedRef = useRef(readTyped);
	readTypedRef.current = readTyped;

	function choose(next: GitHubRepo) {
		setSource(next.fullName);
		void read({
			owner: next.owner,
			repo: next.name,
			defaultBranch: next.defaultBranch,
			description: next.description,
			language: next.language,
		});
	}

	const instructionsRepo = separateInstructions
		? parseRepositoryReference(instructionsSource)
		: null;

	/** Why the separate instructions repository cannot be used, if it cannot. */
	function instructionsRefusal(): string | null {
		if (!separateInstructions) {
			return null;
		}
		if (!instructionsRepo) {
			return t("errors.repositoryFormat");
		}
		if (
			repo &&
			sameRepository(
				{ owner: instructionsRepo.owner, name: instructionsRepo.repo },
				{
					repositoryOwner: repo.owner,
					repositoryName: repo.name,
				},
			)
		) {
			return t("errors.instructionsSameRepository");
		}
		if (
			codeRepositories.some((value) => {
				const parsed = parseRepositoryReference(value);
				return (
					parsed !== null &&
					repositoryKey(parsed) === repositoryKey(instructionsRepo)
				);
			})
		) {
			return t("errors.instructionsIsCode");
		}
		return null;
	}

	/** The product repository and everything else already chosen, by key. */
	function chosenRepositoryKeys(): Set<string> {
		const keys = new Set(
			codeRepositories.flatMap((value) => {
				const parsed = parseRepositoryReference(value);
				return parsed ? [repositoryKey(parsed)] : [];
			}),
		);
		if (repo) {
			keys.add(repositoryKey({ owner: repo.owner, repo: repo.name }));
		}
		return keys;
	}

	/** Adds one more code repository, or says why it cannot be added. */
	function addCodeRepository(value: string) {
		const parsed = parseRepositoryReference(value);
		if (!parsed) {
			setCodeProblem(t("errors.repositoryFormat"));
			return;
		}
		if (chosenRepositoryKeys().has(repositoryKey(parsed))) {
			setCodeProblem(t("errors.codeRepositoryListed"));
			return;
		}
		if (
			instructionsRepo &&
			repositoryKey(instructionsRepo) === repositoryKey(parsed)
		) {
			setCodeProblem(t("errors.codeRepositoryIsInstructions"));
			return;
		}
		setCodeRepositories((list) => [
			...list,
			`${parsed.owner}/${parsed.repo}`,
		]);
		setCodeSource("");
		setCodeProblem(null);
	}

	const extraCodeRepos = codeRepositories.flatMap((value) => {
		const parsed = parseRepositoryReference(value);
		return parsed ? [parsed] : [];
	});
	const memoryRepo = livingMemory
		? parseRepositoryReference(memorySource)
		: null;

	/** Why the Living Memory repository cannot be used, if it cannot. */
	function memoryRefusal(): string | null {
		if (!livingMemory) {
			return null;
		}
		if (!memoryRepo) {
			return t("errors.repositoryFormat");
		}
		if (
			instructionsRepo &&
			repositoryKey(instructionsRepo) === repositoryKey(memoryRepo)
		) {
			return t("errors.memoryIsInstructions");
		}
		return null;
	}

	/** The project's connected repositories, as the sync settings list them. */
	async function connectedRepositories(projectId: string) {
		const { availableIntegrations } =
			await orpcClient.projects.instructions.repositorySync.get({
				projectId,
			});
		return availableIntegrations;
	}

	/**
	 * Syncs the chosen folders of the Living Memory repository into the new
	 * project's Living Memory and starts the first sync, as the Living Memory
	 * dialog does. A failure is reported; the project stands either way.
	 */
	async function configureLivingMemory(
		projectId: string,
		memory: RepositoryReference,
		integrations: Awaited<ReturnType<typeof connectedRepositories>>,
	) {
		const integration = integrations.find((i) =>
			sameRepository({ owner: memory.owner, name: memory.repo }, i),
		);
		if (!integration) {
			toast.error(t("errors.memoryNotConnected"));
			return;
		}
		const ref = memoryBranch.trim() || integration.defaultBranch;
		try {
			const saved =
				await orpcClient.projects.contexts.repositorySync.configure({
					projectId,
					organizationId,
					repositoryIntegrationId: integration.id,
					ref,
					paths: parseMemoryFolders(memoryFolders),
				});
			if ("syncQueued" in saved) {
				return;
			}
		} catch (error) {
			const mapped = contextSyncConfigureErrorMessage(error, ref);
			toast.error(
				t("errors.memoryNotConfigured", {
					reason: tMemory(mapped.key, mapped.values),
				}),
			);
			return;
		}
		try {
			const result =
				(await orpcClient.projects.contexts.repositorySync.syncNow({
					projectId,
					organizationId,
				})) as ContextSyncNowResult;
			const announced = contextSyncNowResultMessage(result);
			if (announced.tone === "error") {
				toast.error(tMemory(announced.key));
			}
		} catch {
			toast.error(t("errors.memoryNotSynced"));
		}
	}

	/**
	 * Points the new project's Coding Instructions at the connected
	 * instructions repository.
	 */
	async function configureInstructions(
		projectId: string,
		instructions: RepositoryReference,
		integrations: Awaited<ReturnType<typeof connectedRepositories>>,
	): Promise<void> {
		const instructionsIntegration = integrations.find((i) =>
			sameRepository(
				{ owner: instructions.owner, name: instructions.repo },
				i,
			),
		);
		if (!instructionsIntegration) {
			toast.error(t("errors.instructionsNotConnected"));
			return;
		}
		const ref =
			instructionsBranch.trim() || instructionsIntegration.defaultBranch;
		try {
			await orpcClient.projects.instructions.repositorySync.configure({
				projectId,
				repositoryIntegrationId: instructionsIntegration.id,
				ref,
				rootPath: repositorySyncTreeSelection(instructionsFolder),
			});
		} catch (error) {
			toast.error(
				t("errors.instructionsNotConfigured", {
					reason: tSync(configureErrorMessage(error).key, { ref }),
				}),
			);
		}
	}

	/** Why the phase cannot be saved as chosen, if it cannot (the scratch form's rules). */
	function phaseRefusal(): string | null {
		if (phase === "") {
			return t("errors.phaseRequired");
		}
		if (phase === "DISCOVERY_PLANNING") {
			if (expectedStart === "") {
				return t("errors.expectedStartRequired");
			}
			if (expectedStart < todayIsoDate()) {
				return t("errors.expectedStartPast");
			}
		}
		return null;
	}

	async function createProject() {
		if (!repo) {
			return;
		}
		const phaseIssue = phaseRefusal();
		setPhaseProblem(phaseIssue);
		const refusal = instructionsRefusal();
		setInstructionsProblem(refusal);
		const memoryIssue = memoryRefusal();
		setMemoryProblem(memoryIssue);
		if (phaseIssue || refusal || memoryIssue || phase === "") {
			return;
		}
		setProblem(null);
		setImporting(true);
		try {
			const { project } = await orpcClient.projects.create({
				name: name.trim(),
				description: description.trim() || undefined,
				techStack: parseTechStack(techStack),
				projectPhase: phase,
				expectedDevelopmentStartDate:
					phase === "DISCOVERY_PLANNING"
						? new Date(expectedStart)
						: undefined,
				organizationId,
				repositoryUrl: repo.htmlUrl,
				repositoryOwner: repo.owner,
				repositoryName: repo.name,
				defaultBranch: repo.defaultBranch,
			});
			const instructionsUrl = instructionsRepo
				? githubUrl(instructionsRepo)
				: null;
			// The Living Memory repository is connected here only when it is
			// not one of the code repositories already listed.
			const memoryUrl =
				memoryRepo &&
				!chosenRepositoryKeys().has(repositoryKey(memoryRepo))
					? githubUrl(memoryRepo)
					: null;
			const repoRoles: Record<string, "instructions" | "knowledge"> = {
				...(instructionsUrl
					? { [instructionsUrl]: "instructions" }
					: {}),
				...(memoryUrl ? { [memoryUrl]: "knowledge" } : {}),
			};
			try {
				const setup = await orpcClient.projects.existingSetup.start({
					projectId: project.id,
					organizationId,
					repoUrls: [
						repo.htmlUrl,
						...extraCodeRepos.map(githubUrl),
						...(instructionsUrl ? [instructionsUrl] : []),
						...(memoryUrl ? [memoryUrl] : []),
					],
					...(instructionsUrl
						? { repoTags: { [instructionsUrl]: "instructions" } }
						: {}),
					...(Object.keys(repoRoles).length > 0 ? { repoRoles } : {}),
					selectedDocumentTypes: [],
					projectTypes: [],
					projectName: project.name,
					...(credentialId ? { credentialId } : {}),
				});
				// A repository the connection could not read is skipped, not
				// refused: the project keeps only its link until it is added.
				if (setup?.skippedRepos?.length) {
					toast.error(
						t("errors.notConnected", {
							repositories: setup.skippedRepos.join(", "),
						}),
					);
				}
				// With more than one repository connected, the import is told
				// which one is the product's.
				const integrations =
					instructionsRepo || memoryRepo || extraCodeRepos.length > 0
						? await connectedRepositories(project.id)
						: [];
				if (instructionsRepo) {
					await configureInstructions(
						project.id,
						instructionsRepo,
						integrations,
					);
				}
				if (memoryRepo) {
					await configureLivingMemory(
						project.id,
						memoryRepo,
						integrations,
					);
				}
				const repositoryIntegrationId = integrations.find((i) =>
					sameRepository(repo, i),
				)?.id;
				await orpcClient.projects.repositoryImport.start({
					projectId: project.id,
					organizationId,
					...(repositoryIntegrationId
						? { repositoryIntegrationId }
						: {}),
				});
			} catch (error) {
				toast.error(
					t("errors.createdNotRead", { reason: errorMessage(error) }),
				);
			}
			toast.success(t("created"));
			router.push(`${projectsBasePath}/${project.id}?tab=overview`);
		} catch (error) {
			setProblem(errorMessage(error));
		} finally {
			setImporting(false);
		}
	}

	const aiFileCount = preview.data?.aiFileCount ?? 0;
	const pending = preview.isPending || importing;
	const ids = {
		source: `${id}-source`,
		token: `${id}-token`,
		tokenHint: `${id}-token-hint`,
		name: `${id}-name`,
		description: `${id}-description`,
		techStack: `${id}-tech-stack`,
		techStackHint: `${id}-tech-stack-hint`,
		phase: `${id}-phase`,
		phaseHint: `${id}-phase-hint`,
		phaseError: `${id}-phase-error`,
		expectedStart: `${id}-expected-start`,
		expectedStartHint: `${id}-expected-start-hint`,
		separate: `${id}-separate`,
		instructionsSource: `${id}-instructions-source`,
		instructionsBranch: `${id}-instructions-branch`,
		instructionsFolder: `${id}-instructions-folder`,
		instructionsFolderHint: `${id}-instructions-folder-hint`,
		instructionsError: `${id}-instructions-error`,
		codeSource: `${id}-code-source`,
		codeHint: `${id}-code-hint`,
		codeError: `${id}-code-error`,
		memory: `${id}-memory`,
		memorySource: `${id}-memory-source`,
		memoryBranch: `${id}-memory-branch`,
		memoryFolders: `${id}-memory-folders`,
		memoryFoldersHint: `${id}-memory-folders-hint`,
		memoryError: `${id}-memory-error`,
	};

	return (
		<div className="mx-auto w-full max-w-2xl">
			<GitHubRepoPicker
				open={pickerFor !== null}
				onOpenChange={(next) => {
					if (!next) {
						setPickerFor(null);
					}
				}}
				organizationId={organizationId}
				onConfirm={(repos) => {
					const target = pickerFor;
					setPickerFor(null);
					const last = repos[repos.length - 1];
					if (!last) {
						return;
					}
					if (target === "instructions") {
						setInstructionsSource(last.fullName);
						setInstructionsBranch(last.defaultBranch);
						setInstructionsProblem(null);
					} else if (target === "code") {
						for (const picked of repos) {
							addCodeRepository(picked.fullName);
						}
					} else if (target === "memory") {
						setMemorySource(last.fullName);
						setMemoryBranch(last.defaultBranch);
						setMemoryProblem(null);
					} else {
						choose(last);
					}
				}}
			/>
			<div className="flex flex-col gap-6">
				<form
					className="flex flex-col gap-1.5"
					onSubmit={(event) => {
						event.preventDefault();
						if (!pending) {
							readTyped();
						}
					}}
				>
					<Label htmlFor={ids.source}>{t("repositoryLabel")}</Label>
					<div className="flex gap-2">
						<Input
							id={ids.source}
							value={source}
							disabled={pending}
							placeholder={t("repositoryPlaceholder")}
							onChange={(e) => setSource(e.target.value)}
						/>
						<Button
							type="submit"
							variant="outline"
							disabled={pending || source.trim() === ""}
						>
							{t("read")}
						</Button>
					</div>
					<button
						type="button"
						className="self-start text-muted-foreground text-xs underline"
						disabled={pending}
						onClick={() => setPickerFor("product")}
					>
						{t("browse")}
					</button>
				</form>
				{preview.isPending ? (
					<p
						className="flex items-center gap-2 text-muted-foreground text-sm"
						aria-live="polite"
					>
						<Loader2Icon
							className="size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						{t("reading")}
					</p>
				) : null}
				{needsAccess ? (
					<div className="flex flex-col gap-2 rounded-md border p-3">
						<p className="font-medium text-sm">
							{t("access.title")}
						</p>
						<Button
							type="button"
							variant="outline"
							disabled={pending || savingToken}
							onClick={() => void signInWithGitHub()}
						>
							{t("access.signIn")}
						</Button>
						<form
							className="flex flex-col gap-1.5"
							onSubmit={(event) => {
								event.preventDefault();
								if (
									token.trim() !== "" &&
									!savingToken &&
									!needsGitHubTokenConfirmation(
										tokenCheck,
										permissionsConfirmed,
									)
								) {
									void saveToken();
								}
							}}
						>
							<Label htmlFor={ids.token}>
								{t("access.tokenLabel")}
							</Label>
							<div className="flex gap-2">
								<Input
									id={ids.token}
									type="password"
									autoComplete="off"
									value={token}
									disabled={savingToken}
									onChange={(e) => {
										setToken(e.target.value);
										setExistingSavedToken(null);
										setTokenCheck(null);
										setPermissionsConfirmed(false);
									}}
									aria-describedby={
										credentialManagerEnabled &&
										saveTokenAsCredential
											? undefined
											: ids.tokenHint
									}
								/>
								<Button
									type="submit"
									disabled={
										savingToken ||
										token.trim() === "" ||
										needsGitHubTokenConfirmation(
											tokenCheck,
											permissionsConfirmed,
										)
									}
								>
									{savingToken ? (
										<Loader2Icon
											className="size-4 motion-safe:animate-spin"
											aria-hidden="true"
										/>
									) : null}
									{t("access.save")}
								</Button>
							</div>
							{credentialManagerEnabled ? (
								<SaveInCredentialManagerFields
									save={saveTokenAsCredential}
									onSaveChange={(next) => {
										setSaveTokenAsCredential(next);
										setExistingSavedToken(null);
									}}
									label={tokenLabel}
									onLabelChange={setTokenLabel}
									disabled={savingToken}
								/>
							) : null}
							{tokenCheck ? (
								<GitHubTokenChecklist
									refusal={tokenCheck}
									confirmed={permissionsConfirmed}
									onConfirmedChange={setPermissionsConfirmed}
								/>
							) : null}
							{existingSavedToken ? (
								<SavedTokenReusePrompt
									existing={existingSavedToken}
									busy={savingToken}
									onUse={() =>
										adoptSavedCredential(
											existingSavedToken.id,
										)
									}
									onSaveAsNew={() => void saveToken(true)}
								/>
							) : null}
							{credentialManagerEnabled &&
							saveTokenAsCredential ? null : (
								<p
									id={ids.tokenHint}
									className="text-muted-foreground text-xs"
								>
									{t("access.tokenHint")}
								</p>
							)}
						</form>
					</div>
				) : null}
				{repo ? (
					<form
						className="flex flex-col gap-6"
						aria-label={t("detailsLabel")}
						onSubmit={(event) => {
							event.preventDefault();
							if (!pending && name.trim() !== "") {
								void createProject();
							}
						}}
					>
						<p className="text-sm">
							<a
								href={repo.htmlUrl}
								target="_blank"
								rel="noreferrer"
								className="underline"
							>
								{`${repo.owner}/${repo.name}`}
							</a>{" "}
							<span className="text-muted-foreground">
								({repo.defaultBranch})
							</span>
						</p>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={ids.name}>{t("nameLabel")}</Label>
							<Input
								id={ids.name}
								value={name}
								required
								disabled={pending}
								onChange={(e) => setName(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={ids.description}>
								{t("descriptionLabel")}
							</Label>
							<Textarea
								id={ids.description}
								value={description}
								rows={5}
								disabled={pending}
								onChange={(e) => setDescription(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={ids.techStack}>
								{t("techStackLabel")}
							</Label>
							<Input
								id={ids.techStack}
								value={techStack}
								disabled={pending}
								aria-describedby={ids.techStackHint}
								onChange={(e) => setTechStack(e.target.value)}
							/>
							<p
								id={ids.techStackHint}
								className="text-muted-foreground text-xs"
							>
								{t("techStackHint")}
							</p>
						</div>
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={ids.phase}>
									{t("phaseLabel")}
								</Label>
								<Select
									value={phase}
									disabled={pending}
									onValueChange={(value) => {
										// Radix re-emits an empty value while it
										// syncs a controlled value set from outside
										// the trigger (the preview); no item has one.
										if (!value) {
											return;
										}
										setPhase(value as ProjectPhase);
										setPhaseProblem(null);
										if (value === "DEVELOPMENT_EXECUTION") {
											setExpectedStart("");
										}
									}}
								>
									<SelectTrigger
										id={ids.phase}
										aria-invalid={
											phaseProblem && phase === ""
												? true
												: undefined
										}
										aria-describedby={
											phaseProblem
												? `${ids.phaseHint} ${ids.phaseError}`
												: ids.phaseHint
										}
									>
										<SelectValue
											placeholder={t("phasePlaceholder")}
										/>
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="DISCOVERY_PLANNING">
											{t("phases.DISCOVERY_PLANNING")}
										</SelectItem>
										<SelectItem value="DEVELOPMENT_EXECUTION">
											{t("phases.DEVELOPMENT_EXECUTION")}
										</SelectItem>
									</SelectContent>
								</Select>
								<p
									id={ids.phaseHint}
									className="text-muted-foreground text-xs"
								>
									{t("phaseHint")}
								</p>
							</div>
							{phase === "DISCOVERY_PLANNING" ? (
								<div className="flex flex-col gap-1.5">
									<Label htmlFor={ids.expectedStart}>
										{t("expectedStartLabel")}
									</Label>
									<Input
										id={ids.expectedStart}
										type="date"
										min={todayIsoDate()}
										value={expectedStart}
										disabled={pending}
										aria-invalid={
											phaseProblem ? true : undefined
										}
										aria-describedby={
											phaseProblem
												? `${ids.expectedStartHint} ${ids.phaseError}`
												: ids.expectedStartHint
										}
										onChange={(e) => {
											setExpectedStart(e.target.value);
											setPhaseProblem(null);
										}}
									/>
									<p
										id={ids.expectedStartHint}
										className="text-muted-foreground text-xs"
									>
										{t("expectedStartHint")}
									</p>
								</div>
							) : null}
						</div>
						{phaseProblem ? (
							<p
								id={ids.phaseError}
								role="alert"
								className="text-destructive text-xs"
							>
								{phaseProblem}
							</p>
						) : null}
						<div className="flex flex-col gap-3">
							<div className="flex items-start gap-2">
								<Checkbox
									id={ids.separate}
									checked={separateInstructions}
									disabled={pending}
									onCheckedChange={(checked) => {
										setSeparateInstructions(
											checked === true,
										);
										setInstructionsProblem(null);
									}}
								/>
								<Label
									htmlFor={ids.separate}
									className="font-normal leading-snug"
								>
									{t("instructions.separate")}
								</Label>
							</div>
							{separateInstructions ? (
								<fieldset className="flex flex-col gap-4 rounded-md border p-3">
									<legend className="px-1 font-medium text-sm">
										{t("instructions.legend")}
									</legend>
									<div className="flex flex-col gap-1.5">
										<Label htmlFor={ids.instructionsSource}>
											{t("repositoryLabel")}
										</Label>
										<Input
											id={ids.instructionsSource}
											value={instructionsSource}
											disabled={pending}
											placeholder={t(
												"repositoryPlaceholder",
											)}
											aria-invalid={
												instructionsProblem
													? true
													: undefined
											}
											aria-describedby={
												instructionsProblem
													? ids.instructionsError
													: undefined
											}
											onChange={(e) => {
												setInstructionsSource(
													e.target.value,
												);
												setInstructionsBranch("");
												setInstructionsProblem(null);
											}}
										/>
										<button
											type="button"
											className="self-start text-muted-foreground text-xs underline"
											disabled={pending}
											onClick={() =>
												setPickerFor("instructions")
											}
										>
											{t("browse")}
										</button>
									</div>
									<div className="grid gap-4 sm:grid-cols-2">
										<div className="flex flex-col gap-1.5">
											<Label
												htmlFor={ids.instructionsBranch}
											>
												{t("instructions.branchLabel")}
											</Label>
											<Input
												id={ids.instructionsBranch}
												value={instructionsBranch}
												disabled={pending}
												placeholder={t(
													"instructions.branchPlaceholder",
												)}
												onChange={(e) =>
													setInstructionsBranch(
														e.target.value,
													)
												}
											/>
										</div>
										<div className="flex flex-col gap-1.5">
											<Label
												htmlFor={ids.instructionsFolder}
											>
												{t("instructions.folderLabel")}
											</Label>
											<Input
												id={ids.instructionsFolder}
												value={instructionsFolder}
												disabled={pending}
												placeholder={t(
													"instructions.folderPlaceholder",
												)}
												aria-describedby={
													ids.instructionsFolderHint
												}
												onChange={(e) =>
													setInstructionsFolder(
														e.target.value,
													)
												}
											/>
										</div>
									</div>
									<p
										id={ids.instructionsFolderHint}
										className="text-muted-foreground text-xs"
									>
										{t("instructions.folderHint")}
									</p>
									{instructionsProblem ? (
										<p
											id={ids.instructionsError}
											role="alert"
											className="text-destructive text-xs"
										>
											{instructionsProblem}
										</p>
									) : null}
								</fieldset>
							) : null}
						</div>
						<fieldset className="flex flex-col gap-3">
							<legend className="font-medium text-sm">
								{t("code.legend")}
							</legend>
							<p
								id={ids.codeHint}
								className="text-muted-foreground text-xs"
							>
								{t("code.hint")}
							</p>
							{codeRepositories.length > 0 ? (
								<ul className="flex flex-col gap-1">
									{codeRepositories.map((value) => (
										<li
											key={value}
											className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm"
										>
											<span>{value}</span>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												disabled={pending}
												aria-label={t("code.remove", {
													repository: value,
												})}
												onClick={() =>
													setCodeRepositories(
														(list) =>
															list.filter(
																(item) =>
																	item !==
																	value,
															),
													)
												}
											>
												{t("code.removeShort")}
											</Button>
										</li>
									))}
								</ul>
							) : null}
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={ids.codeSource}>
									{t("repositoryLabel")}
								</Label>
								<div className="flex gap-2">
									<Input
										id={ids.codeSource}
										value={codeSource}
										disabled={pending}
										placeholder={t("repositoryPlaceholder")}
										aria-invalid={
											codeProblem ? true : undefined
										}
										aria-describedby={
											codeProblem
												? `${ids.codeHint} ${ids.codeError}`
												: ids.codeHint
										}
										onChange={(e) => {
											setCodeSource(e.target.value);
											setCodeProblem(null);
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												if (codeSource.trim() !== "") {
													addCodeRepository(
														codeSource,
													);
												}
											}
										}}
									/>
									<Button
										type="button"
										variant="outline"
										disabled={
											pending || codeSource.trim() === ""
										}
										onClick={() =>
											addCodeRepository(codeSource)
										}
									>
										{t("code.add")}
									</Button>
								</div>
								<button
									type="button"
									className="self-start text-muted-foreground text-xs underline"
									disabled={pending}
									onClick={() => setPickerFor("code")}
								>
									{t("browse")}
								</button>
								{codeProblem ? (
									<p
										id={ids.codeError}
										role="alert"
										className="text-destructive text-xs"
									>
										{codeProblem}
									</p>
								) : null}
							</div>
						</fieldset>
						<div className="flex flex-col gap-3">
							<div className="flex items-start gap-2">
								<Checkbox
									id={ids.memory}
									checked={livingMemory}
									disabled={pending}
									onCheckedChange={(checked) => {
										setLivingMemory(checked === true);
										setMemoryProblem(null);
									}}
								/>
								<Label
									htmlFor={ids.memory}
									className="font-normal leading-snug"
								>
									{t("memory.toggle")}
								</Label>
							</div>
							{livingMemory ? (
								<fieldset className="flex flex-col gap-4 rounded-md border p-3">
									<legend className="px-1 font-medium text-sm">
										{t("memory.legend")}
									</legend>
									<div className="flex flex-col gap-1.5">
										<Label htmlFor={ids.memorySource}>
											{t("repositoryLabel")}
										</Label>
										<Input
											id={ids.memorySource}
											value={memorySource}
											disabled={pending}
											placeholder={t(
												"memory.repositoryPlaceholder",
											)}
											aria-invalid={
												memoryProblem ? true : undefined
											}
											aria-describedby={
												memoryProblem
													? ids.memoryError
													: undefined
											}
											onChange={(e) => {
												setMemorySource(e.target.value);
												setMemoryBranch("");
												setMemoryProblem(null);
											}}
										/>
										<button
											type="button"
											className="self-start text-muted-foreground text-xs underline"
											disabled={pending}
											onClick={() =>
												setPickerFor("memory")
											}
										>
											{t("browse")}
										</button>
									</div>
									<div className="grid gap-4 sm:grid-cols-2">
										<div className="flex flex-col gap-1.5">
											<Label htmlFor={ids.memoryBranch}>
												{t("instructions.branchLabel")}
											</Label>
											<Input
												id={ids.memoryBranch}
												value={memoryBranch}
												disabled={pending}
												placeholder={t(
													"instructions.branchPlaceholder",
												)}
												onChange={(e) =>
													setMemoryBranch(
														e.target.value,
													)
												}
											/>
										</div>
										<div className="flex flex-col gap-1.5">
											<Label htmlFor={ids.memoryFolders}>
												{t("memory.foldersLabel")}
											</Label>
											<Input
												id={ids.memoryFolders}
												value={memoryFolders}
												disabled={pending}
												placeholder={t(
													"instructions.folderPlaceholder",
												)}
												aria-describedby={
													ids.memoryFoldersHint
												}
												onChange={(e) =>
													setMemoryFolders(
														e.target.value,
													)
												}
											/>
										</div>
									</div>
									<p
										id={ids.memoryFoldersHint}
										className="text-muted-foreground text-xs"
									>
										{t("memory.foldersHint")}
									</p>
									{memoryProblem ? (
										<p
											id={ids.memoryError}
											role="alert"
											className="text-destructive text-xs"
										>
											{memoryProblem}
										</p>
									) : null}
								</fieldset>
							) : null}
						</div>
						{aiFileCount > 0 ? (
							<p className="text-sm">
								{separateInstructions
									? t("aiFilesStay", { count: aiFileCount })
									: t("aiFilesMove", { count: aiFileCount })}
							</p>
						) : null}
						<p className="text-muted-foreground text-sm">
							{t("next")}
						</p>
						<div className="flex justify-end">
							<Button
								type="submit"
								disabled={pending || name.trim() === ""}
							>
								{importing ? (
									<Loader2Icon
										className="size-4 motion-safe:animate-spin"
										aria-hidden="true"
									/>
								) : null}
								{t("create")}
							</Button>
						</div>
					</form>
				) : null}
				{problem ? (
					<p role="alert" className="text-destructive text-xs">
						{problem}
					</p>
				) : null}
			</div>
		</div>
	);
}
