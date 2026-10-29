import passport from 'passport';
import authConfig from '../../config/auth.config.js';
import logger from '../lib/logger.js';
import { Strategy as JWTstrategy, ExtractJwt as ExtractJWT } from 'passport-jwt';
import { isRevoked } from '../lib/tokenRevocation.js';
import { withGroups, rolesOf } from '../lib/userGroups.js';
import ApiToken from '../models/apiToken.model.js';

passport.use(
  new JWTstrategy(
    {
      secretOrKey: authConfig.secret,
      jwtFromRequest: ExtractJWT.fromAuthHeaderAsBearerToken()
    },
    async (jwtPayload, done) => {
      try {
        if(jwtPayload.access){
          // its session logged out, or its user changed the password since it was issued
          if (await isRevoked(jwtPayload)) return done(null, false, { message: 'Token revoked' });
          // an api token's last use, for its list (at most once a minute, not awaited)
          if (jwtPayload.api) ApiToken.touch(jwtPayload.sid);
          // the token carries no groups (they made it too large for the request header, #1036) :
          // they are put back here from where the sign-in stored them, so every reader of
          // req.user.user.groups sees them as before (lib/userGroups.js). A token issued
          // before keeps the groups it carries.
          let user = jwtPayload.user;
          // an api token lives for days, or for ever, and has no refresh : the roles and options
          // it was signed with would stay until it is revoked by hand (a user taken out of the
          // admin role kept admin through it). They are resolved again from the user's groups
          // as they are now, cached with them (lib/userGroups.js). A session's access token is
          // short-lived and its refresh resolves them : it keeps the ones it carries.
          if (jwtPayload.api) user = { ...user, ...(await rolesOf(user)) };
          return done(null, { ...jwtPayload, user: await withGroups(user) });
        }else {
          done(null, false,{message:'Bad accesstoken'})
        }
      } catch (error) {
        logger.info("error ?")
        done(error,false,{message:'Unknown JWT error'});
      }
    }
  )
);
