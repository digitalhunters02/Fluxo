// Tabelas do "Importar de foto" no banco de CADA clínica (um arquivo por clínica): photo_imports + usage_credit.
import { PHOTO_IMPORT_DDL } from './photoImportRouter.js';
import { toSqlite } from './sqlitePool.js';

export function ensurePhotoSchema(d) {
  for (const ddl of PHOTO_IMPORT_DDL) d.exec(toSqlite(ddl));
}
