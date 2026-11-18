import { db, type Prisma } from "../../client";

/** Hides Initiatives in projects that have Initiatives switched off. */
const VISIBLE_STORY_WHERE: Prisma.UserStoryWhereInput = {
	NOT: { kind: "INITIATIVE", project: { initiativesEnabled: false } },
};

/** Adds the visibility rule to a story `where` with AND, preserving any OR/NOT keys. */
export function withVisibleStories(
	where: Prisma.UserStoryWhereInput,
): Prisma.UserStoryWhereInput {
	return { AND: [where, VISIBLE_STORY_WHERE] };
}

/** Every Initiative in the project, hidden ones included; drives the switch-off warning. */
export function countProjectInitiatives(projectId: string) {
	return db.userStory.count({ where: { projectId, kind: "INITIATIVE" } });
}

/** Thrown by createStory: the project has Initiatives switched off. */
export class InitiativesDisabledError extends Error {
	constructor() {
		super("Initiatives are turned off for this project.");
		this.name = "InitiativesDisabledError";
	}
}
