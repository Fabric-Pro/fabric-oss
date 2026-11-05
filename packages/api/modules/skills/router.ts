import { skillCatalogProcedures } from "./procedures/catalog";
import { executeSkillProcedure } from "./procedures/execute";
export const skillsRouter = {
	list: skillCatalogProcedures.list,
	get: skillCatalogProcedures.get,
	create: skillCatalogProcedures.create,
	update: skillCatalogProcedures.update,
	archive: skillCatalogProcedures.archive,
	restore: skillCatalogProcedures.restore,
	publish: skillCatalogProcedures.publish,
	delete: skillCatalogProcedures.delete,
	execute: executeSkillProcedure,
	assist: skillCatalogProcedures.assist,
	import: {
		preview: skillCatalogProcedures.importPreview,
		create: skillCatalogProcedures.importCreate,
		readFile: skillCatalogProcedures.importReadFile,
	},
	governance: {
		get: skillCatalogProcedures.governanceGet,
		update: skillCatalogProcedures.governanceUpdate,
	},
	files: { read: skillCatalogProcedures.readFile },
};
