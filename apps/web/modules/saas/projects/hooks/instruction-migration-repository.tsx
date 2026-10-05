"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * The repository the project's uploaded instructions are being moved into
 * (Fizzy #2878 §9), `owner/name`, or null when no move is open. Provided by the
 * tab, which reads it from the sync the move created; read by the action-error
 * hooks, because the refusal a frozen action gets names the pull request but
 * not the repository.
 */
const InstructionMigrationRepositoryContext = createContext<string | null>(
	null,
);

export function InstructionMigrationRepositoryProvider({
	repository,
	children,
}: {
	repository: string | null;
	children: ReactNode;
}) {
	return (
		<InstructionMigrationRepositoryContext.Provider value={repository}>
			{children}
		</InstructionMigrationRepositoryContext.Provider>
	);
}

export function useInstructionMigrationRepository(): string | null {
	return useContext(InstructionMigrationRepositoryContext);
}
