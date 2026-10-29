export default {
  errors: {
    databaseError:
      "Se ha producido un error de la base de datos: el registro del servidor tiene los detalles",
    duplicateRecord: "Ya existe un registro con este nombre",
    valueTooLong: "Un valor es demasiado largo para su campo",
    noAccess: "Sin acceso",
    notAdmin: "No eres administrador",
    noSettingsAccess: "No tienes acceso a la configuración",
    noDesignerAccess: "No tienes acceso al diseñador",
    noFormDesignAccess: "No puede editar los formularios en el diseñador",
    noPlaybookDesignAccess: "No puede editar los playbooks en el diseñador",
    noWorkflowDesignAccess: "No puede editar los flujos de trabajo en el diseñador",
    noInventoryDesignAccess: "No puede editar los inventarios en el diseñador",
    noVarsFileDesignAccess: "No puede editar los archivos de variables en el diseñador",
    noLogsAccess: "No tienes acceso a los registros",
    noFileUploadAccess: "Su rol no permite subir archivos",
    noAuditAccess: "No tienes acceso al registro de auditoría",
    noDatabaseAccess: "No tienes acceso a las operaciones de base de datos",
    noScheduleAccess: "No tienes permiso para gestionar trabajos programados",
    noChatAccess: "No tiene permiso para usar el asistente de chat",
    noMcpAccess: "No tiene permiso para usar el servidor MCP",
    noStoredJobsAccess: "No tienes permiso para gestionar trabajos almacenados",
    noDataSent: "No se enviaron datos",
    missingDbConfig: "Falta la configuración de la base de datos",
    provideRefreshToken: "Por favor, proporciona un token de actualización",
    invalidRefreshToken: "Token de actualización no válido",
    refreshTokenExpired: "El token de actualización ha caducado",
    refreshTokenUnknown: "Token de actualización desconocido",
    refreshTokenReplaced: "El token de actualización ya lo ha usado otra renovación simultánea",
    apiTokenFromApiToken: "Un token de API no puede crear otro token de API",
    apiTokenNotAllowed: "Tu rol no permite tokens de API",
    apiTokenSignInAgain: "Vuelve a iniciar sesión para crear un token de API: tu último inicio de sesión es demasiado antiguo",
    apiTokenLifetime: "La duración debe ser un número de días, como máximo {max}",
    apiTokenFailed: "No se pudo crear el token de API",
    apiTokensFailed: "No se pudieron leer o cambiar los tokens de API",
    apiTokenNotFound: "No existe ese token de API",
    requiredFields: "Por favor, proporciona todos los campos obligatorios",
    noVerbosePermission: "No tienes permiso para usar el modo detallado",
  },
  auth: {
    authFailed: "Autenticación fallida",
    invalidCredentials: "Credenciales no válidas",
    tooManyFailures:
      "Demasiados inicios de sesión fallidos: inténtelo de nuevo en {minutes} minuto(s)",
    passwordChangeRequired:
      "Cambie primero su contraseña: es la contraseña predeterminada pública",
    disclaimerRequired: "Acepta primero el aviso legal",
    disclaimerAccepted: "El aviso legal está aceptado",
    loginDisabled:
      "No autenticado, el inicio de sesión no está habilitado para este usuario.",
    signInBlocked:
      "No autenticado, un administrador bloqueó el inicio de sesión de este usuario.",
    entraFailed: "La autenticación con Azure AD ha fallado",
    oidcFailed: "La autenticación con OIDC ha fallado",
  },
  success: {
    created: "{resource} creado",
    updated: "{resource} actualizado",
    deleted: "{resource} eliminado",
    connectionOk: "Conexión {resource} correcta",
  },
  audit: {
    failedGet: "No se pudo obtener el registro de auditoría",
  },
  health: {
    failedCheck: "No se pudo comprobar el estado del sistema",
  },
  config: {
    failedGetFormsList: "Error al obtener la lista de formularios",
    formNameNotProvided: "Nombre del formulario no proporcionado",
    failedGetFormConfig: "Error al obtener la configuración del formulario",
    onlyAdminsOrDesigners:
      "Solo administradores o diseñadores pueden acceder a la configuración completa de los formularios",
    failedGetFormsConfig:
      "Error al obtener la configuración de los formularios",
    failedGetBackups: "Error al obtener las copias de seguridad",
    failedGetEnvVars: "Error al obtener las variables de entorno",
    failedSaveEnvVars: "No se pudieron guardar los ajustes de entorno",
    failedVaultCheck: "La prueba de conexión con Vault falló",
    failedVaultMounts: "No se pudieron listar los montajes de Vault",
    noEnvVarsGiven: "No se proporcionaron variables de entorno",
    envVarsSaved: "Ajustes de entorno guardados",
    envVarsNotFound:
      "Sección de Variables de Entorno no encontrada en help.yaml",
    failedRestoreForms: "Error al restaurar los formularios",
    failedRestoreNoName:
      "Error al restaurar, no se proporcionó nombre de copia",
    failedRestoreBackup: "Error al restaurar '{name}'",
    designerLocked: "El diseñador está bloqueado",
    designerLockedBy: "El diseñador está bloqueado por {username}",
    failedSaveForms: "Error al guardar los formularios",
    failedValidateForms:
      "Error al validar la nueva configuración de los formularios",
    failedGetLock: "Error al obtener el bloqueo",
  },
  resources: {
    storedJobNameInUse:
      "Ya tienes un trabajo guardado llamado '{name}': elige otro nombre",
    cantTouchDirectoryAdmin:
      "Solo un admin puede bloquear, cerrar la sesión, olvidar o revocar los tokens de un usuario con el rol admin",
    credentialNotFound:
      "No hay ninguna credencial llamada '{name}'",
    repositoryCredentialType:
      "Un repositorio inicia sesión con un usuario y una contraseña: la credencial '{name}' no tiene ambos",
    credentialSignInAdminOnly:
      "Solo un admin puede añadir, cambiar o eliminar una credencial que usa un inicio de sesión (LDAP, Microsoft Entra ID u OIDC)",
    credentialNotAllowed:
      "Solo un admin puede usar aquí la credencial '{name}': la usa un runner, una conexión o un inicio de sesión",
    storedKeyOtherProvider:
      "La clave guardada solo se envía al proveedor y a la URL base guardados: escribe la clave para comprobar otro",
    backupCreated: "Copia de seguridad creada",
    lockAdded: "Bloqueo añadido",
    lockDeleted: "Bloqueo eliminado",
    scheduleAdded: "Programación añadida",
    scheduleQueued: "Programación en cola",
    scheduleLaunched: "Programación lanzada",
    storedJobAdded: "Trabajo almacenado añadido",
    storedJobUpdated: "Trabajo almacenado actualizado",
    storedJobDeleted: "Trabajo almacenado eliminado",
    storedJobNoAccess: "No tienes acceso a este trabajo almacenado",
    storedJobVisibilityInvalid: "Un trabajo almacenado es privado o compartido",
    storedJobShareDenied: "No tienes permiso para compartir trabajos almacenados",
    storedJobShareFormDisabled: "El formulario '{form}' no permite compartir sus trabajos almacenados",
    oauth2Added: "Proveedor OAuth2 añadido",
    secretStoreAdded: "Almacén de secretos añadido",
    secretStoreNotFound: "Almacén de secretos no encontrado",
    secretStoreConnectionOk:
      "La conexión con el almacén de secretos es correcta",
    runnerAdded: "Runner añadido",
    joinTokenMade: "Token de unión creado: cópialo ahora, no se volverá a mostrar",
    joinTokenRevoked: "Token de unión revocado",
    joinTokenDeleted: "Token de unión eliminado",
    joinTokenNotFound: "No se encontró el token de unión",
    runnerNotFound: "Runner no encontrado",
    runnerAdminOnly:
      "Solo un admin puede añadir, cambiar o eliminar un runner: un runner recibe las credenciales de los trabajos que ejecuta",
    repositoryAdminOnly:
      "Solo un admin puede añadir o eliminar un repositorio, o cambiar su dirección, su rama o para qué se usa: su contenido se convierte en la configuración, los formularios o los playbooks que ejecuta AnsibleForms",
    secretStoreAdminOnly:
      "Solo un admin puede añadir, cambiar o eliminar un almacén de secretos: inicia sesión con un token o una clave que se enviaría a su dirección",
    credentialSecretRefAdminOnly:
      "Solo un admin puede elegir o cambiar el almacén de secretos y el secreto del que una credencial lee su contraseña",
    credentialAdminOnly:
      "Solo un admin puede añadir, cambiar o eliminar esta credencial: un runner o una conexión toma de ella su dirección y su secreto",
    credentialInUse:
      "La credencial '{name}' está en uso por {count} registro(s), listados en su pestaña Usada por: cámbielos primero",
    defaultPasswordRefused:
      "Elija otra contraseña distinta de la predeterminada pública",
    passwordTooShort: "La contraseña necesita al menos {min} caracteres",
    passwordIsUsername: "La contraseña no puede ser el nombre de usuario",
    runnerConnectionOk: "La conexión con el runner es correcta",
    runnerConnectionOkDetails: "La conexión con el runner es correcta: {details}",
    runnerRteRelease: "RTE {version}",
    runnerAnsibleCore: "Ansible core {version}",
    runnerAnsible: "Ansible {version}",
    runnerOnNode: "en el nodo {node}",
    runnerDetailsSeparator: ", ",
    userNotFound: "Usuario no encontrado",
    currentPasswordRequired:
      "Se requiere su contraseña actual para establecer una nueva",
    currentPasswordWrong: "La contraseña actual no es correcta",
    cantChangePasswordLdap:
      "No puedes cambiar la contraseña de un usuario LDAP",
    directoryTypeUnknown: "No es un usuario o grupo LDAP, Microsoft Entra ID u OIDC",
    directoryUserKept:
      "Un administrador bloqueó este usuario: permite su inicio de sesión antes de olvidarlo",
    failedDirectoryUser: "No se pudo leer o cambiar el usuario LDAP o SSO",
    cantBlockAdmin:
      "El usuario admin no se puede bloquear: es la forma de volver a entrar",
    cantBlockYourself: "No puedes bloquear tu propio inicio de sesión",
    groupNotFound: "Grupo no encontrado",
    groupHasUsers: "Grupo desconocido o el grupo contiene usuarios",
    failedFindGroup: "Error al buscar el grupo",
    failedCreateGroup: "Error al crear el grupo",
    failedUpdateGroup: "Error al actualizar el grupo",
    failedDeleteGroup: "Error al eliminar el grupo",
    failedFindRepositories: "Error al buscar los repositorios",
    failedFindRepository: "Error al buscar el repositorio",
    failedCreateRepository: "Error al crear el repositorio",
    failedUpdateRepository: "Error al actualizar el repositorio",
    failedDeleteRepository: "Error al eliminar el repositorio",
    failedCloneRepository: "Error al clonar el repositorio",
    failedResetRepository: "Error al restablecer el repositorio",
    failedPullRepository: "Error al actualizar el repositorio",
    failedSyncRepository: "No se pudo hacer push del repositorio",
    noFormsRepositories: "No hay repositorios de formularios configurados",
    failedApplyConfigSeed: "Error al aplicar el seed de configuracion",
    noConfigSeed:
      "No hay ningun seed de configuracion configurado (CONFIG_SEED_PATH esta vacio)",
    failedFindSsh: "Error al buscar la clave SSH",
    failedUpdateSsh: "Error al actualizar la clave SSH",
    failedFindChatSettings: "No se encontraron los ajustes del chat",
    failedUpdateChatSettings: "No se pudieron actualizar los ajustes del chat",
    seedManagedChatSettings:
      "Los ajustes del chat los gestiona el config seed y son de solo lectura",
    chatSettingsUpdated: "Ajustes del chat actualizados",
    chatCheckFailed: "La comprobación del proveedor de chat ha fallado",
    failedFindLdap: "Error al buscar LDAP",
    ldapCheckFailed: "La verificación de LDAP ha fallado",
    storedPasswordOtherServer:
      "La contraseña guardada solo se usa con el servidor guardado: escriba la contraseña para comprobar otro",
    ldapUpdated: "LDAP actualizado",
    failedUpdateLdap: "Error al actualizar LDAP",
    ldapCreated: "Directorio LDAP añadido",
    failedCreateLdap: "No se pudo añadir el directorio LDAP",
    ldapDeleted: "Directorio LDAP eliminado",
    ldapNotFound: "Directorio LDAP no encontrado",
    failedDeleteLdap: "No se pudo eliminar el directorio LDAP",
    seedManagedSettings:
      "Los ajustes están gestionados por el seed de configuración y son de solo lectura",
    seedManagedLdap:
      "La configuración LDAP está gestionada por el seed de configuración y es de solo lectura",
    failedFindSettings: "Error al buscar la configuración",
    mailCheckFailed: "La verificación del correo ha fallado",
    mailSent: "Correo enviado con id {id}",
    syslogSent: "Mensaje de syslog enviado a {where}",
    syslogCheckFailed: "El envío del mensaje de syslog ha fallado",
    failedUpdateSettings: "Error al actualizar la configuración",
    configLockedByDesigner:
      "La configuración está bloqueada por una sesión de diseñador activa{username}",
    configChangedElsewhere:
      "La configuración fue modificada en otro lugar, recargue antes de guardar",
    failedImportConfig: "Error al importar la configuración",
    failedExportConfig: "Error al exportar la configuración",
    failedLegacyCheck: "Error al comprobar forms.yaml heredado",
    failedConvertLegacy: "Error al convertir forms.yaml",
    dbTypeNotSet: "Tipo de base de datos no establecido",
    logNotFound: "Archivo de registro no encontrado",
    failedGetLog: "Error al obtener el registro",
    failedLoadHelp: "Error al cargar la ayuda",
    fileUploadFailed: "Error al subir el archivo",
    failedFindLogo: "Error al obtener el logo",
    failedUpdateLogo: "Error al actualizar el logo",
    logoNoFile: "No se subió ningún archivo",
    logoInvalidImage:
      "Imagen no válida o no soportada, los tipos permitidos son png, jpeg, webp, gif y svg",
    failedFindFavicon: "No se pudo obtener el icono del sitio",
    failedUpdateFavicon: "No se pudo actualizar el icono del sitio",
    faviconInvalidImage:
      "Imagen no válida o no compatible, los tipos permitidos son png, ico, svg, webp, gif y jpeg",
    hostValueRequired: "Se requiere el valor del host",
    hostNameRequired:
      'Se requiere el nombre del host (parámetro "name" o "host")',
  },
  jobs: {
    cantApproveOwnJob:
      "No puedes aprobar tu propio trabajo: otro aprobador debe aprobarlo",
    mustProvideJobId: "Debes proporcionar un jobid",
    abortRequested: "Se ha solicitado abortar el trabajo",
    failedAbort: "Error al abortar el trabajo",
    failedRetrieve: "Error al recuperar el trabajo",
    failedRetrieveJobs: "Error al recuperar los trabajos",
    failedRetrieveApprovals: "Error al recuperar los trabajos de aprobación",
    failedDelete: "Error al eliminar el trabajo",
    deleted: "Trabajo eliminado",
    failedLaunch: "Error al lanzar el formulario",
    invalidFormData: "Los datos del formulario no son válidos",
    invalidEventOrder:
      "El orden de un evento es un número entero desde 0: '{order}' no lo es",
    failedRelaunch: "Error al relanzar el trabajo",
    failedApprove: "Error al aprobar el trabajo",
    failedReject: "Error al rechazar el trabajo",
    approved: "El trabajo {id} ha sido aprobado",
    rejected: "El trabajo {id} ha sido rechazado",
    relaunched: "El trabajo ha sido relanzado con el id {id}",
    failedRetrieveRawData:
      "Error al recuperar los datos sin procesar del formulario",
  },
  email: {
    approval: {
      heading: "Solicitud de Aprobación",
      subtitle: "Hay una solicitud de aprobación esperando tu acción",
      button: "Revisar Solicitud de Aprobación",
      regards: "Saludos,<br>AnsibleForms",
    },
    jobstatus: {
      heading: "Actualización del Estado del Trabajo",
      subtitle: "Lo siguiente es para tu información",
      button: "Estado del trabajo",
      runDetails: "Detalles de la ejecución :",
      regards: "Saludos,<br>AnsibleForms",
    },
    jobevent: {
      button: "Ver Trabajo",
      regards: "Saludos,<br>AnsibleForms",
      // without a user, and with the user who did it : a whole sentence
      // each, so every language puts the name where its word order needs it
      launch: "El trabajo ha sido lanzado.",
      relaunch: "El trabajo ha sido relanzado.",
      delete: "El trabajo ha sido eliminado.",
      approve: "El trabajo ha sido aprobado y continuará la ejecución.",
      reject: "El trabajo ha sido rechazado.",
      launchBy: "El trabajo ha sido lanzado por {user}.",
      relaunchBy: "El trabajo ha sido relanzado por {user}.",
      deleteBy: "El trabajo ha sido eliminado por {user}.",
      approveBy:
        "El trabajo ha sido aprobado por {user} y continuará la ejecución.",
      rejectBy: "El trabajo ha sido rechazado por {user}.",
    },
    // the subjects : "AnsibleForms '<form>' [<type>] (<id>) - <one of these>", and the
    // approval one when the form gives no title
    subject: {
      approval: "Solicitud de aprobación de AnsibleForms",
      event: {
        launch: "Lanzado",
        relaunch: "Relanzado",
        delete: "Eliminado",
        approve: "Aprobado",
        reject: "Rechazado",
      },
      status: {
        success: "Correcto",
        failed: "Fallido",
        aborted: "Abortado",
        rejected: "Rechazado",
        abandoned: "Abandonado",
        warning: "Advertencia",
      },
    },
    // the test mail of the mail settings
    test: {
      subject: "Mensaje de prueba",
      body: "<p>Este es un mensaje de prueba de AnsibleForms</p>",
    },
  },
  // what a notification channel (Connections > Notifications) says : a test, a job's end
  notifications: {
    testText: "Una notificación de prueba de {who}: el canal '{name}' la recibe.",
    testSent: "Notificación de prueba enviada a {name}",
    testFailed: "La notificación de prueba falló",
    statusText: "El trabajo {jobid} del formulario '{form}' terminó: {status}.",
    openJob: "Abrir el trabajo",
  },
};
