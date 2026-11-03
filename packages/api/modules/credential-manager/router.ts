/**
 * Credential manager (ADR-026), phase 1:
 * saved tokens and keys an organization's members reuse.
 */

import { createCredentialProcedure } from "./procedures/create";
import { deleteCredentialProcedure } from "./procedures/delete";
import { listCredentials } from "./procedures/list";
import { updateCredentialProcedure } from "./procedures/update";

export const credentialManagerRouter = {
	list: listCredentials,
	create: createCredentialProcedure,
	update: updateCredentialProcedure,
	delete: deleteCredentialProcedure,
};
