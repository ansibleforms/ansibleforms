'use strict';
import Ssh from '../../models/ssh.model.js';
import RestResult from '../../models/restResult.model.v2.js';
import i18n from '../../lib/i18n.js';
import RepoObjects from '../../lib/repoObjects/index.js';

const find = async function(req, res) {
    try {
      const sshkey = await Ssh.find();
      res.json(RestResult.single(sshkey));
    } catch(err) {
      res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedFindSsh'), err.toString()));
    }
};

const update = async function(req, res) {
    if(req.body.constructor === Object && Object.keys(req.body).length === 0){
        res.status(400).json(RestResult.error(i18n.t(req, 'errors.requiredFields')));
    }else{
        try {
          // the SSH repository's ssh: map, before : a new key is never written to it (a secret),
          // but held as every save of the page is
          await RepoObjects.holding('ssh', async () => {
            const before = await RepoObjects.snapshot('ssh');
            await Ssh.update(new Ssh(req.body));
            await RepoObjects.appUpdated('ssh', before);
          });
          res.json(RestResult.single(null));
        } catch(err) {
          res.status(500).json(RestResult.error(i18n.t(req, 'resources.failedUpdateSsh'), err.toString()));
        }
    }
};

export default {
    find,
    update
};