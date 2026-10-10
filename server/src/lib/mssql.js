//- MYSQL Module
import logger from './logger.js';
import client from 'mssql';
import Credential from '../models/credential.model.v2.js';

const Mssql = {}

// rewrite with await 5.0.3

Mssql.query = async function (connection_name, query) {

  var creds = await Credential.resolveCredential(connection_name)
  var config = {
    server: creds.host,
    user: creds.user,
    password: creds.password,
    database: creds.db_name,
    port: creds.port,
    options: {
      trustServerCertificate: true
    }
  };
  if(creds.secure){
    
    config.encrypt=true
  }
  // remove database if needed
  if(!creds.db_name){
    delete config.database
  }

  // a pool of its own : client.connect() hands back the library's GLOBAL pool once one is open,
  // whatever the config - so two queries with different credentials at once shared one pool, and
  // one could run on the other credential's server, while the first close() cut the other off
  var conn
  try{
    conn = await new client.ConnectionPool(config).connect()
  }catch(err){
    logger.error(`[${connection_name}] connection error`,err)
    throw err
  }

  var result
  try{
    result = await conn.query(query)
    return result?.recordset
  }catch(err){
    logger.error(`[${connection_name}] query error`,err)
    throw err
  }finally{
    try{
      await conn.close()
    }catch(e){
      logger.error(`[${connection_name}] connection error`,e)
      //throw e
    }
  }

}

export default Mssql
