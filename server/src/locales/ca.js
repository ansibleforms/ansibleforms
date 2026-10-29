export default {
  errors: {
    databaseError:
      "S'ha produït un error de la base de dades: el registre del servidor en té els detalls",
    duplicateRecord: "Ja existeix un registre amb aquest nom",
    valueTooLong: "Un valor és massa llarg per al seu camp",
    noAccess: "No hi tens accés",
    notAdmin: "No ets administrador",
    noSettingsAccess: "No tens accés a la configuració",
    noDesignerAccess: "No tens accés al dissenyador",
    noFormDesignAccess: "No podeu editar els formularis al dissenyador",
    noPlaybookDesignAccess: "No podeu editar els playbooks al dissenyador",
    noWorkflowDesignAccess: "No podeu editar els fluxos de treball al dissenyador",
    noInventoryDesignAccess: "No podeu editar els inventaris al dissenyador",
    noVarsFileDesignAccess: "No podeu editar els fitxers de variables al dissenyador",
    noLogsAccess: "No tens accés als registres",
    noFileUploadAccess: "El vostre rol no permet pujar fitxers",
    noAuditAccess: "No tens accés al registre d'auditoria",
    noDatabaseAccess: "No tens accés a les operacions de base de dades",
    noScheduleAccess: "No tens permís per gestionar les tasques programades",
    noChatAccess: "No tens permís per utilitzar l'assistent de xat",
    noMcpAccess: "No tens permís per utilitzar el servidor MCP",
    noStoredJobsAccess: "No tens permís per gestionar les tasques desades",
    noDataSent: "No s'ha enviat cap dada",
    missingDbConfig: "Falta la configuració de la base de dades",
    provideRefreshToken: "Proporciona un token de refresc",
    invalidRefreshToken: "El token de refresc no és vàlid",
    refreshTokenExpired: "El token de refresc ha caducat",
    refreshTokenUnknown: "El token de refresc és desconegut",
    refreshTokenReplaced: "El token de refresc ja l'ha fet servir una altra renovació simultània",
    apiTokenFromApiToken: "Un token d'API no pot crear un altre token d'API",
    apiTokenNotAllowed: "El teu rol no permet tokens d'API",
    apiTokenSignInAgain: "Torna a iniciar sessió per crear un token d'API: el teu últim inici de sessió és massa antic",
    apiTokenLifetime: "La durada ha de ser un nombre de dies, com a màxim {max}",
    apiTokenFailed: "No s'ha pogut crear el token d'API",
    apiTokensFailed: "No s'han pogut llegir o canviar els tokens d'API",
    apiTokenNotFound: "No existeix aquest token d'API",
    requiredFields: "Proporciona tots els camps obligatoris",
    noVerbosePermission: "No tens permís per utilitzar el mode detallat",
  },
  auth: {
    authFailed: "L'autenticació ha fallat",
    invalidCredentials: "Les credencials no són vàlides",
    tooManyFailures:
      "Massa inicis de sessió fallits: torneu-ho a provar d'aquí a {minutes} minut(s)",
    passwordChangeRequired:
      "Canvieu primer la contrasenya: és la contrasenya per defecte, pública",
    disclaimerRequired: "Primer accepta l'avís legal",
    disclaimerAccepted: "L'avís legal s'ha acceptat",
    loginDisabled:
      "No autenticat, l'inici de sessió no està habilitat per a aquest usuari.",
    signInBlocked:
      "No autenticat, un administrador ha bloquejat l'inici de sessió d'aquest usuari.",
    entraFailed: "L'autenticació amb Azure AD ha fallat",
    oidcFailed: "L'autenticació OIDC ha fallat",
  },
  success: {
    created: "{resource} creat",
    updated: "{resource} actualitzat",
    deleted: "{resource} suprimit",
    connectionOk: "Connexió {resource} correcta",
  },
  audit: {
    failedGet: "No s'ha pogut obtenir el registre d'auditoria",
  },
  health: {
    failedCheck: "No s'ha pogut comprovar l'estat del sistema",
  },
  config: {
    failedGetFormsList: "No s'ha pogut obtenir la llista de formularis",
    formNameNotProvided: "No s'ha indicat el nom del formulari",
    failedGetFormConfig: "No s'ha pogut obtenir la configuració del formulari",
    onlyAdminsOrDesigners:
      "Només els administradors o els dissenyadors poden accedir a la configuració completa dels formularis",
    failedGetFormsConfig:
      "No s'ha pogut obtenir la configuració dels formularis",
    failedGetBackups: "No s'han pogut obtenir les còpies de seguretat",
    failedGetEnvVars: "No s'han pogut obtenir les variables d'entorn",
    failedSaveEnvVars: "No s'ha pogut desar la configuració de l'entorn",
    failedVaultCheck: "La prova de connexió amb Vault ha fallat",
    failedVaultMounts: "No s'han pogut llistar els punts de muntatge de Vault",
    noEnvVarsGiven: "No s'ha indicat cap variable d'entorn",
    envVarsSaved: "Configuració de l'entorn desada",
    envVarsNotFound:
      "No s'ha trobat la secció Environment Variables a help.yaml",
    failedRestoreForms: "No s'han pogut restaurar els formularis",
    failedRestoreNoName:
      "No s'ha pogut restaurar, no s'ha indicat el nom de la còpia de seguretat",
    failedRestoreBackup: "No s'ha pogut restaurar '{name}'",
    designerLocked: "El dissenyador està bloquejat",
    designerLockedBy: "El dissenyador està bloquejat per {username}",
    failedSaveForms: "No s'han pogut desar els formularis",
    failedValidateForms:
      "No s'ha pogut validar la nova configuració dels formularis",
    failedGetLock: "No s'ha pogut obtenir el bloqueig",
  },
  resources: {
    storedJobNameInUse:
      "Ja tens una tasca desada anomenada '{name}': tria un altre nom",
    cantTouchDirectoryAdmin:
      "Només un admin pot bloquejar, tancar la sessió, oblidar o revocar els tokens d'un usuari que té el rol admin",
    credentialNotFound:
      "No hi ha cap credencial anomenada '{name}'",
    repositoryCredentialType:
      "Un repositori inicia sessió amb un usuari i una contrasenya: la credencial '{name}' no té tots dos",
    credentialSignInAdminOnly:
      "Només un admin pot afegir, canviar o eliminar una credencial que fa servir un inici de sessió (LDAP, Microsoft Entra ID o OIDC)",
    credentialNotAllowed:
      "Només un admin pot fer servir aquí la credencial '{name}': la fa servir un runner, una connexió o un inici de sessió",
    storedKeyOtherProvider:
      "La clau desada només s'envia al proveïdor i a l'URL base desats: escriu la clau per comprovar-ne un altre",
    backupCreated: "Còpia de seguretat creada",
    lockAdded: "Bloqueig afegit",
    lockDeleted: "Bloqueig suprimit",
    scheduleAdded: "Programació afegida",
    scheduleQueued: "Programació posada a la cua",
    scheduleLaunched: "Programació llançada",
    storedJobAdded: "Tasca desada afegida",
    storedJobUpdated: "Tasca desada actualitzada",
    storedJobDeleted: "Tasca desada suprimida",
    storedJobNoAccess: "No tens accés a aquesta tasca desada",
    storedJobVisibilityInvalid: "Una tasca desada és privada o compartida",
    storedJobShareDenied: "No tens permís per compartir tasques desades",
    storedJobShareFormDisabled: "El formulari '{form}' no permet compartir les seves tasques desades",
    oauth2Added: "Proveïdor OAuth2 afegit",
    runnerAdded: "Runner afegit",
    joinTokenMade: "Token d'unió creat: copia'l ara, no es tornarà a mostrar",
    joinTokenRevoked: "Token d'unió revocat",
    joinTokenDeleted: "Token d'unió eliminat",
    joinTokenNotFound: "No s'ha trobat el token d'unió",
    runnerNotFound: "No s'ha trobat el runner",
    runnerAdminOnly:
      "Només un admin pot afegir, canviar o eliminar un runner: un runner rep les credencials dels treballs que executa",
    repositoryAdminOnly:
      "Només un admin pot afegir o eliminar un repositori, o canviar-ne l'adreça, la branca o per a què s'usa: el seu contingut esdevé la configuració, els formularis o els playbooks que executa AnsibleForms",
    secretStoreAdminOnly:
      "Només un admin pot afegir, canviar o eliminar un magatzem de secrets: inicia sessió amb un token o una clau que s'enviaria a la seva adreça",
    credentialSecretRefAdminOnly:
      "Només un admin pot triar o canviar el magatzem de secrets i el secret del qual una credencial llegeix la contrasenya",
    credentialAdminOnly:
      "Només un admin pot afegir, canviar o eliminar aquesta credencial: un runner o una connexió en pren l'adreça i el secret",
    credentialInUse:
      "La credencial '{name}' està en ús per {count} registre(s), llistats a la pestanya Usada per: canvieu-los primer",
    defaultPasswordRefused:
      "Trieu una altra contrasenya que no sigui la pública per defecte",
    passwordTooShort: "La contrasenya necessita almenys {min} caràcters",
    passwordIsUsername: "La contrasenya no pot ser el nom d'usuari",
    runnerConnectionOk: "La connexió amb el runner és correcta",
    runnerConnectionOkDetails: "La connexió amb el runner és correcta: {details}",
    runnerRteRelease: "RTE {version}",
    runnerAnsibleCore: "Ansible core {version}",
    runnerAnsible: "Ansible {version}",
    runnerOnNode: "al node {node}",
    runnerDetailsSeparator: ", ",
    secretStoreAdded: "Magatzem de secrets afegit",
    secretStoreNotFound: "No s'ha trobat el magatzem de secrets",
    secretStoreConnectionOk:
      "La connexió amb el magatzem de secrets és correcta",
    userNotFound: "No s'ha trobat l'usuari",
    currentPasswordRequired:
      "Cal la teva contrasenya actual per establir-ne una de nova",
    currentPasswordWrong: "La contrasenya actual no és correcta",
    cantChangePasswordLdap: "No pots canviar la contrasenya d'un usuari LDAP",
    directoryTypeUnknown: "No és un usuari o grup LDAP, Microsoft Entra ID o OIDC",
    directoryUserKept:
      "Un administrador ha bloquejat aquest usuari: permet-ne l'inici de sessió abans d'oblidar-lo",
    failedDirectoryUser: "No s'ha pogut llegir o canviar l'usuari LDAP o SSO",
    cantBlockAdmin:
      "L'usuari admin no es pot bloquejar: és la manera de tornar a entrar",
    cantBlockYourself: "No pots bloquejar el teu propi inici de sessió",
    groupNotFound: "No s'ha trobat aquest grup",
    groupHasUsers: "Grup desconegut o el grup té usuaris",
    failedFindGroup: "No s'ha pogut trobar el grup",
    failedCreateGroup: "No s'ha pogut crear el grup",
    failedUpdateGroup: "No s'ha pogut actualitzar el grup",
    failedDeleteGroup: "No s'ha pogut suprimir el grup",
    failedFindRepositories: "No s'han pogut trobar els repositoris",
    failedFindRepository: "No s'ha pogut trobar el repositori",
    failedCreateRepository: "No s'ha pogut crear el repositori",
    failedUpdateRepository: "No s'ha pogut actualitzar el repositori",
    failedDeleteRepository: "No s'ha pogut suprimir el repositori",
    failedCloneRepository: "No s'ha pogut clonar el repositori",
    failedResetRepository: "No s'ha pogut restablir el repositori",
    failedPullRepository: "No s'ha pogut fer pull del repositori",
    failedSyncRepository: "No s’ha pogut fer push del repositori",
    noFormsRepositories: "No hi ha cap repositori de formularis configurat",
    failedApplyConfigSeed: "No s'ha pogut aplicar el config seed",
    noConfigSeed:
      "No hi ha cap config seed configurat (CONFIG_SEED_PATH és buit)",
    failedFindSsh: "No s'ha pogut trobar la clau SSH",
    failedUpdateSsh: "No s'ha pogut actualitzar la clau SSH",
    failedFindChatSettings: "No s'ha pogut trobar la configuració del xat",
    failedUpdateChatSettings:
      "No s'ha pogut actualitzar la configuració del xat",
    seedManagedChatSettings:
      "La configuració del xat la gestiona el config seed i és de només lectura",
    chatSettingsUpdated: "Configuració del xat actualitzada",
    chatCheckFailed: "La comprovació del proveïdor del xat ha fallat",
    failedFindLdap: "No s'ha pogut trobar l'LDAP",
    ldapCheckFailed: "La comprovació de l'LDAP ha fallat",
    storedPasswordOtherServer:
      "La contrasenya desada només s'utilitza amb el servidor desat: escriviu la contrasenya per comprovar-ne un altre",
    ldapUpdated: "LDAP actualitzat",
    failedUpdateLdap: "No s'ha pogut actualitzar l'LDAP",
    ldapCreated: "Directori LDAP afegit",
    failedCreateLdap: "No s'ha pogut afegir el directori LDAP",
    ldapDeleted: "Directori LDAP eliminat",
    ldapNotFound: "Directori LDAP no trobat",
    failedDeleteLdap: "No s'ha pogut eliminar el directori LDAP",
    seedManagedSettings:
      "La configuració la gestiona el config seed i és de només lectura",
    seedManagedLdap:
      "La configuració de l'LDAP la gestiona el config seed i és de només lectura",
    failedFindSettings: "No s'ha pogut trobar la configuració",
    mailCheckFailed: "La comprovació del correu ha fallat",
    mailSent: "Correu enviat amb l'id {id}",
    syslogSent: "Missatge de syslog enviat a {where}",
    syslogCheckFailed: "L'enviament del missatge de syslog ha fallat",
    failedUpdateSettings: "No s'ha pogut actualitzar la configuració",
    configLockedByDesigner:
      "La configuració està bloquejada per una sessió activa del dissenyador{username}",
    configChangedElsewhere:
      "La configuració s'ha canviat en un altre lloc, torna-la a carregar abans de desar",
    failedImportConfig: "No s'ha pogut importar la configuració",
    failedExportConfig: "No s'ha pogut exportar la configuració",
    failedLegacyCheck: "No s'ha pogut comprovar si hi ha un forms.yaml antic",
    failedConvertLegacy: "No s'ha pogut convertir forms.yaml",
    dbTypeNotSet: "No s'ha definit el tipus de base de dades",
    logNotFound: "No s'ha trobat el fitxer de registre",
    failedGetLog: "No s'ha pogut obtenir el registre",
    failedLoadHelp: "No s'ha pogut carregar l'ajuda",
    fileUploadFailed: "La pujada del fitxer ha fallat",
    failedFindLogo: "No s'ha pogut obtenir el logotip",
    failedUpdateLogo: "No s'ha pogut actualitzar el logotip",
    logoNoFile: "No s'ha pujat cap fitxer",
    logoInvalidImage:
      "La imatge no és vàlida o no és compatible, els tipus permesos són png, jpeg, webp, gif i svg",
    failedFindFavicon: "No s'ha pogut obtenir la icona del lloc",
    failedUpdateFavicon: "No s'ha pogut actualitzar la icona del lloc",
    faviconInvalidImage:
      "Imatge no vàlida o no compatible, els tipus permesos són png, ico, svg, webp, gif i jpeg",
    hostValueRequired: "Cal un valor d'amfitrió",
    hostNameRequired:
      'Cal el nom de l\'amfitrió (paràmetre de consulta "name" o "host")',
  },
  jobs: {
    cantApproveOwnJob:
      "No pots aprovar la teva pròpia tasca: l'ha d'aprovar un altre aprovador",
    mustProvideJobId: "Has d'indicar un jobid",
    abortRequested: "S'ha sol·licitat l'avortament de la tasca",
    failedAbort: "No s'ha pogut avortar la tasca",
    failedRetrieve: "No s'ha pogut obtenir la tasca",
    failedRetrieveJobs: "No s'han pogut obtenir les tasques",
    failedRetrieveApprovals:
      "No s'han pogut obtenir les tasques pendents d'aprovació",
    failedDelete: "No s'ha pogut suprimir la tasca",
    deleted: "Tasca suprimida",
    failedLaunch: "No s'ha pogut llançar el formulari",
    invalidFormData: "Les dades del formulari no són vàlides",
    invalidEventOrder:
      "L'ordre d'un esdeveniment és un nombre enter des de 0: '{order}' no ho és",
    failedRelaunch: "No s'ha pogut tornar a llançar la tasca",
    failedApprove: "No s'ha pogut aprovar la tasca",
    failedReject: "No s'ha pogut rebutjar la tasca",
    approved: "La tasca {id} s'ha aprovat",
    rejected: "La tasca {id} s'ha rebutjat",
    relaunched: "La tasca s'ha tornat a llançar amb l'id de tasca {id}",
    failedRetrieveRawData:
      "No s'han pogut obtenir les dades en brut del formulari",
  },
  email: {
    approval: {
      heading: "Sol·licitud d'aprovació",
      subtitle: "Hi ha una sol·licitud d'aprovació que espera la teva acció",
      button: "Revisa la sol·licitud d'aprovació",
      regards: "Salutacions,<br>AnsibleForms",
    },
    jobstatus: {
      heading: "Actualització de l'estat de la tasca",
      subtitle: "El següent és per a la teva informació",
      button: "Estat de la tasca",
      runDetails: "Detalls de l'execució :",
      regards: "Salutacions,<br>AnsibleForms",
    },
    jobevent: {
      button: "Mostra la tasca",
      regards: "Salutacions,<br>AnsibleForms",
      // without a user, and with the user who did it : a whole sentence
      // each, so every language puts the name where its word order needs it
      launch: "La tasca s'ha llançat.",
      relaunch: "La tasca s'ha tornat a llançar.",
      delete: "La tasca s'ha suprimit.",
      approve: "La tasca s'ha aprovat i continuarà l'execució.",
      reject: "La tasca s'ha rebutjat.",
      launchBy: "{user} ha llançat la tasca.",
      relaunchBy: "{user} ha tornat a llançar la tasca.",
      deleteBy: "{user} ha suprimit la tasca.",
      approveBy: "{user} ha aprovat la tasca, que continuarà l'execució.",
      rejectBy: "{user} ha rebutjat la tasca.",
    },
    // the subjects : "AnsibleForms '<form>' [<type>] (<id>) - <one of these>", and the
    // approval one when the form gives no title
    subject: {
      approval: "Sol·licitud d'aprovació d'AnsibleForms",
      event: {
        launch: "Llançada",
        relaunch: "Rellançada",
        delete: "Suprimida",
        approve: "Aprovada",
        reject: "Rebutjada",
      },
      status: {
        success: "Correcta",
        failed: "Fallida",
        aborted: "Avortada",
        rejected: "Rebutjada",
        abandoned: "Abandonada",
        warning: "Avís",
      },
    },
    // the test mail of the mail settings
    test: {
      subject: "Missatge de prova",
      body: "<p>Aquest és un missatge de prova d'AnsibleForms</p>",
    },
  },
  // what a notification channel (Connections > Notifications) says : a test, a job's end
  notifications: {
    testText: "Una notificació de prova de {who}: el canal '{name}' la rep.",
    testSent: "Notificació de prova enviada a {name}",
    testFailed: "La notificació de prova ha fallat",
    statusText: "La tasca {jobid} del formulari '{form}' ha acabat: {status}.",
    openJob: "Obre la tasca",
  },
};
