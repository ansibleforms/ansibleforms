//- MYSQL Module
import logger from './logger.js';
import client from 'mysql2/promise.js';
import Credential from '../models/credential.model.v2.js';

const MySql = {}

// the options mysql2 takes from a credential : anything else (a credential's tenant_id, issuer,
// redirect_uri, its secret store...) warns on every connection, and a later mysql2 refuses it
const CONNECTION_OPTIONS = ["host", "port", "user", "password", "database", "ssl", "multipleStatements"]

/**
 * A credential as mysql2 connects with it : its connection options only.
 *
 * Args:
 *   config (object): the credential resolved, with database, ssl and multipleStatements set.
 *
 * Returns:
 *   object: a new object with the options mysql2 knows, those set (null and undefined left out).
 */
MySql.clean=function(config){
  const clean = {}
  for (const key of CONNECTION_OPTIONS) {
    if (config?.[key] !== undefined && config[key] !== null) clean[key] = config[key]
  }
  return clean
}

// rewrite with await 5.0.3

MySql.query = async function (connection_name, query) {
  // get credentials
  var config = await Credential.resolveCredential(connection_name)
  logger.debug(`[${connection_name}] query: ${query}`)
  var conn
  try{

    // fixed in 5.0.4
    config.multipleStatements=true
    // remove database if not defined
    if(config.db_name){
      config.database = config.db_name
    }
    if(config.secure){
      config.ssl={
        sslmode:"required",
        rejectUnauthorized:false
      }
    }else{
      config.ssl={
        sslmode:"none",
        rejectUnauthorized:false
      }
    }
    // get connection
    // its connection options only : mysql2 warns on any other
    conn = await client.createConnection(MySql.clean(config))
    var result
    try{
      [result] = await conn.query(query)
      return result
    }catch(err){
      logger.error(`[${connection_name}] query error: ${err.toString()}`)
      throw err
    }
  }catch(err){
    logger.error(`[${connection_name}] connection error: ${err.toString()}`)
    throw err
  }finally{
    try{
      await conn.end()
    }catch(e){
      logger.error(`[${connection_name}] ${e}`)
      // throw e
    }
  }
}
export default MySql
