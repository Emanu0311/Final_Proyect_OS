/**
 * @file SecurityController.js
 * @description Servidor de Administración de Seguridad en espacio de usuario (Módulo 2.5):
 *  - Autenticación y Perfiles: ROOT (Admin), STANDARD (Usuario Estándar), GUEST (Invitado)
 *  - Matriz de Control de Acceso (ACL): Verificación estricta de permisos de procesos, memoria y archivos (rwx)
 *  - Auditoría de Seguridad: Registro inmutable (SecurityAuditLog) de eventos y violaciones
 */

import { SERVER_ENDPOINTS, SYSCALL_ACTIONS } from '../core/IPCMessage.js';

/**
 * Cuenta de usuario del simulador (catálogo de identidades del Módulo 2.5).
 * La contraseña se guarda en texto plano únicamente porque es una simulación
 * académica; en un sistema real se almacenaría sólo un hash SHA-256.
 */
export class UserAccount {
  /**
   * @param {Object} params
   * @param {string} params.userId - Identificador estable de la cuenta (usr-root, usr-std, usr-guest).
   * @param {number} params.uid - UID POSIX simulado (0, 1000, 2000).
   * @param {string} params.username - Nombre usado en SYS_AUTH_LOGIN y en la terminal CLI.
   * @param {'ROOT'|'STANDARD'|'GUEST'} params.role - Dominio de seguridad asignado por la ACL.
   * @param {string} params.password - Credencial de la simulación.
   * @param {string} params.homeDir - Directorio hogar dentro del FS simulado.
   * @param {number} params.memoryQuotaKB - Cuota máxima de RAM por proceso del perfil.
   */
  constructor({ userId, uid, username, role, password, homeDir, memoryQuotaKB }) {
    this.userId = userId;
    this.uid = uid;
    this.username = username;
    this.role = role; // 'ROOT' | 'STANDARD' | 'GUEST'
    this.password = password;
    this.homeDir = homeDir;
    this.memoryQuotaKB = memoryQuotaKB;
  }
}

/**
 * Entrada inmutable de la bitácora forense del Minikernel (RF-30 / RNF-11).
 * Cada registro se congela con Object.freeze y sellado con un hash FNV-1a
 * encadenado al registro anterior, de modo que cualquier mutación sea evidente.
 */
export class SecurityAuditLog {
  /**
   * @param {Object} params
   * @param {number} params.seq - Número de secuencia monótonamente creciente.
   * @param {number} params.tick - Tick del reloj maestro en que ocurrió el evento.
   * @param {string} params.eventType - Código del evento (AUTH_LOGIN_SUCCESS, ACL_RWX_VIOLATION, ...).
   * @param {'INFO'|'WARNING'|'CRITICAL'} [params.severity] - Severidad forense.
   * @param {string} params.username - Usuario actor del evento.
   * @param {string} params.role - Rol activo del actor.
   * @param {string} params.action - Syscall o acción IPC que disparó el evento.
   * @param {string} params.targetResource - Recurso protegido involucrado.
   * @param {'ALLOW'|'DENY'} params.verdict - Veredicto del Reference Monitor.
   * @param {string} params.details - Descripción legible del evento.
   * @param {string} [params.prevHash] - Hash de la entrada anterior de la cadena.
   */
  constructor({
    seq,
    tick,
    eventType,
    severity = 'INFO', // 'INFO' | 'WARNING' | 'CRITICAL'
    username,
    role,
    action,
    targetResource,
    verdict,
    details,
    prevHash = '00000000'
  }) {
    this.seq = seq;
    this.tick = tick;
    this.timestamp = new Date().toISOString();
    this.eventType = eventType;
    this.severity = severity;
    this.username = username;
    this.role = role;
    this.action = action;
    this.targetResource = targetResource;
    this.verdict = verdict; // 'ALLOW' | 'DENY'
    this.details = details;
    this.prevHash = prevHash;
    this.hash = SecurityAuditLog.computeHash(`${seq}|${tick}|${eventType}|${username}|${action}|${verdict}|${prevHash}`);
    Object.freeze(this);
  }

  /**
   * Calcula el hash FNV-1a de 32 bits usado para encadenar la bitácora.
   * @param {string} input - Datos serializados de la entrada + hash previo.
   * @returns {string} Hash en hexadecimal de 8 caracteres.
   */
  static computeHash(input) {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }
}

export class SecurityController {
  /**
   * @param {import('../core/Kernel.js').Kernel} kernel
   */
  constructor(kernel) {
    this.kernel = kernel;

    /** @type {UserAccount[]} */
    this.users = [
      new UserAccount({
        userId: 'usr-root',
        uid: 0,
        username: 'root',
        role: 'ROOT',
        password: 'root',
        homeDir: '/',
        memoryQuotaKB: 896
      }),
      new UserAccount({
        userId: 'usr-std',
        uid: 1000,
        username: 'std_user',
        role: 'STANDARD',
        password: 'user123',
        homeDir: '/home',
        memoryQuotaKB: 512
      }),
      new UserAccount({
        userId: 'usr-guest',
        uid: 2000,
        username: 'guest',
        role: 'GUEST',
        password: 'guest',
        homeDir: '/pub',
        memoryQuotaKB: 128
      })
    ];

    this.activeUser = this.users[0];

    /**
     * Compuerta de sesión para la Terminal Web del Módulo 2.5.
     * El simulador arranca con el perfil root activo para los demás módulos,
     * pero la CLI permanece bloqueada hasta un SYS_AUTH_LOGIN válido enviado
     * por el botón "Autenticar" del panel de seguridad (source SECURITY_PANEL_LOGIN).
     * @type {boolean}
     */
    this.sessionAuthenticated = false;

    // Matriz de Control de Acceso (ACL) por Rol y Dominio de Recurso
    this.aclMatrix = [
      {
        resourceDomain: 'PROCESS_EXEC_CREATE',
        description: 'Creación y ejecución de procesos de usuario (SYS_FORK)',
        ROOT: 'rwx (Total)',
        STANDARD: 'rwx (Propio, <=512KB)',
        GUEST: 'r-x (Solo lectura / <=128KB)'
      },
      {
        resourceDomain: 'PROCESS_SIGNAL_KILL',
        description: 'Terminación de procesos y cambio de planificador (SYS_KILL)',
        ROOT: 'rwx (Cualquier PID)',
        STANDARD: 'rw- (Solo procesos propios)',
        GUEST: '--- (Denegado)'
      },
      {
        resourceDomain: 'MEMORY_KERNEL_SPACE',
        description: 'Región de Memoria Reservada del Microkernel (0 - 128 KB)',
        ROOT: 'r-x (Supervisión)',
        STANDARD: '--- (TRAP_SIGSEGV)',
        GUEST: '--- (TRAP_SIGSEGV)'
      },
      {
        resourceDomain: 'FS_ROOT_AND_ETC',
        description: 'Directorios de Sistema (/etc, /bin) y Formateo FAT/Inodos',
        ROOT: 'rwx (Lectura/Escritura/Formateo)',
        STANDARD: 'r-x (Solo lectura)',
        GUEST: '--- (Acceso Denegado)'
      },
      {
        resourceDomain: 'FS_HOME_DIR',
        description: 'Directorio de Usuario (/home) - Operaciones CRUD',
        ROOT: 'rwx (Override Auditado)',
        STANDARD: 'rwx (Lectura/Escritura)',
        GUEST: 'r-- (Solo lectura)'
      },
      {
        resourceDomain: 'FS_PUB_DIR',
        description: 'Directorio Público (/pub)',
        ROOT: 'rwx (Control Total)',
        STANDARD: 'rwx (Lectura/Escritura)',
        GUEST: 'r-x (Solo lectura, sin escritura/borrado)'
      },
      {
        resourceDomain: 'IO_DISK_AND_DMA',
        description: 'Reconfiguración Geométrica de Disco y Canal DMA Directo',
        ROOT: 'rwx (Configuración + E/S)',
        STANDARD: 'rw- (Solicitudes E/S estándar)',
        GUEST: 'r-- (Solo consulta)'
      }
    ];

    /** @type {SecurityAuditLog[]} */
    this.auditLogs = [];
    this.nextLogSeq = 1;

    this.recordAudit({
      eventType: 'SYSTEM_BOOT_AUTH',
      severity: 'INFO',
      username: 'root',
      role: 'ROOT',
      action: 'KERNEL_INIT',
      targetResource: 'MINIKERNEL_CORE',
      verdict: 'ALLOW',
      details: 'Monitor de Referencia ACL y cadena de auditoría SHA/FNV inicializados.'
    });

    this.kernel.registerServer(SERVER_ENDPOINTS.SECURITY_SERVER, (msg) => this.handleIPC(msg));
    this.kernel.setSecurityGuard((msg) => this.validateIPCMessage(msg));
  }

  /**
   * Punto de entrada del servidor de seguridad en el bus IPC.
   * @param {import('../core/IPCMessage.js').IPCMessage} msg - Mensaje enrutado por el Kernel.
   * @returns {Object} Respuesta del servidor (sesión, cuenta autenticada o evento de auditoría).
   */
  handleIPC(msg) {
    const { action, payload } = msg;

    switch (action) {
      case 'GET_ACTIVE_SESSION':
        return {
          userId: this.activeUser.userId,
          uid: this.activeUser.uid,
          username: this.activeUser.username,
          role: this.activeUser.role
        };

      case SYSCALL_ACTIONS.SYS_AUTH_LOGIN:
        return this.authenticate(payload.username, payload.password, payload.source);

      case 'SEC_TERMINAL_ACCESS_DENIED':
        return this._recordTerminalAccessDenied(payload.command);

      case 'SIMULATE_SECURITY_ATTACK':
        return this.simulateSecurityAttack(payload.attackType);

      case 'SEC_REPORT_DMA_FAULT':
        return this.recordAudit({
          eventType: 'DMA_MEMORY_VIOLATION',
          severity: 'CRITICAL',
          username: this.activeUser.username,
          role: this.activeUser.role,
          action: 'IRQ_DMA_FAULT',
          targetResource: `${payload.requestId || 'DMA'} (P${payload.pid ?? '-'})`,
          verdict: 'DENY',
          details: `Transferencia DMA abortada: ${payload.reason}`
        });

      default:
        throw new Error(`Acción desconocida en SECURITY_SERVER: ${action}`);
    }
  }

  /**
   * Autentica una identidad y actualiza la sesión activa del Reference Monitor.
   * La compuerta de la terminal sólo se abre con el origen SECURITY_PANEL_LOGIN;
   * el selector rápido de la barra superior (TOP_BAR_SESSION) la cierra de nuevo.
   * @param {string} username - Usuario o rol solicitado.
   * @param {string|null} [password] - Credencial en texto plano de la simulación.
   * @param {'SECURITY_PANEL_LOGIN'|'TOP_BAR_SESSION'|'TERMINAL_SU'|'INTERNAL'} [source] - Origen de la solicitud.
   * @returns {UserAccount} Cuenta activa tras la autenticación.
   * @throws {Error} Si el usuario no existe o la credencial es inválida.
   */
  authenticate(username, password = null, source = 'INTERNAL') {
    const account = this.users.find((u) => u.username === username || u.role === username);
    if (!account) {
      this.recordAudit({
        eventType: 'AUTH_LOGIN_FAILED',
        severity: 'WARNING',
        username: String(username),
        role: 'UNKNOWN',
        action: 'SYS_AUTH_LOGIN',
        targetResource: 'SESSION_GUARD',
        verdict: 'DENY',
        details: `Intento de login con usuario inexistente: ${username}`
      });
      throw new Error(`Usuario no encontrado: ${username}`);
    }

    if (password !== null && password !== '' && account.password !== password) {
      this.recordAudit({
        eventType: 'AUTH_BAD_CREDENTIALS',
        severity: 'WARNING',
        username: account.username,
        role: account.role,
        action: 'SYS_AUTH_LOGIN',
        targetResource: 'SESSION_GUARD',
        verdict: 'DENY',
        details: `Contraseña inválida para el perfil ${account.username} (${account.role}).`
      });
      throw new Error('Credenciales de autenticación inválidas.');
    }

    this.activeUser = account;
    if (source === 'SECURITY_PANEL_LOGIN') {
      // Sólo el botón del panel 2.5 habilita la Terminal Web.
      this.sessionAuthenticated = true;
    } else if (source === 'TOP_BAR_SESSION') {
      // El selector rápido cambia el perfil, pero no otorga acceso a la CLI.
      this.sessionAuthenticated = false;
    }
    // TERMINAL_SU e INTERNAL conservan el estado: `su` sólo se alcanza con
    // la terminal ya desbloqueada y las pruebas directas no alteran la compuerta.
    this.recordAudit({
      eventType: 'AUTH_LOGIN_SUCCESS',
      severity: 'INFO',
      username: account.username,
      role: account.role,
      action: 'SYS_AUTH_LOGIN',
      targetResource: 'SESSION_GUARD',
      verdict: 'ALLOW',
      details: `Sesión activa cambiada a ${account.username} [Rol: ${account.role}, UID: ${account.uid}].`
    });

    return account;
  }

  /**
   * Consulta si la Terminal Web puede ejecutar comandos en la sesión actual.
   * @returns {boolean} true después de un login válido desde el panel 2.5.
   */
  hasActiveSession() {
    return this.sessionAuthenticated;
  }

  /**
   * Registra un intento de uso de la CLI sin autenticación previa.
   * @param {string} [command] - Comando que se intentó ejecutar.
   * @returns {SecurityAuditLog} Entrada inmutable agregada a la bitácora.
   */
  _recordTerminalAccessDenied(command) {
    const user = this.activeUser;
    return this.recordAudit({
      eventType: 'TERMINAL_ACCESS_DENIED',
      severity: 'WARNING',
      username: user.username,
      role: user.role,
      action: 'CLI_EXECUTE',
      targetResource: 'WEB_TERMINAL',
      verdict: 'DENY',
      details: `Comando "${command || '-'}" rechazado: la terminal requiere autenticación previa (SYS_AUTH_LOGIN).`
    });
  }

  /**
   * Valida cada mensaje IPC contra la Matriz de Control de Acceso (ACL) según el usuario activo.
   * @param {import('../core/IPCMessage.js').IPCMessage} msg - Mensaje en tránsito en el IPCBus.
   * @returns {{allowed: boolean, reason?: string}} Veredicto del Reference Monitor.
   */
  validateIPCMessage(msg) {
    // Mensajes internos del propio Kernel (reloj, despertares de IRQ) están pre-autorizados
    if (
      msg.sender === SERVER_ENDPOINTS.KERNEL &&
      ['IO_CLOCK_TICK', 'PROC_CLOCK_TICK', 'PROC_FINISH_CONTEXT_SWITCH', 'IPC_IO_WAKEUP'].includes(msg.action)
    ) {
      return { allowed: true };
    }

    const auth = msg.authContext || {
      userId: this.activeUser.userId,
      username: this.activeUser.username,
      role: this.activeUser.role
    };
    const role = auth.role || this.activeUser.role;
    const username = auth.username || this.activeUser.username;
    const { action, payload = {} } = msg;

    // 1. Validación de Procesos (SYS_FORK / SYS_KILL)
    if (action === SYSCALL_ACTIONS.SYS_FORK) {
      if (role === 'GUEST' && Number(payload.memorySizeKB) > 128) {
        return this._deny(
          'QUOTA_EXCEEDED_GUEST',
          'WARNING',
          username,
          role,
          action,
          `RAM ${payload.memorySizeKB} KB`,
          'Perfil GUEST excede cuota máxima de memoria por proceso (128 KB).'
        );
      }
    }

    if (action === SYSCALL_ACTIONS.SYS_KILL && msg.sender !== SERVER_ENDPOINTS.KERNEL) {
      if (role === 'GUEST') {
        return this._deny(
          'PRIVILEGE_ESCALATION_FAILED',
          'CRITICAL',
          username,
          role,
          action,
          `PID ${payload.pid}`,
          'Perfil GUEST intentó enviar señal SIGKILL a un proceso activo.'
        );
      }
    }

    // 2. Validación de Sistema de Archivos (Formateo y CRUD con permisos rwx)
    if (action === SYSCALL_ACTIONS.SYS_FORMAT_FS) {
      if (role !== 'ROOT') {
        return this._deny(
          'PRIVILEGE_ESCALATION_FAILED',
          'CRITICAL',
          username,
          role,
          action,
          'VOLUME_FS',
          `Escalamiento de privilegios fallido: Rol ${role} intentó formatear el Sistema de Archivos.`
        );
      }
    }

    if (
      [
        SYSCALL_ACTIONS.SYS_CREATE_NODE,
        SYSCALL_ACTIONS.SYS_WRITE_FILE,
        SYSCALL_ACTIONS.SYS_RENAME_NODE,
        SYSCALL_ACTIONS.SYS_DELETE_NODE
      ].includes(action)
    ) {
      const targetPath = payload.path || payload.parentPath || '/';
      if (role === 'GUEST') {
        return this._deny(
          'ACL_RWX_VIOLATION',
          'WARNING',
          username,
          role,
          action,
          targetPath,
          `Permiso rwx denegado: Perfil GUEST solo posee permisos de lectura (r-x), escritura/borrado prohibidos en ${targetPath}.`
        );
      }
      if (role === 'STANDARD' && (targetPath.startsWith('/etc') || targetPath.startsWith('/bin') || targetPath === '/')) {
        return this._deny(
          'ACL_RWX_VIOLATION',
          'CRITICAL',
          username,
          role,
          action,
          targetPath,
          `Violación ACL: Usuario STANDARD intentó modificar directorio protegido del sistema (${targetPath}).`
        );
      }
    }

    if (action === SYSCALL_ACTIONS.SYS_READ_FILE) {
      const targetPath = payload.path || '';
      if (role === 'GUEST' && targetPath.startsWith('/etc')) {
        return this._deny(
          'UNAUTHORIZED_ACCESS',
          'WARNING',
          username,
          role,
          action,
          targetPath,
          `Acceso no autorizado: Perfil GUEST intentó leer archivo confidencial ${targetPath}.`
        );
      }
    }

    // 3. Validación de Configuración de Hardware E/S
    if (action === 'SET_DISK_CONFIG' && role === 'GUEST') {
      return this._deny(
        'PRIVILEGE_ESCALATION_FAILED',
        'CRITICAL',
        username,
        role,
        action,
        'DISK_CONTROLLER',
        'Intento no autorizado de perfil GUEST para reprogramar la geometría del controlador de disco.'
      );
    }

    if (
      role === 'GUEST' &&
      (action === 'EXEC_DISK_BATCH' || (action === SYSCALL_ACTIONS.SYS_IO_DISK_REQ && msg.sender !== SERVER_ENDPOINTS.FS_SERVER))
    ) {
      return this._deny(
        'ACL_IO_VIOLATION',
        'WARNING',
        username,
        role,
        action,
        'DISK_CONTROLLER',
        'Perfil GUEST solo puede consultar el controlador de disco (r--); no puede encolar E/S directa.'
      );
    }

    return { allowed: true };
  }

  /**
   * Dispara un vector de ataque simulado y verifica la contención del Minikernel.
   * @param {'MEMORY_VIOLATION'|'PRIVILEGE_ESCALATION'|string} attackType - Tipo de amenaza.
   * @returns {{simulated: string}} Evento simulado registrado en la auditoría.
   */
  simulateSecurityAttack(attackType) {
    const user = this.activeUser;
    if (attackType === 'MEMORY_VIOLATION') {
      this.recordAudit({
        eventType: 'MEMORY_SEGMENTATION_FAULT',
        severity: 'CRITICAL',
        username: user.username,
        role: user.role,
        action: 'SYS_MEM_ACCESS',
        targetResource: '0x00000040 (Kernel Space)',
        verdict: 'DENY',
        details: `Violación de Memoria: Intento de escritura en región reservada del Microkernel (< 128 KB). Trampa TRAP_SIGSEGV disparada.`
      });
      this.kernel.raiseInterrupt({
        irqCode: 'TRAP_SIGSEGV',
        type: 'EXCEPTION',
        priority: 0,
        sourceServer: SERVER_ENDPOINTS.SECURITY_SERVER,
        targetPid: this.kernel.activePid,
        description: 'Acceso ilegal a dirección 0x00000040 (Espacio de Kernel)'
      });
      return { simulated: 'MEMORY_VIOLATION' };
    }

    if (attackType === 'PRIVILEGE_ESCALATION') {
      this.recordAudit({
        eventType: 'PRIVILEGE_ESCALATION_FAILED',
        severity: 'CRITICAL',
        username: user.username,
        role: user.role,
        action: 'SYS_SETUID_0',
        targetResource: 'PCB.uid -> 0 (ROOT)',
        verdict: 'DENY',
        details: `Intento bloqueado de escalamiento de privilegios (setuid 0) sin token criptográfico del SecurityController.`
      });
      return { simulated: 'PRIVILEGE_ESCALATION' };
    }

    this.recordAudit({
      eventType: 'UNAUTHORIZED_FS_ACCESS',
      severity: 'WARNING',
      username: user.username,
      role: user.role,
      action: 'SYS_WRITE_FILE',
      targetResource: '/etc/kernel.conf',
      verdict: 'DENY',
      details: 'Intento de sobreescritura en /etc/kernel.conf rechazado por Matriz ACL (permiso rwx insuficiente).'
    });
    return { simulated: 'UNAUTHORIZED_FS_ACCESS' };
  }

  /**
   * Construye un veredicto DENY y deja constancia inmutable del rechazo.
   * @returns {{allowed: false, reason: string}} Veredicto negativo con la causa.
   */
  _deny(eventType, severity, username, role, action, targetResource, details) {
    this.recordAudit({
      eventType,
      severity,
      username,
      role,
      action,
      targetResource,
      verdict: 'DENY',
      details
    });
    return { allowed: false, reason: details };
  }

  /**
   * Crea y prepend una entrada sellada en SecurityAuditLog (append-only).
   * @param {Object} event - Datos del evento de seguridad.
   * @returns {SecurityAuditLog} Entrada congelada y encadenada al hash anterior.
   */
  recordAudit({ eventType, severity, username, role, action, targetResource, verdict, details }) {
    const prevHash = this.auditLogs.length > 0 ? this.auditLogs[0].hash : '00000000';
    const entry = new SecurityAuditLog({
      seq: this.nextLogSeq++,
      tick: this.kernel.clock.currentTick,
      eventType,
      severity,
      username,
      role,
      action,
      targetResource,
      verdict,
      details,
      prevHash
    });
    this.auditLogs.unshift(entry);
    if (this.auditLogs.length > 150) {
      this.auditLogs.pop();
    }
    return entry;
  }
}
