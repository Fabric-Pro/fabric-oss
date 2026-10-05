/**
 * Environment variables read as switches.
 */

/** Set to something other than a way of saying no. */
export function isFlagSet(value: string | undefined): boolean {
	const normalised = value?.trim().toLowerCase();
	return (
		normalised !== undefined &&
		normalised !== "" &&
		normalised !== "0" &&
		normalised !== "false"
	);
}

/** `CI` is set to something other than a way of saying no. */
export function runningInCi(env: NodeJS.ProcessEnv = process.env): boolean {
	return isFlagSet(env.CI);
}
