'use strict';
import logger from "../lib/logger.js";
import Credential from "./credential.model.v2.js";
import Database from "./database.model.js";
import mysql from "../lib/mysql.js";
import mssql from "../lib/mssql.js";
import postgres from "../lib/postgres.js";
import mongodb from "../lib/mongodb.js";
import oracle from "../lib/oracle.js";
import { runJq } from "../lib/jq.js";
import { substitute } from "../lib/queryPolicy.js";

// the engine of each database type : each runs a query on the credential a name resolves to
const ENGINES = { mysql, mssql, postgres, oracle, mongodb }
// a type's engine, or none for a type without one (never a property every object has, toString)
const engineOf = (type) => (Object.hasOwn(ENGINES, type) ? ENGINES[type] : null)

//reporter object create
var Query=function(){

};
/**
 * @param {object} [values] When given, `query` is a TEMPLATE and its `$(x)` placeholders
 *   are substituted here rather than by the caller. This is the only layer that knows
 *   each datasource's engine, and the correct escaping differs between them - a backslash
 *   is an escape character in mysql and a literal in postgres/mssql/oracle, and mongodb
 *   wants json escaping rather than sql. Escaping every value with the mysql rules
 *   corrupted `DOMAIN\user` and `C:\path` on the other four. A config naming several
 *   datasources is substituted once per datasource, for the same reason.
 *   Omit it (the default) and the query is run exactly as passed.
 */
Query.findAll = async function (query,jqExpression="",cfg,noLog,values=null) {

  // legacy config was an object
  // in 5.0.2 we allow string and array
  // dbtype is stored in the credential, so we don't need it in the config
  // hence we can allow a simple string as config
  // additinally we allow an array of strings and merge the results
  var config = []
  var result = []
  if(typeof cfg == "string"){
    config.push({})
    config[0].name = cfg
  }else if(Array.isArray(cfg)){
    // clone cfg
    cfg.forEach((c)=>{
      config.push({name:c})
    })
  }else if(cfg && typeof cfg == "object"){
    config.push(cfg)
  }else{
    // There was no else, so a dbConfig that is a number or a boolean (`dbConfig: 1` in a
    // form's yaml parses to one) left `config` empty, the loop below never ran, and the
    // endpoint answered 200 with []. An empty dropdown and no indication anything was
    // wrong - the same class of lie as the `type` switch further down, which does raise.
    throw new Error(`Invalid dbConfig: expected a datasource name, a list of names or a config object, got ${cfg === null ? 'null' : typeof cfg}`)
  }


  for await (var c of config){

    var res
    // step 1 : what the name connects with - a database of Connections > Databases of that name
    // (its credential, by its exact name), else a credential of that name, as before databases
    const source = await Database.credentialFor(c.name)
    if(!c.type){ // if no type is given, we try to find the credential
      logger.debug(`[${c.name}] No type is passed, looking up credential`)
      var cred = await Credential.resolveCredential(source)
      c.type = cred.db_type || "mysql"
    }
    // substituted per datasource, now that the engine is known - see the `values` note
    // on this function. Done before the logging so the log shows what actually ran.
    const finalQuery = values ? substitute(query,values,c.type) : query
    if(noLog){
      logger.info(`[${c.type}][${c.name}] Running query: noLog is applied`)
    }else{
      logger.info(`[${c.type}][${c.name}] Running query ${finalQuery}`)
    }
    // step 2 : the engine of its type runs it
    const engine = engineOf(c.type)
    if(!engine){
      throw new Error("Unsupported database type")
    }
    res = await engine.query(source,finalQuery)
    if(!noLog){
      logger.debug(`[${c.name}] query result: ${JSON.stringify(res)}`)
    }
    result = result.concat(res)
  }
  
  // Apply jq expression if provided
  if(jqExpression && jqExpression.trim() !== ""){
    logger.debug(`Applying jq expression: ${jqExpression}`)
    // the same runner as the expression functions : the jq definitions (fn2KB,
    // fnRound, the admin's custom ones) are available here too, and jq is bounded in
    // time (JQ_TIMEOUT_SECONDS) and output size
    result = await runJq(jqExpression, result)
    if(!noLog){
      logger.debug(`jq result: ${JSON.stringify(result)}`)
    }
  }
  
  return result
};

// the query each engine answers when a connection is tested : the least it can run, a MongoDB
// one in its database~collection~filter form
const TEST_QUERIES = {
  mysql: "select 1",
  mssql: "select 1",
  postgres: "select 1",
  oracle: "select 1 from dual",
  mongodb: "admin~system.version~{}",
}

/**
 * Tests a database connection : the least query its engine can run, on the credential it connects
 * with (a database of Connections > Databases tests its credential, a credential of type database
 * itself).
 *
 * Args:
 *   credential (string): the credential's name as Credential.resolveCredential reads it (its
 *     exact pattern, Credential.exactPattern).
 *   dbType (string): the engine (mysql, mssql, postgres, oracle, mongodb).
 *
 * Returns:
 *   Promise<boolean>: true once it answered.
 *
 * Raises:
 *   Error: a type without an engine (code 'NO_DB_TYPE'), or the connection's or the query's error.
 */
Query.testConnection = async function (credential, dbType) {
  const engine = engineOf(dbType)
  if(!engine){
    const err = new Error(`Database type not set: '${dbType || ""}'`)
    err.code = "NO_DB_TYPE"
    throw err
  }
  await engine.query(credential, TEST_QUERIES[dbType])
  return true
}

export default  Query;
