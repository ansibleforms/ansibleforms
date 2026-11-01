/******************************************************************/
/*                                                                */
/*  The Used by rows of the forms and of the designer's workflows */
/*  that name a record : a credential's page (credential.vue) and */
/*  a database's (database.vue). The server scans them            */
/*  (lib/formLinks.js formCredentials, models/workflowRun.js      */
/*  workflowCredentials) : each form with the names it gives and  */
/*  where ; a row per form and name.                              */
/*                                                                */
/******************************************************************/
import { slugOf } from '@/lib/formsPath';

/**
 * Whether a credential's name fits a name a form builds when it runs : each placeholder
 * ($(field), {{ var }}, ${var}) stands for any text.
 *
 * Args:
 *   pattern (string): the name as the form writes it, such as `$(env)-db`.
 *   name (string): the credential's name.
 *
 * Returns:
 *   boolean: true when the form may build that name.
 */
export function fitsPattern(pattern, name) {
  const parts = String(pattern).split(/\$\([^)]*\)|\{\{[^}]*\}\}|\$\{[^}]*\}/);
  const regex = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+');
  return new RegExp(`^${regex}$`).test(String(name));
}

/**
 * The Used by rows of the forms, or of the designer's workflows : one per form (or workflow) and
 * credential it names, saying where (the server's scans : lib/formLinks.js formCredentials,
 * models/workflowRun.js workflowCredentials).
 *
 * Args:
 *   forms (object[]): { name, description, credentials: [{ name, where }] } each.
 *   kind (string): 'form' (a row opens the form in the designer) or 'workflow' (the designer's
 *     Workflows, whose file the row names : the designer opens no file by its address).
 *
 * Returns:
 *   object[]: the rows, each { name, description, credential, how, kind, to }.
 */
export function formRows(forms, kind = 'form') {
  const rows = [];
  for (const f of forms) {
    const byCredential = new Map();
    for (const c of f.credentials || []) byCredential.set(c.name, [...(byCredential.get(c.name) || []), c.where]);
    for (const [credentialName, places] of byCredential) {
      rows.push({
        name: f.name,
        description: f.description,
        credential: credentialName,
        how: places.join(', '),
        kind,
        to: kind === 'form' ? `/designer/forms/${slugOf(f.name)}` : `/designer/workflows#${slugOf(f.name)}`,
      });
    }
  }
  return rows;
}

// where a form names a database : a field's dbConfig (lib/formLinks.js credentialsOfForm says
// "field <name> (dbConfig)")
const DB_CONFIG = /\(dbConfig\)$/;
// the field a dbConfig is in : "field <name> (dbConfig)"
const FIELD_OF = /^field (.+) \(dbConfig\)$/;

/**
 * The Used by rows of a database of Connections > Databases : the forms whose fields name it in
 * their dbConfig, by its name, or by its credential's (a form of before databases, which names the
 * credential and connects the same way). As the server counts them (models/database.model.js
 * formCounts).
 *
 * Args:
 *   forms (object[]): the forms, as /api/v2/config/formscredentials lists them.
 *   database (object): the database ({ name, credential }).
 *
 * Returns:
 *   object[]: the rows (formRows), one per form (its name and description) with the fields that
 *     query it (fields), keyed by the form (key : a form naming the database and its credential is
 *     one row).
 */
export function databaseFormRows(forms, database) {
  if (!database) return [];
  const names = [database.name, database.credential].filter(Boolean);
  const naming = (forms || []).map((f) => ({
    ...f,
    credentials: (f.credentials || []).filter((c) => DB_CONFIG.test(c.where) && names.includes(c.name)),
  }));
  // step 1 : a row per form and name, as the credentials' Used by ; step 2 : one per form, with
  // the fields that query it ("field srv (dbConfig)" : srv)
  const rows = new Map();
  for (const f of naming.filter((x) => x.credentials.length)) {
    const fields = [...new Set(f.credentials.map((c) => FIELD_OF.exec(c.where)?.[1]).filter(Boolean))];
    for (const r of formRows([f])) if (!rows.has(r.to)) rows.set(r.to, { ...r, key: r.to, fields: fields.join(', ') });
  }
  return [...rows.values()];
}
