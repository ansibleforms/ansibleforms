// Connections > Databases : the databases forms query. A field's dbConfig names one ; it is a name
// of its own, what it is, and the credential of type database it connects with, as a runner names
// the credential it signs in with. Its engine, server, port, database, TLS and login are the
// credential's (models/credential.model.v2.js) : a database holds no secret and no address.
import CrudModel from './crud.model.js';
import Errors from '../lib/errors.js';
import mysql from './db.model.js';
import Credential from './credential.model.v2.js';

// what a database shows of its credential (the list's columns, its page) : where it connects,
// never its login
const CONNECTION_SQL =
  "SELECT name, credential_type, is_database, db_type, db_name, host, port, secure FROM AnsibleForms.`credentials` WHERE name IN (?)";

class Database extends CrudModel {
  static modelName = 'database';

  /**
   * Whether a credential is one a database connects with : of type database, or one from before
   * the types with its database flag set (as Credential.mirrorType reads it).
   *
   * Args:
   *   credential (object|null): the credential's row ({ credential_type, is_database }).
   *
   * Returns:
   *   boolean: true for a database credential.
   */
  static isDatabaseCredential(credential) {
    if (!credential) return false;
    const type = String(credential.credential_type || '').trim();
    if (type) return type === 'database';
    return !!Number(credential.is_database);
  }

  /**
   * Checks the credential a write names : it exists and it is of type database. An empty one is
   * refused (a database connects with nothing else) ; one not sent is left as it is.
   *
   * Args:
   *   data (object): the fields written.
   *   creating (boolean): a create (its credential is required).
   *
   * Returns:
   *   Promise<object>: the record.
   *
   * Raises:
   *   BadRequestError: no credential, no credential of that name, or one of another type.
   */
  static async assertCredentialUsable(data, creating = false) {
    if (data.credential === undefined && !creating) return data;
    const name = String(data.credential ?? '').trim();
    if (!name) throw new Errors.BadRequestError('A database needs its credential: a credential of type database');
    const credential = await Credential.findRowByName(name);
    if (!credential) throw new Errors.BadRequestError(`No credential named '${name}'`);
    if (!this.isDatabaseCredential(credential)) {
      throw new Errors.BadRequestError(
        `A database connects with a credential of type database: '${name}' is ${credential.credential_type || 'not one'}`,
      );
    }
    data.credential = name;
    return data;
  }

  /**
   * The databases with what they show of their credential : its database type, database, host,
   * port and TLS (read only : written on the credential), read in one query for all of them.
   *
   * Args:
   *   rows (object[]): the databases as stored.
   *
   * Returns:
   *   Promise<object[]>: copies, each with db_type, db_name, host, port and secure ; empty ones
   *     for a credential that is gone.
   */
  static async withConnection(rows) {
    const list = (rows || []).filter(Boolean);
    const names = [...new Set(list.map((r) => r.credential).filter(Boolean))];
    const found = names.length ? await mysql.do(CONNECTION_SQL, [names]) : [];
    const byName = new Map((found || []).map((c) => [c.name, c]));
    return list.map((r) => {
      const c = byName.get(r.credential) || {};
      return {
        ...r,
        db_type: c.db_type || '',
        db_name: c.db_name || '',
        host: c.host || '',
        port: c.port ?? null,
        secure: c.secure ? 1 : 0,
      };
    });
  }

  // opts carries { fromSeed:true } for the declarative config seed only : its credentials are
  // applied before its databases, so the credential is checked for the seed too
  static async create(data, opts = {}) {
    await this.assertCredentialUsable(data, true);
    return super.create(this.modelName, data, opts);
  }

  static async update(data, id, opts = {}) {
    await this.assertCredentialUsable(data);
    return super.update(this.modelName, data, id, opts);
  }

  static async delete(id, opts = {}) {
    return super.delete(this.modelName, id, opts);
  }

  // read as they connect : each with its credential's database type, server and database
  static async findAll() {
    return this.withConnection(await super.findAll(this.modelName));
  }

  static async findById(id) {
    const row = await super.findById(this.modelName, id);
    return row ? (await this.withConnection([row]))[0] : row;
  }

  static async findByName(name) {
    const row = await super.findByName(this.modelName, name);
    return row ? (await this.withConnection([row]))[0] : row;
  }

  /**
   * What a field's dbConfig name connects with : the credential of the database of that name, as
   * an exact pattern (a name with a dot or a bracket finds itself only), or else the name itself,
   * a credential named in dbConfig as before databases (Credential.resolveCredential reads it as
   * a pattern, as it always did).
   *
   * Args:
   *   name (string): the name dbConfig gives.
   *
   * Returns:
   *   Promise<string>: the credential pattern to resolve.
   */
  static async credentialFor(name) {
    const database = name ? await super.findByName(this.modelName, String(name)) : null;
    return database?.credential ? Credential.exactPattern(database.credential) : name;
  }

  /**
   * How many forms name each database in a field's dbConfig, by its name or by its credential's
   * (a form of before databases, which names the credential) : the list's Used by column, as the
   * page's Used by tab lists them.
   *
   * Args:
   *   databases (object[]): the databases ({ name, credential }).
   *   forms (object[]): the forms as lib/formLinks.js formCredentials lists them.
   *
   * Returns:
   *   Map<string, number>: the count of each database name, by form.
   */
  static formCounts(databases, forms) {
    const counts = new Map();
    for (const form of forms || []) {
      const named = new Set((form.credentials || []).filter((c) => /\(dbConfig\)$/.test(c.where)).map((c) => c.name));
      for (const db of databases || []) {
        if (named.has(db.name) || named.has(db.credential)) counts.set(db.name, (counts.get(db.name) || 0) + 1);
      }
    }
    return counts;
  }
}

export default Database;
