export default {
  errors: {
    databaseError:
      "Wystąpił błąd bazy danych: szczegóły są w dzienniku serwera",
    duplicateRecord: "Rekord o tej nazwie już istnieje",
    valueTooLong: "Wartość jest za długa dla swojego pola",
    noAccess: "Brak dostępu",
    notAdmin: "Nie jesteś administratorem",
    noSettingsAccess: "Nie masz dostępu do ustawień",
    noDesignerAccess: "Nie masz dostępu do projektanta",
    noFormDesignAccess: "Nie możesz edytować formularzy w designerze",
    noPlaybookDesignAccess: "Nie możesz edytować playbooków w designerze",
    noWorkflowDesignAccess: "Nie możesz edytować przepływów pracy w designerze",
    noInventoryDesignAccess: "Nie możesz edytować inwentarzy w designerze",
    noVarsFileDesignAccess: "Nie możesz edytować plików zmiennych w designerze",
    noLogsAccess: "Nie masz dostępu do dzienników",
    noFileUploadAccess: "Twoja rola nie pozwala na przesyłanie plików",
    noAuditAccess: "Nie masz dostępu do dziennika audytu",
    noDatabaseAccess: "Nie masz dostępu do operacji na bazie danych",
    noScheduleAccess:
      "Nie masz uprawnień do zarządzania zaplanowanymi zadaniami",
    noChatAccess: "Nie masz uprawnień do korzystania z asystenta czatu",
    noMcpAccess: "Nie masz uprawnień do korzystania z serwera MCP",
    noStoredJobsAccess:
      "Nie masz uprawnień do zarządzania zapisanymi zadaniami",
    noDataSent: "Nie wysłano żadnych danych",
    missingDbConfig: "Brak konfiguracji bazy danych",
    provideRefreshToken: "Podaj refresh token",
    invalidRefreshToken: "Nieprawidłowy refresh token",
    refreshTokenExpired: "Refresh token wygasł",
    refreshTokenUnknown: "Nieznany refresh token",
    refreshTokenReplaced: "Refresh token został już użyty przez równoczesne odświeżenie",
    apiTokenFromApiToken: "Token API nie może utworzyć innego tokenu API",
    apiTokenNotAllowed: "Twoja rola nie pozwala na tokeny API",
    apiTokenSignInAgain: "Zaloguj się ponownie, aby utworzyć token API: ostatnie logowanie było zbyt dawno",
    apiTokenLifetime: "Czas ważności musi być liczbą dni, najwyżej {max}",
    apiTokenFailed: "Nie udało się utworzyć tokenu API",
    apiTokensFailed: "Nie udało się odczytać ani zmienić tokenów API",
    apiTokenNotFound: "Taki token API nie istnieje",
    requiredFields: "Wypełnij wszystkie wymagane pola",
    noVerbosePermission:
      "Nie masz uprawnień do korzystania z trybu szczegółowego (verbose)",
  },
  auth: {
    authFailed: "Uwierzytelnianie nie powiodło się",
    invalidCredentials: "Nieprawidłowe dane logowania",
    tooManyFailures:
      "Zbyt wiele nieudanych logowań: spróbuj ponownie za {minutes} min",
    passwordChangeRequired:
      "Najpierw zmień hasło: to publicznie znane hasło domyślne",
    disclaimerRequired: "Najpierw zaakceptuj zastrzeżenie",
    disclaimerAccepted: "Zastrzeżenie zostało zaakceptowane",
    loginDisabled:
      "Brak uwierzytelnienia, logowanie nie jest włączone dla tego użytkownika.",
    signInBlocked:
      "Brak uwierzytelnienia, administrator zablokował logowanie tego użytkownika.",
    entraFailed: "Uwierzytelnianie Azure AD nie powiodło się",
    oidcFailed: "Uwierzytelnianie OIDC nie powiodło się",
  },
  success: {
    created: "Utworzono: {resource}",
    updated: "Zaktualizowano: {resource}",
    deleted: "Usunięto: {resource}",
    connectionOk: "{resource}: połączenie działa poprawnie",
  },
  audit: {
    failedGet: "Nie udało się pobrać dziennika audytu",
  },
  health: {
    failedCheck: "Nie udało się sprawdzić stanu systemu",
  },
  config: {
    failedGetFormsList: "Nie udało się pobrać listy formularzy",
    formNameNotProvided: "Nie podano nazwy formularza",
    failedGetFormConfig: "Nie udało się pobrać konfiguracji formularza",
    onlyAdminsOrDesigners:
      "Tylko administratorzy i projektanci mają dostęp do pełnej konfiguracji formularzy",
    failedGetFormsConfig: "Nie udało się pobrać konfiguracji formularzy",
    failedGetBackups: "Nie udało się pobrać kopii zapasowych",
    failedGetEnvVars: "Nie udało się pobrać zmiennych środowiskowych",
    failedSaveEnvVars: "Nie udało się zapisać ustawień środowiska",
    failedVaultCheck: "Test połączenia z Vault nie powiódł się",
    failedVaultMounts: "Nie udało się wyświetlić punktów montowania Vault",
    noEnvVarsGiven: "Nie podano żadnych zmiennych środowiskowych",
    envVarsSaved: "Zapisano ustawienia środowiska",
    envVarsNotFound:
      "Nie znaleziono sekcji zmiennych środowiskowych w help.yaml",
    failedRestoreForms: "Nie udało się przywrócić formularzy",
    failedRestoreNoName:
      "Nie udało się przywrócić, nie podano nazwy kopii zapasowej",
    failedRestoreBackup: "Nie udało się przywrócić '{name}'",
    designerLocked: "Projektant jest zablokowany",
    designerLockedBy:
      "Projektant jest zablokowany przez użytkownika {username}",
    failedSaveForms: "Nie udało się zapisać formularzy",
    failedValidateForms:
      "Nie udało się zweryfikować nowej konfiguracji formularzy",
    failedGetLock: "Nie udało się pobrać blokady",
  },
  resources: {
    storedJobNameInUse:
      "Masz już zapisane zadanie o nazwie '{name}': wybierz inną nazwę",
    cantTouchDirectoryAdmin:
      "Tylko admin może zablokować, wylogować, zapomnieć lub unieważnić tokeny użytkownika z rolą admin",
    credentialNotFound:
      "Brak poświadczenia o nazwie '{name}'",
    repositoryCredentialType:
      "Repozytorium loguje się użytkownikiem i hasłem: poświadczenie '{name}' nie ma obu",
    credentialSignInAdminOnly:
      "Tylko admin może dodać, zmienić lub usunąć poświadczenie używane przez logowanie (LDAP, Microsoft Entra ID lub OIDC)",
    credentialNotAllowed:
      "Tylko admin może użyć tutaj poświadczenia '{name}': używa go runner, połączenie lub logowanie",
    storedKeyOtherProvider:
      "Zapisany klucz jest wysyłany tylko do zapisanego dostawcy i bazowego URL: wpisz klucz, aby sprawdzić innego",
    backupCreated: "Utworzono kopię zapasową",
    lockAdded: "Dodano blokadę",
    lockDeleted: "Usunięto blokadę",
    scheduleAdded: "Dodano harmonogram",
    scheduleQueued: "Harmonogram dodany do kolejki",
    scheduleLaunched: "Uruchomiono harmonogram",
    storedJobAdded: "Dodano zapisane zadanie",
    storedJobUpdated: "Zaktualizowano zapisane zadanie",
    storedJobDeleted: "Usunięto zapisane zadanie",
    storedJobNoAccess: "Nie masz dostępu do tego zapisanego zadania",
    storedJobVisibilityInvalid: "Zapisane zadanie jest prywatne lub udostępnione",
    storedJobShareDenied: "Nie masz uprawnień do udostępniania zapisanych zadań",
    storedJobShareFormDisabled: "Formularz '{form}' nie pozwala udostępniać swoich zapisanych zadań",
    oauth2Added: "Dodano dostawcę OAuth2",
    runnerAdded: "Dodano runner",
    joinTokenMade: "Utworzono token dołączenia: skopiuj go teraz, nie zostanie pokazany ponownie",
    joinTokenRevoked: "Token dołączenia unieważniony",
    joinTokenDeleted: "Token dołączenia usunięty",
    joinTokenNotFound: "Nie znaleziono tokenu dołączenia",
    runnerNotFound: "Nie znaleziono runnera",
    runnerAdminOnly:
      "Tylko admin może dodać, zmienić lub usunąć runner: runner otrzymuje poświadczenia zadań, które uruchamia",
    repositoryAdminOnly:
      "Tylko admin może dodać lub usunąć repozytorium albo zmienić jego adres, gałąź lub przeznaczenie: jego zawartość staje się konfiguracją, formularzami lub playbookami, które uruchamia AnsibleForms",
    secretStoreAdminOnly:
      "Tylko admin może dodać, zmienić lub usunąć magazyn sekretów: loguje się tokenem lub kluczem, który zostałby wysłany na jego adres",
    credentialSecretRefAdminOnly:
      "Tylko admin może wybrać lub zmienić magazyn sekretów i sekret, z którego poświadczenie odczytuje hasło",
    credentialAdminOnly:
      "Tylko admin może dodać, zmienić lub usunąć to poświadczenie: runner lub połączenie bierze z niego swój adres i sekret",
    credentialInUse:
      "Poświadczenie '{name}' jest używane przez {count} rekord(y), wymienione na karcie Używane przez: najpierw je zmień",
    defaultPasswordRefused: "Wybierz inne hasło niż publiczne hasło domyślne",
    passwordTooShort: "Hasło musi mieć co najmniej {min} znaków",
    passwordIsUsername: "Hasło nie może być nazwą użytkownika",
    runnerConnectionOk: "Połączenie z runnerem działa poprawnie",
    runnerConnectionOkDetails: "Połączenie z runnerem działa poprawnie: {details}",
    runnerRteRelease: "RTE {version}",
    runnerAnsibleCore: "Ansible core {version}",
    runnerAnsible: "Ansible {version}",
    runnerOnNode: "na węźle {node}",
    runnerDetailsSeparator: ", ",
    secretStoreAdded: "Dodano magazyn sekretów",
    secretStoreNotFound: "Nie znaleziono magazynu sekretów",
    secretStoreConnectionOk: "Połączenie z magazynem sekretów działa poprawnie",
    userNotFound: "Nie znaleziono użytkownika",
    currentPasswordRequired: "Aby ustawić nowe hasło, podaj obecne hasło",
    currentPasswordWrong: "Obecne hasło jest nieprawidłowe",
    cantChangePasswordLdap: "Nie można zmienić hasła użytkownika LDAP",
    directoryTypeUnknown:
      "To nie jest użytkownik ani grupa LDAP, Microsoft Entra ID lub OIDC",
    directoryUserKept:
      "Administrator zablokował tego użytkownika: zezwól na logowanie, zanim go zapomnisz",
    failedDirectoryUser:
      "Nie udało się odczytać ani zmienić użytkownika LDAP lub SSO",
    cantBlockAdmin: "Użytkownika admin nie można zablokować: to droga powrotu",
    cantBlockYourself: "Nie możesz zablokować własnego logowania",
    groupNotFound: "Nie znaleziono takiej grupy",
    groupHasUsers: "Nieznana grupa lub grupa ma użytkowników",
    failedFindGroup: "Nie udało się znaleźć grupy",
    failedCreateGroup: "Nie udało się utworzyć grupy",
    failedUpdateGroup: "Nie udało się zaktualizować grupy",
    failedDeleteGroup: "Nie udało się usunąć grupy",
    failedFindRepositories: "Nie udało się znaleźć repozytoriów",
    failedFindRepository: "Nie udało się znaleźć repozytorium",
    failedCreateRepository: "Nie udało się utworzyć repozytorium",
    failedUpdateRepository: "Nie udało się zaktualizować repozytorium",
    failedDeleteRepository: "Nie udało się usunąć repozytorium",
    failedCloneRepository: "Nie udało się sklonować repozytorium",
    failedResetRepository: "Nie udało się zresetować repozytorium",
    failedPullRepository: "Nie udało się pobrać zmian repozytorium (pull)",
    failedSyncRepository: "Nie udało się wypchnąć repozytorium",
    noFormsRepositories: "Nie skonfigurowano repozytoriów formularzy",
    failedApplyConfigSeed: "Nie udało się zastosować config seed",
    noConfigSeed:
      "Nie skonfigurowano config seed (CONFIG_SEED_PATH jest pusty)",
    failedFindSsh: "Nie udało się znaleźć klucza SSH",
    failedUpdateSsh: "Nie udało się zaktualizować klucza SSH",
    failedFindChatSettings: "Nie udało się znaleźć ustawień czatu",
    failedUpdateChatSettings: "Nie udało się zaktualizować ustawień czatu",
    seedManagedChatSettings:
      "Ustawieniami czatu zarządza config seed, są tylko do odczytu",
    chatSettingsUpdated: "Zaktualizowano ustawienia czatu",
    chatCheckFailed: "Sprawdzenie dostawcy czatu nie powiodło się",
    failedFindLdap: "Nie udało się znaleźć LDAP",
    ldapCheckFailed: "Sprawdzenie LDAP nie powiodło się",
    storedPasswordOtherServer:
      "Zapisane hasło jest używane tylko dla zapisanego serwera: wpisz hasło, aby sprawdzić inny",
    ldapUpdated: "Zaktualizowano LDAP",
    failedUpdateLdap: "Nie udało się zaktualizować LDAP",
    ldapCreated: "Dodano katalog LDAP",
    failedCreateLdap: "Nie udało się dodać katalogu LDAP",
    ldapDeleted: "Usunięto katalog LDAP",
    ldapNotFound: "Nie znaleziono katalogu LDAP",
    failedDeleteLdap: "Nie udało się usunąć katalogu LDAP",
    seedManagedSettings:
      "Ustawieniami zarządza config seed, są tylko do odczytu",
    seedManagedLdap:
      "Konfiguracją LDAP zarządza config seed, jest tylko do odczytu",
    failedFindSettings: "Nie udało się znaleźć ustawień",
    mailCheckFailed: "Sprawdzenie poczty nie powiodło się",
    mailSent: "Wysłano wiadomość o identyfikatorze {id}",
    syslogSent: "Wysłano komunikat syslog do {where}",
    syslogCheckFailed: "Wysłanie komunikatu syslog nie powiodło się",
    failedUpdateSettings: "Nie udało się zaktualizować ustawień",
    configLockedByDesigner:
      "Konfiguracja jest zablokowana przez aktywną sesję projektanta{username}",
    configChangedElsewhere:
      "Konfiguracja została zmieniona w innym miejscu, przeładuj przed zapisaniem",
    failedImportConfig: "Nie udało się zaimportować konfiguracji",
    failedExportConfig: "Nie udało się wyeksportować konfiguracji",
    failedLegacyCheck: "Nie udało się sprawdzić starszego pliku forms.yaml",
    failedConvertLegacy: "Nie udało się przekonwertować pliku forms.yaml",
    dbTypeNotSet: "Nie ustawiono typu bazy danych",
    logNotFound: "Nie znaleziono pliku dziennika",
    failedGetLog: "Nie udało się pobrać dziennika",
    failedLoadHelp: "Nie udało się wczytać pomocy",
    fileUploadFailed: "Przesyłanie pliku nie powiodło się",
    failedFindLogo: "Nie udało się pobrać logo",
    failedUpdateLogo: "Nie udało się zaktualizować logo",
    logoNoFile: "Nie przesłano żadnego pliku",
    logoInvalidImage:
      "Nieprawidłowy lub nieobsługiwany obraz, dozwolone typy to png, jpeg, webp, gif i svg",
    failedFindFavicon: "Nie udało się pobrać ikony witryny",
    failedUpdateFavicon: "Nie udało się zaktualizować ikony witryny",
    faviconInvalidImage:
      "Nieprawidłowy lub nieobsługiwany obraz, dozwolone typy to png, ico, svg, webp, gif i jpeg",
    hostValueRequired: "Wymagana wartość hosta",
    hostNameRequired:
      'Wymagana nazwa hosta (parametr zapytania "name" lub "host")',
  },
  jobs: {
    cantApproveOwnJob:
      "Nie możesz zatwierdzić własnego zadania: musi je zatwierdzić inny zatwierdzający",
    mustProvideJobId: "Musisz podać jobid",
    abortRequested: "Zażądano przerwania zadania",
    failedAbort: "Nie udało się przerwać zadania",
    failedRetrieve: "Nie udało się pobrać zadania",
    failedRetrieveJobs: "Nie udało się pobrać zadań",
    failedRetrieveApprovals:
      "Nie udało się pobrać zadań oczekujących na zatwierdzenie",
    failedDelete: "Nie udało się usunąć zadania",
    deleted: "Usunięto zadanie",
    failedLaunch: "Nie udało się uruchomić formularza",
    invalidFormData: "Dane formularza są nieprawidłowe",
    invalidEventOrder:
      "Kolejność zdarzenia to liczba całkowita od 0: '{order}' nią nie jest",
    failedRelaunch: "Nie udało się ponownie uruchomić zadania",
    failedApprove: "Nie udało się zatwierdzić zadania",
    failedReject: "Nie udało się odrzucić zadania",
    approved: "Zadanie {id} zostało zatwierdzone",
    rejected: "Zadanie {id} zostało odrzucone",
    relaunched: "Zadanie zostało ponownie uruchomione z identyfikatorem {id}",
    failedRetrieveRawData: "Nie udało się pobrać surowych danych formularza",
  },
  email: {
    approval: {
      heading: "Prośba o zatwierdzenie",
      subtitle: "Prośba o zatwierdzenie oczekuje na Twoją decyzję",
      button: "Przejrzyj prośbę o zatwierdzenie",
      regards: "Pozdrawiamy,<br>AnsibleForms",
    },
    jobstatus: {
      heading: "Aktualizacja stanu zadania",
      subtitle: "Poniższe informacje przesyłamy do wiadomości",
      button: "Stan zadania",
      runDetails: "Szczegóły uruchomienia:",
      regards: "Pozdrawiamy,<br>AnsibleForms",
    },
    jobevent: {
      button: "Pokaż zadanie",
      regards: "Pozdrawiamy,<br>AnsibleForms",
      // without a user, and with the user who did it : a whole sentence
      // each, so every language puts the name where its word order needs it
      launch: "Zadanie zostało uruchomione.",
      relaunch: "Zadanie zostało ponownie uruchomione.",
      delete: "Zadanie zostało usunięte.",
      approve: "Zadanie zostało zatwierdzone i będzie kontynuowane.",
      reject: "Zadanie zostało odrzucone.",
      launchBy: "Zadanie zostało uruchomione przez {user}.",
      relaunchBy: "Zadanie zostało ponownie uruchomione przez {user}.",
      deleteBy: "Zadanie zostało usunięte przez {user}.",
      approveBy:
        "Zadanie zostało zatwierdzone przez {user} i będzie kontynuowane.",
      rejectBy: "Zadanie zostało odrzucone przez {user}.",
    },
    // the subjects : "AnsibleForms '<form>' [<type>] (<id>) - <one of these>", and the
    // approval one when the form gives no title
    subject: {
      approval: "AnsibleForms - prośba o zatwierdzenie",
      event: {
        launch: "Uruchomione",
        relaunch: "Uruchomione ponownie",
        delete: "Usunięte",
        approve: "Zatwierdzone",
        reject: "Odrzucone",
      },
      status: {
        success: "Zakończone powodzeniem",
        failed: "Nieudane",
        aborted: "Przerwane",
        rejected: "Odrzucone",
        abandoned: "Porzucone",
        warning: "Ostrzeżenie",
      },
    },
    // the test mail of the mail settings
    test: {
      subject: "Wiadomość testowa",
      body: "<p>To jest wiadomość testowa z AnsibleForms</p>",
    },
  },
  // what a notification channel (Connections > Notifications) says : a test, a job's end
  notifications: {
    testText: "Powiadomienie testowe od {who}: kanał '{name}' je otrzymuje.",
    testSent: "Powiadomienie testowe wysłane do {name}",
    testFailed: "Powiadomienie testowe nie powiodło się",
    statusText: "Zadanie {jobid} formularza '{form}' zakończyło się: {status}.",
    openJob: "Otwórz zadanie",
  },
};
