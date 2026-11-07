import { buildFabricAgentHref } from "@saas/agents/lib/fabric-agent-links";
import { formatDistanceToNow } from "date-fns";
import type { HomeActionItem, HomeProjectShortcut } from "./home-model";

export type CuratedCardKind =
	| "review"
	| "project"
	| "context"
	| "create"
	| "ask"
	| "automate";

export type CuratedFeedbackAction =
	| "click"
	| "pin"
	| "unpin"
	| "dismiss"
	| "restore";

export interface CuratedCard {
	key: string;
	kind: CuratedCardKind;
	title: string;
	description: string;
	actionLabel: string;
	href: string;
	projectId?: string;
	score: number;
	pinned?: boolean;
}

export interface CuratedFeedback {
	cardKey: string;
	pinnedAt: Date | string | null;
	dismissedAt: Date | string | null;
	clickCount: number;
	lastClickedAt: Date | string | null;
}

interface CuratedCandidate extends CuratedCard {
	order: number;
}

function timestamp(value: Date | string | null | undefined): number {
	if (!value) {
		return 0;
	}
	const result = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isFinite(result) ? result : 0;
}

function recencyBoost(value: Date | string | null | undefined, now: Date) {
	const time = timestamp(value);
	if (!time) {
		return 0;
	}
	const ageDays = Math.max(0, now.getTime() - time) / 86_400_000;
	return Math.max(0, 10 - ageDays / 3);
}

function projectAffinity(
	project: HomeProjectShortcut | undefined,
	projectIndex: number,
	now: Date,
) {
	if (!project) {
		return 0;
	}
	return (
		(project.isFavorite ? 20 : 0) +
		recencyBoost(project.lastVisitedAt, now) +
		Math.max(0, 5 - projectIndex)
	);
}

export function buildCuratedCards({
	needsYou,
	projects,
	basePath,
	isOrganizationAdmin,
	feedback = [],
	now = new Date(),
}: {
	needsYou: HomeActionItem[];
	projects: HomeProjectShortcut[];
	basePath: string;
	isOrganizationAdmin: boolean;
	feedback?: CuratedFeedback[];
	now?: Date;
}): CuratedCard[] {
	const candidates: CuratedCandidate[] = [];
	const firstProject = projects[0];
	const add = (card: Omit<CuratedCandidate, "order">) => {
		candidates.push({ ...card, order: candidates.length });
	};

	for (const [index, action] of needsYou.entries()) {
		const projectIndex = projects.findIndex(
			(project) => project.id === action.projectId,
		);
		add({
			key: `review:${action.id}`,
			kind: "review",
			title: action.title,
			description: `${action.reason}${action.projectName ? ` · ${action.projectName}` : ""}`,
			actionLabel: action.actionLabel,
			href: action.href,
			projectId: action.projectId ?? undefined,
			score:
				100 -
				action.priority * 10 -
				index +
				recencyBoost(action.updatedAt, now) +
				projectAffinity(projects[projectIndex], projectIndex, now),
		});
	}

	for (const [index, project] of projects.entries()) {
		add({
			key: `project:${project.id}`,
			kind: "project",
			title: project.name,
			description: project.lastVisitedAt
				? `Continue where you left off ${formatDistanceToNow(project.lastVisitedAt, { addSuffix: true })}.`
				: "Continue with your most recent project.",
			actionLabel: "Open project",
			href: `${basePath}/projects/${project.id}`,
			projectId: project.id,
			score: 55 - index + projectAffinity(project, index, now),
		});
	}

	if (needsYou.length === 0 && firstProject) {
		add({
			key: `create-feature:${firstProject.id}`,
			kind: "create",
			title: "Turn an idea into a feature",
			description:
				"Start with a real requirement and let Fabric help you shape it.",
			actionLabel: "Create feature",
			href: `${basePath}/projects/${firstProject.id}?createStory=true`,
			projectId: firstProject.id,
			score: 50 + projectAffinity(firstProject, 0, now),
		});
		add({
			key: `context:${firstProject.id}`,
			kind: "context",
			title: "Strengthen your project evidence",
			description:
				"Connect documents, decisions, and repository context so agents have the same context your team does.",
			actionLabel: "Add context",
			href: `${basePath}/projects/${firstProject.id}?tab=context`,
			projectId: firstProject.id,
			score: 45 + projectAffinity(firstProject, 0, now),
		});
	}

	if (projects.length === 0) {
		add({
			key: "create-project",
			kind: "create",
			title: "Create your first project",
			description:
				"Give your requirements, evidence, features, and coding runs a home.",
			actionLabel: "Create project",
			href: `${basePath}/projects/new`,
			score: 50,
		});
	}

	add(
		isOrganizationAdmin
			? {
					key: "create-workflow",
					kind: "automate",
					title: "Put delivery on a schedule",
					description:
						"Create a recurring workflow for the updates your team needs.",
					actionLabel: "Create workflow",
					href: `${basePath}/workflows/new`,
					score: 30,
				}
			: {
					key: "ask-next-action",
					kind: "ask",
					title: "Find your next best action",
					description:
						"Ask Fabric to review your current work and suggest where to start.",
					actionLabel: "Ask Fabric",
					href: buildFabricAgentHref({
						basePath,
						prompt: "Help me decide what to work on next in my projects.",
					}),
					score: 30,
				},
	);

	const feedbackByKey = new Map(
		feedback.map((preference) => [preference.cardKey, preference]),
	);
	return candidates
		.filter((card) => !feedbackByKey.get(card.key)?.dismissedAt)
		.map((card) => {
			const preference = feedbackByKey.get(card.key);
			const clicks = Math.max(
				0,
				Math.min(5, Math.floor(preference?.clickCount ?? 0)),
			);
			return {
				...card,
				pinned: Boolean(preference?.pinnedAt),
				score:
					card.score +
					clicks * 4 +
					recencyBoost(preference?.lastClickedAt, now) / 2 +
					(preference?.pinnedAt ? 1_000 : 0),
			};
		})
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.filter(
			(card, index, cards) =>
				cards.findIndex((candidate) => candidate.href === card.href) ===
				index,
		)
		.slice(0, 3)
		.map(({ order: _order, ...card }) => card);
}
