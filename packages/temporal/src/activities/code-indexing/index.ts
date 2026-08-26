/**
 * Code Indexing Activities - Directory Index
 *
 * Re-exports from the main code-indexing.ts module and new modular activities.
 */

export {
	deleteProjectCodeSymbolsActivity,
	type ExtractAndPersistSymbolsInput,
	type ExtractSymbolsActivityInput,
	type ExtractSymbolsActivityOutput,
	extractAndPersistSymbolsActivity,
	extractSymbolsActivity,
	type PersistCodeSymbolsInput,
	type PersistCodeSymbolsOutput,
	persistCodeSymbolsActivity,
} from "./extract-symbols";
