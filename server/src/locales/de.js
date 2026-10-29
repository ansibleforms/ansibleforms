export default {
  errors: {
    databaseError:
      "Ein Datenbankfehler ist aufgetreten: das Serverprotokoll enthaelt die Details",
    duplicateRecord: "Ein Eintrag mit diesem Namen existiert bereits",
    valueTooLong: "Ein Wert ist zu lang fuer sein Feld",
    noAccess: "Kein Zugriff",
    notAdmin: "Du bist kein Administrator",
    noSettingsAccess: "Du hast keinen Zugriff auf Einstellungen",
    noDesignerAccess: "Du hast keinen Zugriff auf den Designer",
    noFormDesignAccess: "Sie dürfen die Formulare im Designer nicht bearbeiten",
    noPlaybookDesignAccess: "Sie dürfen die Playbooks im Designer nicht bearbeiten",
    noWorkflowDesignAccess: "Sie dürfen die Workflows im Designer nicht bearbeiten",
    noInventoryDesignAccess: "Sie dürfen die Inventare im Designer nicht bearbeiten",
    noVarsFileDesignAccess: "Sie dürfen die Variablendateien im Designer nicht bearbeiten",
    noLogsAccess: "Du hast keinen Zugriff auf Logs",
    noFileUploadAccess: "Ihre Rolle erlaubt keine Datei-Uploads",
    noAuditAccess: "Du hast keinen Zugriff auf das Audit-Protokoll",
    noDatabaseAccess: "Du hast keinen Zugriff auf Datenbankoperationen",
    noScheduleAccess: "Du hast keine Berechtigung, geplante Jobs zu verwalten",
    noChatAccess:
      "Sie haben keine Berechtigung, den Chat-Assistenten zu verwenden",
    noMcpAccess: "Sie haben keine Berechtigung, den MCP-Server zu verwenden",
    noStoredJobsAccess:
      "Du hast keine Berechtigung, gespeicherte Jobs zu verwalten",
    noDataSent: "Es wurden keine Daten gesendet",
    missingDbConfig: "Fehlende Datenbankkonfiguration",
    provideRefreshToken: "Bitte Refresh-Token angeben",
    invalidRefreshToken: "Ungueltiger Refresh-Token",
    refreshTokenExpired: "Refresh-Token ist abgelaufen",
    refreshTokenUnknown: "Refresh-Token ist unbekannt",
    refreshTokenReplaced: "Refresh-Token wurde bereits von einer gleichzeitigen Erneuerung verwendet",
    apiTokenFromApiToken: "Ein API-Token kann kein weiteres API-Token erstellen",
    apiTokenNotAllowed: "Ihre Rolle erlaubt keine API-Tokens",
    apiTokenSignInAgain: "Melden Sie sich erneut an, um ein API-Token zu erstellen: Ihre letzte Anmeldung liegt zu lange zurück",
    apiTokenLifetime: "Die Laufzeit muss eine Anzahl von Tagen sein, höchstens {max}",
    apiTokenFailed: "Das API-Token konnte nicht erstellt werden",
    apiTokensFailed: "Die API-Tokens konnten nicht gelesen oder geändert werden",
    apiTokenNotFound: "Dieses API-Token gibt es nicht",
    requiredFields: "Bitte alle Pflichtfelder ausfuellen",
    noVerbosePermission: "Du hast keine Berechtigung fuer den Verbose-Modus",
  },
  auth: {
    authFailed: "Authentifizierung fehlgeschlagen",
    invalidCredentials: "Ungueltige Zugangsdaten",
    tooManyFailures:
      "Zu viele fehlgeschlagene Anmeldungen: versuchen Sie es in {minutes} Minute(n) erneut",
    passwordChangeRequired:
      "Ändern Sie zuerst Ihr Passwort: es ist das öffentlich bekannte Standardpasswort",
    disclaimerRequired: "Akzeptieren Sie zuerst den Haftungsausschluss",
    disclaimerAccepted: "Der Haftungsausschluss ist akzeptiert",
    loginDisabled:
      "Nicht authentifiziert, Login ist fuer diesen Benutzer nicht aktiviert.",
    signInBlocked:
      "Nicht authentifiziert, ein Administrator hat die Anmeldung dieses Benutzers gesperrt.",
    entraFailed: "Azure AD Authentifizierung fehlgeschlagen",
    oidcFailed: "OIDC Authentifizierung fehlgeschlagen",
  },
  success: {
    created: "{resource} erstellt",
    updated: "{resource} aktualisiert",
    deleted: "{resource} geloescht",
    connectionOk: "{resource}-Verbindung OK",
  },
  audit: {
    failedGet: "Audit-Protokoll konnte nicht geladen werden",
  },
  health: {
    failedCheck: "Systemzustand konnte nicht geprüft werden",
  },
  config: {
    failedGetFormsList: "Abrufen der Formularliste fehlgeschlagen",
    formNameNotProvided: "Formularname nicht angegeben",
    failedGetFormConfig: "Abrufen der Formularkonfiguration fehlgeschlagen",
    onlyAdminsOrDesigners:
      "Nur Administratoren oder Designer koennen auf die vollstaendige Formularkonfiguration zugreifen",
    failedGetFormsConfig: "Abrufen der Formularkonfiguration fehlgeschlagen",
    failedGetBackups: "Abrufen der Backups fehlgeschlagen",
    failedGetEnvVars: "Abrufen der Umgebungsvariablen fehlgeschlagen",
    failedSaveEnvVars:
      "Umgebungseinstellungen konnten nicht gespeichert werden",
    failedVaultCheck: "Vault-Verbindungstest fehlgeschlagen",
    failedVaultMounts: "Vault-Mounts konnten nicht aufgelistet werden",
    noEnvVarsGiven: "Es wurden keine Umgebungsvariablen angegeben",
    envVarsSaved: "Umgebungseinstellungen gespeichert",
    envVarsNotFound:
      "Abschnitt fuer Umgebungsvariablen in help.yaml nicht gefunden",
    failedRestoreForms: "Wiederherstellung der Formulare fehlgeschlagen",
    failedRestoreNoName:
      "Wiederherstellung fehlgeschlagen, kein Backup-Name angegeben",
    failedRestoreBackup: "Wiederherstellung von '{name}' fehlgeschlagen",
    designerLocked: "Designer ist gesperrt",
    designerLockedBy: "Designer ist durch {username} gesperrt",
    failedSaveForms: "Speichern der Formulare fehlgeschlagen",
    failedValidateForms:
      "Validierung der neuen Formularkonfiguration fehlgeschlagen",
    failedGetLock: "Abrufen der Sperre fehlgeschlagen",
  },
  resources: {
    storedJobNameInUse:
      "Du hast bereits einen gespeicherten Job namens '{name}': waehle einen anderen Namen",
    cantTouchDirectoryAdmin:
      "Nur ein Admin kann einen Benutzer mit der Admin-Rolle sperren, abmelden, vergessen oder seine Tokens widerrufen",
    credentialNotFound:
      "Keine Zugangsdaten mit dem Namen '{name}'",
    repositoryCredentialType:
      "Ein Repository meldet sich mit Benutzer und Passwort an: die Zugangsdaten '{name}' haben nicht beides",
    credentialSignInAdminOnly:
      "Nur ein Admin kann Zugangsdaten hinzufuegen, aendern oder loeschen, die eine Anmeldung verwendet (LDAP, Microsoft Entra ID oder OIDC)",
    credentialNotAllowed:
      "Nur ein Admin kann die Zugangsdaten '{name}' hier verwenden: ein Runner, eine Verbindung oder eine Anmeldung verwendet sie",
    storedKeyOtherProvider:
      "Der gespeicherte Schluessel wird nur an den gespeicherten Anbieter und die Basis-URL gesendet: gib den Schluessel ein, um einen anderen zu pruefen",
    backupCreated: "Backup erstellt",
    lockAdded: "Sperre hinzugefuegt",
    lockDeleted: "Sperre entfernt",
    scheduleAdded: "Zeitplan hinzugefuegt",
    scheduleQueued: "Zeitplan in Warteschlange gestellt",
    scheduleLaunched: "Zeitplan gestartet",
    storedJobAdded: "Gespeicherter Job hinzugefuegt",
    storedJobUpdated: "Gespeicherter Job aktualisiert",
    storedJobDeleted: "Gespeicherter Job geloescht",
    storedJobNoAccess: "Du hast keinen Zugriff auf diesen gespeicherten Job",
    storedJobVisibilityInvalid: "Ein gespeicherter Job ist privat oder geteilt",
    storedJobShareDenied: "Du hast keine Berechtigung, gespeicherte Jobs zu teilen",
    storedJobShareFormDisabled: "Formular '{form}' erlaubt kein Teilen seiner gespeicherten Jobs",
    oauth2Added: "OAuth2-Anbieter hinzugefuegt",
    secretStoreAdded: "Secret Store hinzugefuegt",
    secretStoreNotFound: "Secret Store nicht gefunden",
    secretStoreConnectionOk: "Verbindung zum Secret Store ist OK",
    runnerAdded: "Runner hinzugefügt",
    joinTokenMade: "Beitrittstoken erstellt: jetzt kopieren, es wird nicht noch einmal angezeigt",
    joinTokenRevoked: "Beitrittstoken widerrufen",
    joinTokenDeleted: "Beitrittstoken gelöscht",
    joinTokenNotFound: "Beitrittstoken nicht gefunden",
    runnerNotFound: "Runner nicht gefunden",
    runnerAdminOnly:
      "Nur ein Admin kann einen Runner hinzufuegen, aendern oder loeschen: ein Runner erhaelt die Zugangsdaten der Jobs, die er ausfuehrt",
    repositoryAdminOnly:
      "Nur ein Admin kann ein Repository hinzufuegen oder loeschen oder seine Adresse, seinen Branch oder seine Verwendung aendern: sein Inhalt wird die Konfiguration, die Formulare oder die Playbooks, die AnsibleForms ausfuehrt",
    secretStoreAdminOnly:
      "Nur ein Admin kann einen Secret Store hinzufuegen, aendern oder loeschen: er meldet sich mit einem Token oder Schluessel an, der an seine Adresse gesendet wuerde",
    credentialSecretRefAdminOnly:
      "Nur ein Admin kann den Secret Store und das Secret waehlen oder aendern, aus dem ein Zugangsdatum sein Passwort liest",
    credentialAdminOnly:
      "Nur ein Admin kann diese Zugangsdaten hinzufuegen, aendern oder loeschen: ein Runner oder eine Verbindung nimmt daraus seine Adresse und sein Geheimnis",
    credentialInUse:
      "Die Zugangsdaten '{name}' werden von {count} Eintrag/Eintraegen verwendet, aufgelistet im Reiter Verwendet von: aendern Sie diese zuerst",
    defaultPasswordRefused:
      "Wählen Sie ein anderes Passwort als das öffentliche Standardpasswort",
    passwordTooShort: "Das Passwort braucht mindestens {min} Zeichen",
    passwordIsUsername: "Das Passwort darf nicht der Benutzername sein",
    runnerConnectionOk: "Runner-Verbindung ist OK",
    runnerConnectionOkDetails: "Runner-Verbindung ist OK: {details}",
    runnerRteRelease: "RTE {version}",
    runnerAnsibleCore: "Ansible core {version}",
    runnerAnsible: "Ansible {version}",
    runnerOnNode: "auf Knoten {node}",
    runnerDetailsSeparator: ", ",
    userNotFound: "Benutzer nicht gefunden",
    currentPasswordRequired:
      "Zum Festlegen eines neuen Passworts ist Ihr aktuelles Passwort erforderlich",
    currentPasswordWrong: "Das aktuelle Passwort ist nicht korrekt",
    cantChangePasswordLdap:
      "Du kannst das Passwort fuer einen LDAP-Benutzer nicht aendern",
    directoryTypeUnknown:
      "Kein LDAP-, Microsoft-Entra-ID- oder OIDC-Benutzer bzw. -Gruppe",
    directoryUserKept:
      "Ein Administrator hat diesen Benutzer gesperrt: erlaube die Anmeldung, bevor du ihn vergisst",
    failedDirectoryUser:
      "Der LDAP- oder SSO-Benutzer konnte nicht gelesen oder geändert werden",
    cantBlockAdmin:
      "Der Benutzer admin kann nicht gesperrt werden: er ist der Weg zurück",
    cantBlockYourself: "Du kannst deine eigene Anmeldung nicht sperren",
    groupNotFound: "Keine passende Gruppe gefunden",
    groupHasUsers: "Unbekannte Gruppe oder Gruppe mit Benutzern",
    failedFindGroup: "Gruppe konnte nicht gefunden werden",
    failedCreateGroup: "Gruppe konnte nicht erstellt werden",
    failedUpdateGroup: "Gruppe konnte nicht aktualisiert werden",
    failedDeleteGroup: "Gruppe konnte nicht geloescht werden",
    failedFindRepositories: "Repositories konnten nicht gefunden werden",
    failedFindRepository: "Repository konnte nicht gefunden werden",
    failedCreateRepository: "Repository konnte nicht erstellt werden",
    failedUpdateRepository: "Repository konnte nicht aktualisiert werden",
    failedDeleteRepository: "Repository konnte nicht geloescht werden",
    failedCloneRepository: "Repository konnte nicht geklont werden",
    failedResetRepository: "Repository konnte nicht zurueckgesetzt werden",
    failedPullRepository: "Repository konnte nicht gepullt werden",
    failedSyncRepository: "Das Repository konnte nicht gepusht werden",
    noFormsRepositories: "Keine Forms-Repositories konfiguriert",
    failedApplyConfigSeed: "Konfigurations-Seed konnte nicht angewendet werden",
    noConfigSeed:
      "Es ist kein Konfigurations-Seed konfiguriert (CONFIG_SEED_PATH ist leer)",
    failedFindSsh: "SSH-Schluessel konnte nicht gefunden werden",
    failedUpdateSsh: "SSH-Schluessel konnte nicht aktualisiert werden",
    failedFindChatSettings: "Chat-Einstellungen konnten nicht gefunden werden",
    failedUpdateChatSettings:
      "Chat-Einstellungen konnten nicht aktualisiert werden",
    seedManagedChatSettings:
      "Die Chat-Einstellungen werden vom Config-Seed verwaltet und sind schreibgeschützt",
    chatSettingsUpdated: "Chat-Einstellungen aktualisiert",
    chatCheckFailed: "Die Prüfung des Chat-Anbieters ist fehlgeschlagen",
    failedFindLdap: "LDAP konnte nicht gefunden werden",
    ldapCheckFailed: "LDAP-Pruefung fehlgeschlagen",
    storedPasswordOtherServer:
      "Das gespeicherte Passwort gilt nur fuer den gespeicherten Server: geben Sie das Passwort ein, um einen anderen zu pruefen",
    ldapUpdated: "LDAP aktualisiert",
    failedUpdateLdap: "LDAP-Aktualisierung fehlgeschlagen",
    ldapCreated: "LDAP-Verzeichnis hinzugefügt",
    failedCreateLdap: "LDAP-Verzeichnis konnte nicht hinzugefügt werden",
    ldapDeleted: "LDAP-Verzeichnis gelöscht",
    ldapNotFound: "LDAP-Verzeichnis nicht gefunden",
    failedDeleteLdap: "LDAP-Verzeichnis konnte nicht gelöscht werden",
    seedManagedSettings:
      "Die Einstellungen werden vom Konfigurations-Seed verwaltet und sind schreibgeschützt",
    seedManagedLdap:
      "Die LDAP-Konfiguration wird vom Konfigurations-Seed verwaltet und ist schreibgeschützt",
    failedFindSettings: "Einstellungen konnten nicht gefunden werden",
    mailCheckFailed: "Mail-Pruefung fehlgeschlagen",
    mailSent: "Mail mit ID {id} gesendet",
    syslogSent: "Syslog-Nachricht an {where} gesendet",
    syslogCheckFailed: "Syslog-Nachricht fehlgeschlagen",
    failedUpdateSettings: "Einstellungen konnten nicht aktualisiert werden",
    configLockedByDesigner:
      "Die Konfiguration ist durch eine aktive Designer-Sitzung gesperrt{username}",
    configChangedElsewhere:
      "Die Konfiguration wurde an anderer Stelle geändert, vor dem Speichern neu laden",
    failedImportConfig: "Import der Konfiguration fehlgeschlagen",
    failedExportConfig: "Export der Konfiguration fehlgeschlagen",
    failedLegacyCheck: "Prüfung auf veraltete forms.yaml fehlgeschlagen",
    failedConvertLegacy: "Konvertierung der forms.yaml fehlgeschlagen",
    dbTypeNotSet: "Datenbanktyp nicht gesetzt",
    logNotFound: "Logdatei nicht gefunden",
    failedGetLog: "Abrufen des Logs fehlgeschlagen",
    failedLoadHelp: "Laden der Hilfe fehlgeschlagen",
    fileUploadFailed: "Datei-Upload fehlgeschlagen",
    failedFindLogo: "Logo konnte nicht geladen werden",
    failedUpdateLogo: "Logo konnte nicht aktualisiert werden",
    logoNoFile: "Es wurde keine Datei hochgeladen",
    logoInvalidImage:
      "Ungültiges oder nicht unterstütztes Bild, erlaubte Typen sind png, jpeg, webp, gif und svg",
    failedFindFavicon: "Das Website-Symbol konnte nicht abgerufen werden",
    failedUpdateFavicon: "Das Website-Symbol konnte nicht aktualisiert werden",
    faviconInvalidImage:
      "Ungültiges oder nicht unterstütztes Bild, erlaubt sind png, ico, svg, webp, gif und jpeg",
    hostValueRequired: "Host-Wert erforderlich",
    hostNameRequired:
      'Host-Name erforderlich (Query-Parameter "name" oder "host")',
  },
  jobs: {
    cantApproveOwnJob:
      "Du kannst deinen eigenen Job nicht genehmigen: ein anderer Genehmiger muss ihn genehmigen",
    mustProvideJobId: "Du musst eine Job-ID angeben",
    abortRequested: "Job-Abbruch angefordert",
    failedAbort: "Job-Abbruch fehlgeschlagen",
    failedRetrieve: "Job konnte nicht geladen werden",
    failedRetrieveJobs: "Jobs konnten nicht geladen werden",
    failedRetrieveApprovals: "Freigabe-Jobs konnten nicht geladen werden",
    failedDelete: "Job konnte nicht geloescht werden",
    deleted: "Job geloescht",
    failedLaunch: "Formular konnte nicht gestartet werden",
    invalidFormData: "Die Formulardaten sind ungültig",
    invalidEventOrder:
      "Die Reihenfolge eines Events ist eine ganze Zahl ab 0: '{order}' ist keine",
    failedRelaunch: "Job konnte nicht neu gestartet werden",
    failedApprove: "Job-Freigabe fehlgeschlagen",
    failedReject: "Job-Ablehnung fehlgeschlagen",
    approved: "Job {id} wurde freigegeben",
    rejected: "Job {id} wurde abgelehnt",
    relaunched: "Job wurde mit Job-ID {id} neu gestartet",
    failedRetrieveRawData: "Rohe Formulardaten konnten nicht geladen werden",
  },
  email: {
    approval: {
      heading: "Freigabeanfrage",
      subtitle: "Eine Freigabeanfrage wartet auf deine Aktion",
      button: "Freigabeanfrage pruefen",
      regards: "Viele Gruesse,<br>AnsibleForms",
    },
    jobstatus: {
      heading: "Job-Status Update",
      subtitle: "Die folgenden Informationen dienen zu deiner Information",
      button: "Job-Status",
      runDetails: "Ausfuehrungsdetails :",
      regards: "Viele Gruesse,<br>AnsibleForms",
    },
    jobevent: {
      button: "Job anzeigen",
      regards: "Viele Gruesse,<br>AnsibleForms",
      // without a user, and with the user who did it : a whole sentence
      // each, so every language puts the name where its word order needs it
      launch: "Job wurde gestartet.",
      relaunch: "Job wurde neu gestartet.",
      delete: "Job wurde geloescht.",
      approve: "Job wurde freigegeben und wird weiter ausgefuehrt.",
      reject: "Job wurde abgelehnt.",
      launchBy: "Job wurde von {user} gestartet.",
      relaunchBy: "Job wurde von {user} neu gestartet.",
      deleteBy: "Job wurde von {user} geloescht.",
      approveBy:
        "Job wurde von {user} freigegeben und wird weiter ausgefuehrt.",
      rejectBy: "Job wurde von {user} abgelehnt.",
    },
    // the subjects : "AnsibleForms '<form>' [<type>] (<id>) - <one of these>", and the
    // approval one when the form gives no title
    subject: {
      approval: "AnsibleForms Freigabeanfrage",
      event: {
        launch: "Gestartet",
        relaunch: "Neu gestartet",
        delete: "Gelöscht",
        approve: "Freigegeben",
        reject: "Abgelehnt",
      },
      status: {
        success: "Erfolgreich",
        failed: "Fehlgeschlagen",
        aborted: "Abgebrochen",
        rejected: "Abgelehnt",
        abandoned: "Verworfen",
        warning: "Warnung",
      },
    },
    // the test mail of the mail settings
    test: {
      subject: "Testnachricht",
      body: "<p>Dies ist eine Testnachricht von AnsibleForms</p>",
    },
  },
  // what a notification channel (Connections > Notifications) says : a test, a job's end
  notifications: {
    testText: "Eine Testbenachrichtigung von {who}: der Kanal '{name}' empfängt sie.",
    testSent: "Testbenachrichtigung an {name} gesendet",
    testFailed: "Testbenachrichtigung fehlgeschlagen",
    statusText: "Job {jobid} des Formulars '{form}' ist beendet: {status}.",
    openJob: "Job öffnen",
  },
};
