import { ORPCError } from "@orpc/client";
import {
	buildIgnoreMatcher,
	isSecretFileName,
	validateRelativePath,
} from "@repo/instructions";
import { z } from "zod";
import {
	type DirectRepositoryPin,
	type DirectRepositorySource,
	resolveDirectRepositoryIgnore,
} from "./direct-source";

export const instructionRepositoryFilePathSchema = z
	.string()
	.min(1)
	.max(512)
	.refine((path) => {
		const checked = validateRelativePath(path);
		return checked.ok && checked.path === path;
	}, "Expected a canonical relative file path");

export async function assertInstructionRepositoryFileVisible(input: {
	source: DirectRepositorySource;
	pin: DirectRepositoryPin;
	path: string;
}): Promise<void> {
	const checked = instructionRepositoryFilePathSchema.safeParse(input.path);
	if (!checked.success || isSecretFileName(input.path)) {
		throw new ORPCError("NOT_FOUND", { message: "File not found" });
	}
	const ignore = await resolveDirectRepositoryIgnore(input.source, input.pin);
	if (buildIgnoreMatcher(ignore)(input.path)) {
		throw new ORPCError("NOT_FOUND", { message: "File not found" });
	}
}
