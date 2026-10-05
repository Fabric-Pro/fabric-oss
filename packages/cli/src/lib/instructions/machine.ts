/**
 * What `init` reads about the machine it runs on, behind one object so a test
 * can say what machine it is without touching the real home folder or PATH.
 */
import os from "node:os";

export const machine = {
	home: (): string | null => {
		try {
			return os.homedir() || null;
		} catch {
			return null;
		}
	},
	env: (): NodeJS.ProcessEnv => process.env,
	platform: (): NodeJS.Platform => process.platform,
};
