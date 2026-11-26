/**
 * @file Kernel.js
 * @description Núcleo mínimo (Microkernel/Minikernel) que mantiene únicamente:
 *  1) Reloj Maestro del Sistema (SystemClock) y Cambio de Contexto (T_cs overhead)
 *  2) Controlador y Vector de Interrupciones (InterruptController)
 *  3) Bus de Comunicación Inter-Procesos (IPCBus) y Despachador de Syscalls (SyscallDispatcher)
 */

import { IPCMessage, IPCBus, InterruptRequest, SERVER_ENDPOINTS, SYSCALL_ACTIONS } from './IPCMessage.js';

export class SystemClock {
  constructor(intervalMs = 600) {
    this.currentTick = 0;
    this.intervalMs = intervalMs;
    this.isRunning = false;
    this.timerId = null;
    this.tickCallbacks = [];
  }

  onTick(cb) {
    this.tickCallbacks.push(cb);
  }

  step() {
    this.currentTick += 1;
    for (const cb of this.tickCallbacks) {
      cb(this.currentTick);
    }
    return this.currentTick;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.timerId = setInterval(() => {
      this.step();
    }, this.intervalMs);
  }

  pause() {
    this.isRunning = false;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  setFrequency(intervalMs) {
    this.intervalMs = Math.max(80, Math.min(3000, Number(intervalMs) || 600));
    if (this.isRunning) {
      this.pause();
      this.start();
    }
  }

  reset() {
    this.pause();
    this.currentTick = 0;
  }
}

export class InterruptController {
  constructor() {
    /** @type {InterruptRequest[]} */
    this.irqQueue = [];
    /** @type {InterruptRequest[]} */
    this.irqHistory = [];
    /** @type {Map<string, Function>} */
    this.ivt = new Map();
  }

  registerISR(irqCode, handlerFn) {
    this.ivt.set(irqCode, handlerFn);
  }

  raiseIRQ(irq) {
    this.irqQueue.push(irq);
    this.irqQueue.sort((a, b) => a.priority - b.priority);
  }

  hasPendingIRQs() {
    return this.irqQueue.length > 0;
  }

  dequeueNextIRQ() {
    const irq = this.irqQueue.shift() || null;
    if (irq) {
      irq.handled = true;
      this.irqHistory.unshift(irq);
      if (this.irqHistory.length > 100) this.irqHistory.pop();
    }
    return irq;
  }
}

export class Kernel {
  constructor({ clockIntervalMs = 600, contextSwitchTicks = 1 } = {}) {
    this.clock = new SystemClock(clockIntervalMs);
    this.interruptController = new InterruptController();
    this.ipcBus = new IPCBus(300);

    this.cpuMode = 'IDLE'; // 'IDLE' | 'USER_RUNNING' | 'KERNEL_ISR' | 'CONTEXT_SWITCHING'
    this.contextSwitchCostTicks = contextSwitchTicks;
    this.remainingContextSwitchTicks = 0;
    this.totalContextSwitchTicks = 0;
    this.totalContextSwitches = 0;
    this.cpuRegisters = { PC: 0, SP: 0, Acc: 0, IR: 'NOP', PSW: 'USER' };
    this.activePid = null;
    this.pendingNextPid = null;
    /** Historial por tick para el diagrama de Gantt: { tick, kind: 'RUN'|'CS'|'IDLE', pid } */
    this.cpuTimeline = [];

    this.stateListeners = [];
    this.securityValidatorFn = null;

    this._setupDefaultISRs();
    this.clock.onTick((tick) => this.executeClockCycle(tick));
  }

  _setupDefaultISRs() {
    // Fin de E/S: despierta al proceso (si corresponde) y confirma al IO_SERVER para liberar el canal DMA
    const ioCompletionISR = (irq) => {
      if (irq.targetPid !== null && irq.targetPid !== undefined) {
        this.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
          action: 'IPC_IO_WAKEUP',
          payload: { pid: irq.targetPid, irqCode: irq.irqCode, details: irq.description }
        });
      }
      if (irq.data && irq.data.requestId) {
        this.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.IO_SERVER,
          action: 'IPC_IO_COMPLETED',
          payload: { requestId: irq.data.requestId, irqCode: irq.irqCode }
        });
      }
    };
    for (const code of ['IRQ_DMA_DONE', 'IRQ_NET_RX', 'IRQ_NET_TX_READY']) {
      this.interruptController.registerISR(code, ioCompletionISR);
    }

    this.interruptController.registerISR('IRQ_DMA_FAULT', (irq) => {
      ioCompletionISR(irq);
      this.sendIPC({
        sender: SERVER_ENDPOINTS.KERNEL,
        receiver: SERVER_ENDPOINTS.SECURITY_SERVER,
        action: 'SEC_REPORT_DMA_FAULT',
        payload: { pid: irq.data?.pid ?? null, requestId: irq.data?.requestId, reason: irq.data?.reason || irq.description }
      });
    });

    this.interruptController.registerISR('TRAP_SIGSEGV', (irq) => {
      this.sendIPC({
        sender: SERVER_ENDPOINTS.KERNEL,
        receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
        action: SYSCALL_ACTIONS.SYS_KILL,
        payload: { pid: irq.targetPid, reason: `TRAP_SIGSEGV: ${irq.description}` }
      });
    });
  }

  registerServer(endpointName, handlerFn) {
    this.ipcBus.registerEndpoint(endpointName, handlerFn);
  }

  setSecurityGuard(guardFn) {
    this.securityValidatorFn = guardFn;
  }

  subscribe(listenerFn) {
    this.stateListeners.push(listenerFn);
  }

  notifyStateChange() {
    for (const fn of this.stateListeners) {
      fn(this.clock.currentTick);
    }
  }

  /**
   * Envía un mensaje a través del Bus IPC del Microkernel con validación de seguridad ACL.
   */
  sendIPC({ sender, receiver, action, payload = {}, authContext = null }) {
    const activeAuth = authContext || this._getCurrentAuthContext();
    const msg = new IPCMessage({
      tick: this.clock.currentTick,
      sender,
      receiver,
      action,
      payload,
      authContext: activeAuth
    });
    const dispatched = this.ipcBus.dispatch(msg, this.securityValidatorFn);
    this.notifyStateChange();
    return dispatched;
  }

  _getCurrentAuthContext() {
    const secHandler = this.ipcBus.handlers.get(SERVER_ENDPOINTS.SECURITY_SERVER);
    if (secHandler) {
      const probe = new IPCMessage({
        tick: this.clock.currentTick,
        sender: SERVER_ENDPOINTS.KERNEL,
        receiver: SERVER_ENDPOINTS.SECURITY_SERVER,
        action: 'GET_ACTIVE_SESSION',
        payload: {}
      });
      const res = secHandler(probe);
      if (res && res.userId) return res;
    }
    return { userId: 'usr-root', username: 'root', role: 'ROOT', uid: 0 };
  }

  raiseInterrupt(irqParams) {
    const irq = new InterruptRequest({
      ...irqParams,
      tick: this.clock.currentTick
    });
    this.interruptController.raiseIRQ(irq);
    this.notifyStateChange();
    return irq;
  }

  _recordTimeline(tick, kind, pid = null, cs = kind === 'CS') {
    // cs=true marca ticks que el kernel contabiliza como overhead de cambio de contexto
    this.cpuTimeline.push({ tick, kind, pid, cs });
    if (this.cpuTimeline.length > 400) this.cpuTimeline.shift();
  }

  setContextSwitchOverhead(ticks) {
    this.contextSwitchCostTicks = Math.max(0, Math.min(10, Number(ticks) || 0));
    this.notifyStateChange();
  }

  /**
   * Ciclo maestro de reloj del Minikernel:
   * 1) Despacha interrupciones pendientes (DMA, Timer, Traps)
   * 2) Avanza el canal DMA y cola de disco en IO_SERVER vía IPC
   * 3) Gestiona el overhead de Cambio de Contexto (T_cs) o ejecuta 1 tick de CPU en PROCESS_SERVER
   */
  executeClockCycle(tick) {
    // 1. Atender interrupciones pendientes
    while (this.interruptController.hasPendingIRQs()) {
      const irq = this.interruptController.dequeueNextIRQ();
      this.cpuMode = 'KERNEL_ISR';
      this.cpuRegisters.PSW = 'KERNEL_ISR';
      const isr = this.interruptController.ivt.get(irq.irqCode);
      if (isr) {
        isr(irq);
      }
    }

    // 2. Notificar avance de tick a IO_SERVER (para DMA y brazo de disco autónomos)
    this.sendIPC({
      sender: SERVER_ENDPOINTS.KERNEL,
      receiver: SERVER_ENDPOINTS.IO_SERVER,
      action: 'IO_CLOCK_TICK',
      payload: { tick }
    });

    // 3. Verificar si estamos en medio de un Context Switch (T_cs > 0)
    if (this.remainingContextSwitchTicks > 0) {
      this._recordTimeline(tick, 'CS', this.pendingNextPid);
      this.cpuMode = 'CONTEXT_SWITCHING';
      this.cpuRegisters.PSW = 'KERNEL_CS';
      this.cpuRegisters.IR = `CTX_SWITCH (${this.remainingContextSwitchTicks} ticks left)`;
      this.remainingContextSwitchTicks -= 1;
      this.totalContextSwitchTicks += 1;

      if (this.remainingContextSwitchTicks === 0 && this.pendingNextPid !== null) {
        // Restaurar contexto del proceso entrante
        const restoreMsg = this.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
          action: 'PROC_FINISH_CONTEXT_SWITCH',
          payload: { nextPid: this.pendingNextPid, tick }
        });
        if (restoreMsg.response && restoreMsg.response.activePCB) {
          const pcb = restoreMsg.response.activePCB;
          this.activePid = pcb.pid;
          this.cpuRegisters = {
            PC: pcb.registers.PC,
            SP: pcb.registers.SP,
            Acc: pcb.registers.Acc,
            IR: `EXEC PID ${pcb.pid}`,
            PSW: 'USER'
          };
          this.cpuMode = 'USER_RUNNING';
        }
        this.pendingNextPid = null;
      }
      this.notifyStateChange();
      return;
    }

    // 4. Solicitar al Servidor de Procesos la evaluación de planificación del tick
    const schedMsg = this.sendIPC({
      sender: SERVER_ENDPOINTS.KERNEL,
      receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
      action: 'PROC_CLOCK_TICK',
      payload: { tick, currentActivePid: this.activePid }
    });

    const schedRes = schedMsg.response || {};
    const csOverhead = Boolean(schedRes.contextSwitchRequired) && this.contextSwitchCostTicks > 0;
    if (schedRes.ranPid) this._recordTimeline(tick, 'RUN', schedRes.ranPid, csOverhead);
    else if (csOverhead) this._recordTimeline(tick, 'CS', schedRes.nextPid);
    else this._recordTimeline(tick, 'IDLE', null);
    if (schedRes.contextSwitchRequired) {
      this.totalContextSwitches += 1;
      if (this.contextSwitchCostTicks > 0) {
        this.cpuMode = 'CONTEXT_SWITCHING';
        this.cpuRegisters.PSW = 'KERNEL_CS';
        this.cpuRegisters.IR = `SAVE PCB ${schedRes.previousPid || '-'} -> LOAD PCB ${schedRes.nextPid}`;
        this.pendingNextPid = schedRes.nextPid;
        this.remainingContextSwitchTicks = this.contextSwitchCostTicks - 1;
        this.totalContextSwitchTicks += 1;

        if (this.remainingContextSwitchTicks === 0) {
          const restoreMsg = this.sendIPC({
            sender: SERVER_ENDPOINTS.KERNEL,
            receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
            action: 'PROC_FINISH_CONTEXT_SWITCH',
            payload: { nextPid: this.pendingNextPid, tick }
          });
          if (restoreMsg.response && restoreMsg.response.activePCB) {
            const pcb = restoreMsg.response.activePCB;
            this.activePid = pcb.pid;
            this.cpuRegisters = {
              PC: pcb.registers.PC,
              SP: pcb.registers.SP,
              Acc: pcb.registers.Acc,
              IR: `EXEC PID ${pcb.pid}`,
              PSW: 'USER'
            };
            this.cpuMode = 'USER_RUNNING';
          }
          this.pendingNextPid = null;
        }
      } else {
        // T_cs == 0: conmutación inmediata
        const restoreMsg = this.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
          action: 'PROC_FINISH_CONTEXT_SWITCH',
          payload: { nextPid: schedRes.nextPid, tick }
        });
        if (restoreMsg.response && restoreMsg.response.activePCB) {
          const pcb = restoreMsg.response.activePCB;
          this.activePid = pcb.pid;
          this.cpuRegisters = {
            PC: pcb.registers.PC,
            SP: pcb.registers.SP,
            Acc: pcb.registers.Acc,
            IR: `EXEC PID ${pcb.pid}`,
            PSW: 'USER'
          };
          this.cpuMode = 'USER_RUNNING';
        }
      }
    } else if (schedRes.activePCB) {
      const pcb = schedRes.activePCB;
      this.activePid = pcb.pid;
      this.cpuMode = 'USER_RUNNING';
      this.cpuRegisters = {
        PC: pcb.registers.PC,
        SP: pcb.registers.SP,
        Acc: pcb.registers.Acc,
        IR: `ADD ACC, #${(pcb.registers.PC * 7) % 13}`,
        PSW: 'USER'
      };
    } else {
      this.activePid = null;
      this.cpuMode = 'IDLE';
      this.cpuRegisters.IR = 'IDLE_WAIT';
      this.cpuRegisters.PSW = 'IDLE';
    }

    this.notifyStateChange();
  }
}