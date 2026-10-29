export default {
  errors: {
    databaseError:
      "Une erreur de base de données s'est produite : le journal du serveur en donne le détail",
    duplicateRecord: "Un enregistrement portant ce nom existe déjà",
    valueTooLong: "Une valeur est trop longue pour son champ",
    noAccess: "Acces refuse",
    notAdmin: "Vous n'etes pas administrateur",
    noSettingsAccess: "Vous n'avez pas acces aux parametres",
    noDesignerAccess: "Vous n'avez pas acces au concepteur",
    noFormDesignAccess: "Vous ne pouvez pas modifier les formulaires dans le designer",
    noPlaybookDesignAccess: "Vous ne pouvez pas modifier les playbooks dans le designer",
    noWorkflowDesignAccess: "Vous ne pouvez pas modifier les workflows dans le designer",
    noInventoryDesignAccess: "Vous ne pouvez pas modifier les inventaires dans le designer",
    noVarsFileDesignAccess: "Vous ne pouvez pas modifier les fichiers de variables dans le designer",
    noLogsAccess: "Vous n'avez pas acces aux journaux",
    noFileUploadAccess: "Votre rôle ne permet pas d'envoyer des fichiers",
    noAuditAccess: "Vous n'avez pas accès au journal d'audit",
    noDatabaseAccess: "Vous n'avez pas acces aux operations de base de donnees",
    noScheduleAccess:
      "Vous n'avez pas la permission de gerer les taches planifiees",
    noChatAccess:
      "Vous n'avez pas l'autorisation d'utiliser l'assistant de chat",
    noMcpAccess: "Vous n'avez pas l'autorisation d'utiliser le serveur MCP",
    noStoredJobsAccess:
      "Vous n'avez pas la permission de gerer les taches enregistrees",
    noDataSent: "Aucune donnee n'a ete envoyee",
    missingDbConfig: "Configuration de base de donnees manquante",
    provideRefreshToken: "Veuillez fournir un jeton de rafraichissement",
    invalidRefreshToken: "Jeton de rafraichissement invalide",
    refreshTokenExpired: "Le jeton de rafraichissement a expire",
    refreshTokenUnknown: "Jeton de rafraichissement inconnu",
    refreshTokenReplaced: "Jeton de rafraichissement déjà utilisé par un rafraichissement simultané",
    apiTokenFromApiToken: "Un jeton d'API ne peut pas créer un autre jeton d'API",
    apiTokenNotAllowed: "Votre rôle n'autorise pas les jetons d'API",
    apiTokenSignInAgain: "Reconnectez-vous pour créer un jeton d'API : votre dernière connexion est trop ancienne",
    apiTokenLifetime: "La durée doit être un nombre de jours, au plus {max}",
    apiTokenFailed: "Impossible de créer le jeton d'API",
    apiTokensFailed: "Impossible de lire ou de modifier les jetons d'API",
    apiTokenNotFound: "Ce jeton d'API n'existe pas",
    requiredFields: "Veuillez fournir tous les champs obligatoires",
    noVerbosePermission:
      "Vous n'avez pas la permission d'utiliser le mode verbeux",
  },
  auth: {
    authFailed: "Echec de l'authentification",
    invalidCredentials: "Identifiants invalides",
    tooManyFailures:
      "Trop de connexions échouées : réessayez dans {minutes} minute(s)",
    passwordChangeRequired:
      "Changez d'abord votre mot de passe : c'est le mot de passe par défaut, public",
    disclaimerRequired: "Acceptez d'abord l'avertissement",
    disclaimerAccepted: "L'avertissement est accepté",
    loginDisabled:
      "Non authentifie, la connexion n'est pas activee pour cet utilisateur.",
    signInBlocked:
      "Non authentifié, un administrateur a bloqué la connexion de cet utilisateur.",
    entraFailed: "Echec de l'authentification Azure AD",
    oidcFailed: "Echec de l'authentification OIDC",
  },
  success: {
    created: "{resource} cree",
    updated: "{resource} mis a jour",
    deleted: "{resource} supprime",
    connectionOk: "Connexion {resource} OK",
  },
  audit: {
    failedGet: "Échec de la récupération du journal d'audit",
  },
  health: {
    failedCheck: "Échec de la vérification de l'état du système",
  },
  config: {
    failedGetFormsList: "Echec de la recuperation de la liste des formulaires",
    formNameNotProvided: "Nom du formulaire non fourni",
    failedGetFormConfig:
      "Echec de la recuperation de la configuration du formulaire",
    onlyAdminsOrDesigners:
      "Seuls les administrateurs ou concepteurs peuvent acceder a la configuration complete",
    failedGetFormsConfig:
      "Echec de la recuperation de la configuration des formulaires",
    failedGetBackups: "Echec de la recuperation des sauvegardes",
    failedGetEnvVars: "Echec de la recuperation des variables d'environnement",
    failedSaveEnvVars:
      "Échec de l'enregistrement des paramètres d'environnement",
    failedVaultCheck: "Échec du test de connexion Vault",
    failedVaultMounts: "Impossible de lister les points de montage Vault",
    noEnvVarsGiven: "Aucune variable d'environnement fournie",
    envVarsSaved: "Paramètres d'environnement enregistrés",
    envVarsNotFound:
      "Section des variables d'environnement introuvable dans help.yaml",
    failedRestoreForms: "Echec de la restauration des formulaires",
    failedRestoreNoName:
      "Echec de la restauration, aucun nom de sauvegarde fourni",
    failedRestoreBackup: "Echec de la restauration de '{name}'",
    designerLocked: "Le concepteur est verrouille",
    designerLockedBy: "Le concepteur est verrouille par {username}",
    failedSaveForms: "Echec de l'enregistrement des formulaires",
    failedValidateForms: "Echec de la validation de la nouvelle configuration",
    failedGetLock: "Echec de la recuperation du verrou",
  },
  resources: {
    storedJobNameInUse:
      "Vous avez déjà une tâche enregistrée nommée '{name}' : choisissez un autre nom",
    cantTouchDirectoryAdmin:
      "Seul un admin peut bloquer, déconnecter, oublier ou révoquer les jetons d'un utilisateur qui a le rôle admin",
    credentialNotFound:
      "Aucun identifiant nommé '{name}'",
    repositoryCredentialType:
      "Un dépôt se connecte avec un utilisateur et un mot de passe : l'identifiant '{name}' n'a pas les deux",
    credentialSignInAdminOnly:
      "Seul un admin peut ajouter, modifier ou supprimer un identifiant utilisé par une authentification (LDAP, Microsoft Entra ID ou OIDC)",
    credentialNotAllowed:
      "Seul un admin peut utiliser ici l'identifiant '{name}' : un runner, une connexion ou une authentification l'utilise",
    storedKeyOtherProvider:
      "La clé enregistrée n'est envoyée qu'au fournisseur et à l'URL de base enregistrés : saisissez la clé pour en vérifier un autre",
    backupCreated: "Sauvegarde creee",
    lockAdded: "Verrou ajoute",
    lockDeleted: "Verrou supprime",
    scheduleAdded: "Planification ajoutee",
    scheduleQueued: "Planification mise en file",
    scheduleLaunched: "Planification lancee",
    storedJobAdded: "Tache enregistree ajoutee",
    storedJobUpdated: "Tache enregistree mise a jour",
    storedJobDeleted: "Tache enregistree supprimee",
    storedJobNoAccess: "Vous n'avez pas acces a cette tache enregistree",
    storedJobVisibilityInvalid: "Une tache enregistree est privee ou partagee",
    storedJobShareDenied: "Vous n'avez pas la permission de partager des taches enregistrees",
    storedJobShareFormDisabled: "Le formulaire '{form}' ne permet pas de partager ses taches enregistrees",
    oauth2Added: "Fournisseur OAuth2 ajoute",
    secretStoreAdded: "Coffre de secrets ajoute",
    secretStoreNotFound: "Coffre de secrets introuvable",
    secretStoreConnectionOk: "La connexion au coffre de secrets est OK",
    runnerAdded: "Runner ajouté",
    joinTokenMade: "Jeton d'adhésion créé : copiez-le maintenant, il ne sera plus affiché",
    joinTokenRevoked: "Jeton d'adhésion révoqué",
    joinTokenDeleted: "Jeton d'adhésion supprimé",
    joinTokenNotFound: "Jeton d'adhésion introuvable",
    runnerNotFound: "Runner introuvable",
    runnerAdminOnly:
      "Seul un admin peut ajouter, modifier ou supprimer un runner : un runner recoit les identifiants des jobs qu'il execute",
    repositoryAdminOnly:
      "Seul un admin peut ajouter ou supprimer un depot, ou changer son adresse, sa branche ou son usage : son contenu devient la configuration, les formulaires ou les playbooks qu'AnsibleForms execute",
    secretStoreAdminOnly:
      "Seul un admin peut ajouter, modifier ou supprimer un coffre de secrets : il se connecte avec un jeton ou une cle qui serait envoye a son adresse",
    credentialSecretRefAdminOnly:
      "Seul un admin peut choisir ou changer le coffre de secrets et le secret dont un identifiant lit son mot de passe",
    credentialAdminOnly:
      "Seul un admin peut ajouter, modifier ou supprimer cet identifiant : un runner ou une connexion en prend son adresse et son secret",
    credentialInUse:
      "L'identifiant '{name}' est utilisé par {count} enregistrement(s), listés dans son onglet Utilisé par : modifiez-les d'abord",
    defaultPasswordRefused:
      "Choisissez un autre mot de passe que le mot de passe par défaut, public",
    passwordTooShort: "Le mot de passe doit compter au moins {min} caractères",
    passwordIsUsername: "Le mot de passe ne peut pas être le nom d'utilisateur",
    runnerConnectionOk: "La connexion au runner est OK",
    runnerConnectionOkDetails: "La connexion au runner est OK : {details}",
    runnerRteRelease: "RTE {version}",
    runnerAnsibleCore: "Ansible core {version}",
    runnerAnsible: "Ansible {version}",
    runnerOnNode: "sur le nœud {node}",
    runnerDetailsSeparator: ", ",
    userNotFound: "Utilisateur introuvable",
    currentPasswordRequired:
      "Votre mot de passe actuel est requis pour en définir un nouveau",
    currentPasswordWrong: "Le mot de passe actuel est incorrect",
    cantChangePasswordLdap:
      "Vous ne pouvez pas changer le mot de passe d'un utilisateur LDAP",
    directoryTypeUnknown:
      "Pas un utilisateur ou un groupe LDAP, Microsoft Entra ID ou OIDC",
    directoryUserKept:
      "Un administrateur a bloqué cet utilisateur : autorisez sa connexion avant de l'oublier",
    failedDirectoryUser:
      "L'utilisateur LDAP ou SSO n'a pas pu être lu ou modifié",
    cantBlockAdmin:
      "L'utilisateur admin ne peut pas être bloqué : c'est le moyen de revenir",
    cantBlockYourself: "Vous ne pouvez pas bloquer votre propre connexion",
    groupNotFound: "Aucun groupe trouve",
    groupHasUsers: "Groupe inconnu ou groupe contenant des utilisateurs",
    failedFindGroup: "Echec de la recherche du groupe",
    failedCreateGroup: "Echec de la creation du groupe",
    failedUpdateGroup: "Echec de la mise a jour du groupe",
    failedDeleteGroup: "Echec de la suppression du groupe",
    failedFindRepositories: "Echec de la recherche des depots",
    failedFindRepository: "Echec de la recherche du depot",
    failedCreateRepository: "Echec de la creation du depot",
    failedUpdateRepository: "Echec de la mise a jour du depot",
    failedDeleteRepository: "Echec de la suppression du depot",
    failedCloneRepository: "Echec du clonage du depot",
    failedResetRepository: "Echec de la reinitialisation du depot",
    failedPullRepository: "Echec du pull du depot",
    failedSyncRepository: "Le push du dépôt a échoué",
    noFormsRepositories: "Aucun dépôt de formulaires configuré",
    failedApplyConfigSeed: "Echec de l'application du seed de configuration",
    noConfigSeed:
      "Aucun seed de configuration n'est configure (CONFIG_SEED_PATH est vide)",
    failedFindSsh: "Echec de la recherche de la cle SSH",
    failedUpdateSsh: "Echec de la mise a jour de la cle SSH",
    failedFindChatSettings: "Impossible de trouver les paramètres du chat",
    failedUpdateChatSettings:
      "Impossible de mettre à jour les paramètres du chat",
    seedManagedChatSettings:
      "Les paramètres du chat sont gérés par le config seed et sont en lecture seule",
    chatSettingsUpdated: "Paramètres du chat mis à jour",
    chatCheckFailed: "La vérification du fournisseur de chat a échoué",
    failedFindLdap: "Echec de la recherche LDAP",
    ldapCheckFailed: "Verification LDAP echouee",
    storedPasswordOtherServer:
      "Le mot de passe enregistre ne sert qu'au serveur enregistre : saisissez le mot de passe pour en verifier un autre",
    ldapUpdated: "LDAP mis a jour",
    failedUpdateLdap: "Echec de la mise a jour LDAP",
    ldapCreated: "Annuaire LDAP ajouté",
    failedCreateLdap: "Impossible d'ajouter l'annuaire LDAP",
    ldapDeleted: "Annuaire LDAP supprimé",
    ldapNotFound: "Annuaire LDAP introuvable",
    failedDeleteLdap: "Impossible de supprimer l'annuaire LDAP",
    seedManagedSettings:
      "Les paramètres sont gérés par le seed de configuration et sont en lecture seule",
    seedManagedLdap:
      "La configuration LDAP est gérée par le seed de configuration et est en lecture seule",
    failedFindSettings: "Echec de la recherche des parametres",
    mailCheckFailed: "Echec de la verification mail",
    mailSent: "Mail envoye avec l'id {id}",
    syslogSent: "Message syslog envoye a {where}",
    syslogCheckFailed: "Echec du message syslog",
    failedUpdateSettings: "Echec de la mise a jour des parametres",
    configLockedByDesigner:
      "La configuration est verrouillee par une session de designer active{username}",
    configChangedElsewhere:
      "La configuration a ete modifiee ailleurs, rechargez avant d'enregistrer",
    failedImportConfig: "Echec de l'import de la configuration",
    failedExportConfig: "Echec de l'export de la configuration",
    failedLegacyCheck: "Echec de la verification de forms.yaml (ancien format)",
    failedConvertLegacy: "Echec de la conversion de forms.yaml",
    dbTypeNotSet: "Type de base de donnees non defini",
    logNotFound: "Fichier journal introuvable",
    failedGetLog: "Echec de la recuperation du journal",
    failedLoadHelp: "Echec du chargement de l'aide",
    fileUploadFailed: "Echec du televersement de fichier",
    failedFindLogo: "Échec de la récupération du logo",
    failedUpdateLogo: "Échec de la mise à jour du logo",
    logoNoFile: "Aucun fichier n'a été envoyé",
    logoInvalidImage:
      "Image invalide ou non supportée, les types autorisés sont png, jpeg, webp, gif et svg",
    failedFindFavicon: "Impossible d'obtenir l'icône du site",
    failedUpdateFavicon: "Impossible de mettre à jour l'icône du site",
    faviconInvalidImage:
      "Image invalide ou non prise en charge, types autorisés : png, ico, svg, webp, gif et jpeg",
    hostValueRequired: "Valeur d'hote requise",
    hostNameRequired:
      'Nom d\'hote requis (parametre de requete "name" ou "host")',
  },
  jobs: {
    cantApproveOwnJob:
      "Vous ne pouvez pas approuver votre propre tâche : un autre approbateur doit l'approuver",
    mustProvideJobId: "Vous devez fournir un jobid",
    abortRequested: "Arret de tache demande",
    failedAbort: "Echec de l'arret de la tache",
    failedRetrieve: "Echec de la recuperation de la tache",
    failedRetrieveJobs: "Echec de la recuperation des taches",
    failedRetrieveApprovals:
      "Echec de la recuperation des taches d'approbation",
    failedDelete: "Echec de la suppression de la tache",
    deleted: "Tache supprimee",
    failedLaunch: "Echec du lancement du formulaire",
    invalidFormData: "Les données du formulaire ne sont pas valides",
    invalidEventOrder:
      "L'ordre d'un événement est un nombre entier à partir de 0 : '{order}' ne l'est pas",
    failedRelaunch: "Echec du relancement de la tache",
    failedApprove: "Echec de l'approbation de la tache",
    failedReject: "Echec du rejet de la tache",
    approved: "La tache {id} a ete approuvee",
    rejected: "La tache {id} a ete rejetee",
    relaunched: "La tache a ete relancee avec l'id {id}",
    failedRetrieveRawData:
      "Echec de la recuperation des donnees brutes du formulaire",
  },
  email: {
    approval: {
      heading: "Demande d'approbation",
      subtitle: "Une demande d'approbation attend votre action",
      button: "Examiner la demande",
      regards: "Cordialement,<br>AnsibleForms",
    },
    jobstatus: {
      heading: "Mise a jour du statut de la tache",
      subtitle:
        "Les informations ci-dessous sont communiquees a titre informatif",
      button: "Statut de la tache",
      runDetails: "Details d'execution :",
      regards: "Cordialement,<br>AnsibleForms",
    },
    jobevent: {
      button: "Voir la tache",
      regards: "Cordialement,<br>AnsibleForms",
      // without a user, and with the user who did it : a whole sentence
      // each, so every language puts the name where its word order needs it
      launch: "La tache a ete lancee.",
      relaunch: "La tache a ete relancee.",
      delete: "La tache a ete supprimee.",
      approve: "La tache a ete approuvee et continuera son execution.",
      reject: "La tache a ete rejetee.",
      launchBy: "La tache a ete lancee par {user}.",
      relaunchBy: "La tache a ete relancee par {user}.",
      deleteBy: "La tache a ete supprimee par {user}.",
      approveBy:
        "La tache a ete approuvee par {user} et continuera son execution.",
      rejectBy: "La tache a ete rejetee par {user}.",
    },
    // the subjects : "AnsibleForms '<form>' [<type>] (<id>) - <one of these>", and the
    // approval one when the form gives no title
    subject: {
      approval: "Demande d'approbation AnsibleForms",
      event: {
        launch: "Lancée",
        relaunch: "Relancée",
        delete: "Supprimée",
        approve: "Approuvée",
        reject: "Rejetée",
      },
      status: {
        success: "Réussie",
        failed: "Échouée",
        aborted: "Interrompue",
        rejected: "Rejetée",
        abandoned: "Abandonnée",
        warning: "Avertissement",
      },
    },
    // the test mail of the mail settings
    test: {
      subject: "Message de test",
      body: "<p>Ceci est un message de test d'AnsibleForms</p>",
    },
  },
  // what a notification channel (Connections > Notifications) says : a test, a job's end
  notifications: {
    testText: "Une notification de test de {who} : le canal '{name}' la reçoit.",
    testSent: "Notification de test envoyée à {name}",
    testFailed: "La notification de test a échoué",
    statusText: "La tâche {jobid} du formulaire '{form}' est terminée : {status}.",
    openJob: "Ouvrir la tâche",
  },
};
