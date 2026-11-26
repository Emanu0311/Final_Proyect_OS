/**
 * @file IPCMessage.js
 * @description Protocolo estricto de Comunicación Inter-Procesos (IPC) y Solicitudes de Interrupción
 *              para la arquitectura Microkernel/Minikernel (UDFJDC - Sistemas Operativos 2026).
 */

export const SERVER_ENDPOINTS = Object.freeze({
  KERNEL: 'KERNEL',
  PROCESS_SERVER: 'PROCESS_SERVER',
  MEMORY_SERVER: 'MEMORY_SERVER',
  FS_SERVER: 'FS_SERVER',
  IO_SERVER: 'IO_SERVER',
  SECURITY_SERVER: 'SECURITY_SERVER',
  UI_MONITOR: 'UI_MONITOR'
});

export const SYSCALL_ACTIONS = Object.freeze({
  SYS_FORK: 'SYS_FORK',
  SYS_EXEC: 'SYS_EXEC',
  SYS_KILL: 'SYS_KILL',
  SYS_ALLOC: 'SYS_ALLOC',
  SYS_FREE: 'SYS_FREE',
  SYS_MEM_ACCESS: 'SYS_MEM_ACCESS',
  SYS_FORMAT_FS: 'SYS_FORMAT_FS',
  SYS_CREATE_NODE: 'SYS_CREATE_NODE',
  SYS_READ_FILE: 'SYS_READ_FILE',
  SYS_WRITE_FILE: 'SYS_WRITE_FILE',
  SYS_RENAME_NODE: 'SYS_RENAME_NODE',
  SYS_DELETE_NODE: 'SYS_DELETE_NODE',
  SYS_IO_DISK_REQ: 'SYS_IO_DISK_REQ',
  SYS_DMA_START: 'SYS_DMA_START',
  SYS_DMA_COMPLETE: 'SYS_DMA_COMPLETE',
  SYS_NET_SEND: 'SYS_NET_SEND',
  SYS_NET_RECV: 'SYS_NET_RECV',
  SYS_AUTH_LOGIN: 'SYS_AUTH_LOGIN',
  SYS_ACL_CHECK: 'SYS_ACL_CHECK',
  SYS_BANKER_REQ: 'SYS_BANKER_REQ',
  SYS_SEM_OP: 'SYS_SEM_OP'
});

/**
 * Representa un mensaje inmutable o transaccional en el bus IPC del Minikernel.
 * Cumple con la interfaz mandatoria de arquitectura Microkernel.
 */
export class IPCMessage {
  /**
   * @param {Object} params
   * @param {string} [params.id]
   * @param {number} [params.timestamp]
   * @param {number} [params.tick]
   * @param {'KERNEL'|'PROCESS_SERVER'|'MEMORY_SERVER'|'FS_SERVER'|'IO_SERVER'|'SECURITY_SERVER'} params.sender
   * @param {'KERNEL'|'PROCESS_SERVER'|'MEMORY_SERVER'|'FS_SERVER'|'IO_SERVER'|'SECURITY_SERVER'} params.receiver
   * @param {string} params.action
   * @param {any} params.payload
   * @param {'PENDING'|'ACCEPTED'|'REJECTED'|'SUCCESS'} [params.status]
   * @param {{userId: string, username?: string, role: 'ROOT'|'STANDARD'|'GUEST'}} [params.authContext]
   */
  constructor({
    id = `IPC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    timestamp = Date.now(),
    tick = 0,
    sender,
    receiver,
    action,
    payload = {},
    status = 'PENDING',
    authContext = { userId: 'usr-root', username: 'root', role: 'ROOT' }
  }) {
    this.id = id;
    this.timestamp = timestamp;
    this.tick = tick;
    this.sender = sender;
    this.receiver = receiver;
    this.action = action;
    this.payload = payload;
    this.status = status;
    this.authContext = authContext;
    this.response = null;
    this.errorReason = null;
  }

  markAccepted() {
    this.status = 'ACCEPTED';
    return this;
  }

  markSuccess(responsePayload = null) {
    this.status = 'SUCCESS';
    this.response = responsePayload;
    return this;
  }

  markRejected(reason = 'Operación rechazada por política del Minikernel') {
    this.status = 'REJECTED';
    this.errorReason = reason;
    return this;
  }

  toJSON() {
    return {
      id: this.id,
      timestamp: this.timestamp,
      tick: this.tick,
      sender: this.sender,
      receiver: this.receiver,
      action: this.action,
      payload: this.payload,
      status: this.status,
      authContext: this.authContext,
      response: this.response,
      errorReason: this.errorReason
    };
  }
}

/**
 * Representa una interrupción de Hardware (DMA, Disco, Timer) o Software (Trap/Excepción).
 */
export class InterruptRequest {
  /**
   * @param {Object} params
   * @param {string} params.irqCode - Ej: IRQ_TIMER, IRQ_DISK_IO, IRQ_DMA_DONE, TRAP_MEM_FAULT, TRAP_SEC_VIOLATION
   * @param {'HARDWARE'|'SOFTWARE'|'EXCEPTION'} params.type
   * @param {number} params.priority - 0 (más alta, ej. Excepción de Memoria/Seguridad) a 5 (más baja)
   * @param {string} params.sourceServer
   * @param {number} [params.targetPid]
   * @param {string} params.description
   * @param {any} [params.data]
   * @param {number} [params.tick]
   */
  constructor({
    irqCode,
    type = 'HARDWARE',
    priority = 2,
    sourceServer = SERVER_ENDPOINTS.IO_SERVER,
    targetPid = null,
    description = '',
    data = {},
    tick = 0
  }) {
    this.id = `IRQ-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    this.irqCode = irqCode;
    this.type = type;
    this.priority = priority;
    this.sourceServer = sourceServer;
    this.targetPid = targetPid;
    this.description = description;
    this.data = data;
    this.tick = tick;
    this.timestamp = Date.now();
    this.handled = false;
  }
}

/**
 * Bus de Comunicación Inter-Procesos (IPCBus) gobernado exclusivamente por el Kernel.
 * Ningún servidor de espacio de usuario posee referencia directa a otro servidor.
 */
export class IPCBus {
  constructor(maxHistory = 250) {
    /** @type {Map<string, Function>} */
    this.handlers = new Map();
    /** @type {IPCMessage[]} */
    this.messageQueue = [];
    /** @type {IPCMessage[]} */
    this.history = [];
    this.maxHistory = maxHistory;
    /** @type {Function[]} */
    this.subscribers = [];
  }

  /**
   * Registra un servidor de espacio de usuario en el bus IPC.
   * @param {string} endpointName
   * @param {(msg: IPCMessage) => any} handlerFn
   */
  registerEndpoint(endpointName, handlerFn) {
    this.handlers.set(endpointName, handlerFn);
  }

  /**
   * Suscribe observadores (como el monitor de la UI) al flujo de mensajes IPC.
   * @param {(msg: IPCMessage) => void} callback
   */
  subscribe(callback) {
    this.subscribers.push(callback);
  }

  /**
   * Despacha un mensaje IPC a través del bus mediado por un validador opcional del Kernel/Seguridad.
   * @param {IPCMessage} message
   * @param {(msg: IPCMessage) => {allowed: boolean, reason?: string}} [securityGuard]
   * @returns {IPCMessage}
   */
  dispatch(message, securityGuard = null) {
    this.messageQueue.push(message);

    if (securityGuard && message.receiver !== SERVER_ENDPOINTS.SECURITY_SERVER) {
      const verdict = securityGuard(message);
      if (!verdict.allowed) {
        message.markRejected(verdict.reason || 'ACL Security Policy Denied');
        this._record(message);
        return message;
      }
    }

    const handler = this.handlers.get(message.receiver);
    if (!handler) {
      message.markRejected(`Endpoint destino no registrado: ${message.receiver}`);
      this._record(message);
      return message;
    }

    try {
      message.markAccepted();
      const result = handler(message);
      if (message.status !== 'REJECTED') {
        message.markSuccess(result);
      }
    } catch (err) {
      message.markRejected(err instanceof Error ? err.message : String(err));
    }

    this._record(message);
    return message;
  }

  _record(message) {
    this.history.unshift(message);
    if (this.history.length > this.maxHistory) {
      this.history.pop();
    }
    const idx = this.messageQueue.indexOf(message);
    if (idx !== -1) {
      this.messageQueue.splice(idx, 1);
    }
    for (const sub of this.subscribers) {
      sub(message);
    }
  }
}
