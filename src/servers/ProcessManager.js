/**
 * @file ProcessManager.js
 * @description Servidor de Procesos en espacio de usuario (Módulo 2.1):
 *  - Estructura PCB (PID, Estado, Registros PC/SP/Acc, Prioridad, Tiempo CPU, Punteros a Memoria)
 *  - Planificación de CPU (Round Robin con Quantum configurable, Prioridades Apropiativas, SJF/SRTF)
 *  - Colas en tiempo real (Ready Queue, Running CPU, Blocked Queue, Terminated)
 *  - Sincronización (Semáforos/Mutex) y Algoritmo del Banquero (Allocation, Max, Need, Available)
 */

import { SERVER_ENDPOINTS, SYSCALL_ACTIONS } from '../core/IPCMessage.js';

export class PCB {
  constructor({
    pid,
    name,
    appType = 'COMPILED',
    priority = 2,
    burstTime = 6,
    memorySizeKB = 64,
    arrivalTick = 0,
    owner = { userId: 'usr-root', username: 'root', role: 'ROOT' },
    maxResources = [2, 1, 1]
  }) {
    this.pid = pid;
    this.name = name;
    this.appType = appType; // 'COMPILED' | 'INTERPRETED'
    this.state = 'NEW'; // 'NEW' | 'READY' | 'RUNNING' | 'BLOCKED' | 'TERMINATED'
    this.priority = Number(priority);
    this.burstTime = Math.max(1, Number(burstTime));
    this.remainingTime = this.burstTime;
    this.cpuTimeUsed = 0;
    this.waitingTime = 0;
    this.arrivalTick = arrivalTick;
    this.quantumUsed = 0;
    this.firstRunTick = null; // para tiempo de respuesta
    this.finishTick = null; // para tiempo de retorno
    this.completedNormally = false;

    // Registros simulados de CPU
    this.registers = {
      PC: 0x1000,
      SP: 0x1000 + Number(memorySizeKB) * 16,
      Acc: 0
    };

    // Punteros a Memoria asignados por el Servidor de Memoria vía IPC
    this.memory = {
      sizeKB: Number(memorySizeKB),
      baseAddress: null,
      limitAddress: null,
      partitionId: null
    };

    this.owner = owner;
    this.blockReason = null;
    this.maxResources = maxResources;
  }

  stepExecution() {
    this.cpuTimeUsed += 1;
    this.remainingTime = Math.max(0, this.remainingTime - 1);
    this.quantumUsed += 1;
    this.registers.PC += 4;
    this.registers.SP -= 2;
    this.registers.Acc = (this.registers.Acc + this.pid * 7 + this.cpuTimeUsed * 3) % 1024;
  }
}

export class Semaphore {
  constructor(name, initialValue = 1) {
    this.name = name;
    this.value = initialValue;
    this.initialValue = initialValue;
    this.holderPid = null; // último holder (compatibilidad con la UI)
    this.holderPids = []; // todos los procesos que hoy poseen el semáforo
    this.waitingPids = [];
  }
}

export class BankerAlgorithm {
  constructor() {
    this.resourceNames = ['R1 (CPU-Ch)', 'R2 (DMA-Buf)', 'R3 (FS-Lock)'];
    this.total = [10, 5, 7];
    this.available = [3, 3, 2];
    this.processes = [
      { pid: 101, name: 'P101 (sys_daemon)', allocation: [0, 1, 0], max: [7, 5, 3], demo: true },
      { pid: 102, name: 'P102 (net_worker)', allocation: [2, 0, 0], max: [3, 2, 2], demo: true },
      { pid: 103, name: 'P103 (db_engine)', allocation: [3, 0, 2], max: [9, 0, 2], demo: true },
      { pid: 104, name: 'P104 (io_spooler)', allocation: [2, 1, 1], max: [2, 2, 2], demo: true },
      { pid: 105, name: 'P105 (ui_compositor)', allocation: [0, 0, 2], max: [4, 3, 3], demo: true }
    ];
    this.lastVerdict = this.evaluateSafety();
  }

  getNeedMatrix() {
    return this.processes.map((p) => ({
      pid: p.pid,
      name: p.name,
      allocation: [...p.allocation],
      max: [...p.max],
      need: p.max.map((m, idx) => Math.max(0, m - p.allocation[idx]))
    }));
  }

  recalculateAvailable() {
    const sumAlloc = [0, 0, 0];
    for (const p of this.processes) {
      for (let j = 0; j < 3; j++) {
        sumAlloc[j] += p.allocation[j];
      }
    }
    this.available = this.total.map((tot, j) => Math.max(0, tot - sumAlloc[j]));
  }

  evaluateSafety(customProcesses = null, customAvailable = null) {
    const procs = (customProcesses || this.getNeedMatrix()).map((p) => ({
      pid: p.pid,
      name: p.name,
      allocation: [...p.allocation],
      max: [...p.max],
      need: [...p.need]
    }));
    const work = [...(customAvailable || this.available)];
    const finish = new Array(procs.length).fill(false);
    const safeSequence = [];

    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 0; i < procs.length; i++) {
        if (!finish[i]) {
          const canAllocate = procs[i].need.every((needVal, j) => needVal <= work[j]);
          if (canAllocate) {
            for (let j = 0; j < work.length; j++) {
              work[j] += procs[i].allocation[j];
            }
            finish[i] = true;
            safeSequence.push(`P${procs[i].pid}`);
            progress = true;
          }
        }
      }
    }

    const isSafe = finish.every(Boolean);
    return {
      isSafe,
      safeSequence,
      workAfter: work,
      message: isSafe
        ? `ESTADO SEGURO verificado. Secuencia segura: < ${safeSequence.join(' -> ')} >`
        : 'PELIGRO DE DEADLOCK (Estado Inseguro): Solicitud rechazada preventivamente por el Algoritmo del Banquero.'
    };
  }

  requestResources(pid, requestVector) {
    const matrix = this.getNeedMatrix();
    const targetIdx = matrix.findIndex((p) => p.pid === Number(pid));
    if (targetIdx === -1) {
      return { granted: false, reason: `Proceso P${pid} no registrado en matriz del Banquero.` };
    }

    const req = requestVector.map((x) => Math.max(0, Number(x) || 0));
    const target = matrix[targetIdx];

    // 1. Verificar Request <= Need
    for (let j = 0; j < 3; j++) {
      if (req[j] > target.need[j]) {
        this.lastVerdict = {
          isSafe: false,
          safeSequence: [],
          message: `ERR_MAX_CLAIM_EXCEEDED: P${pid} solicitó [${req.join(', ')}] que supera su necesidad máxima declarada Need=[${target.need.join(', ')}].`
        };
        return { granted: false, ...this.lastVerdict };
      }
    }

    // 2. Verificar Request <= Available
    for (let j = 0; j < 3; j++) {
      if (req[j] > this.available[j]) {
        this.lastVerdict = {
          isSafe: false,
          safeSequence: [],
          message: `RECURSOS INSUFICIENTES: P${pid} solicitó [${req.join(', ')}] pero Available=[${this.available.join(', ')}]. Proceso debe esperar.`
        };
        return { granted: false, ...this.lastVerdict };
      }
    }

    // 3. Simulación provisoria (Roll-forward)
    const tempAvailable = this.available.map((a, j) => a - req[j]);
    const tempProcs = matrix.map((p, idx) => {
      if (idx !== targetIdx) return p;
      return {
        ...p,
        allocation: p.allocation.map((a, j) => a + req[j]),
        need: p.need.map((n, j) => n - req[j])
      };
    });

    const safety = this.evaluateSafety(tempProcs, tempAvailable);
    this.lastVerdict = safety;

    if (safety.isSafe) {
      // Confirmar transacción
      for (let j = 0; j < 3; j++) {
        this.processes[targetIdx].allocation[j] += req[j];
      }
      this.recalculateAvailable();
      return { granted: true, ...safety };
    }

    // Rollback automático si el estado es inseguro
    return { granted: false, ...safety };
  }

  /**
   * Liberación voluntaria de recursos: Allocation[i] -= release, Available += release.
   * Devolver recursos nunca vuelve inseguro un estado seguro, por eso no requiere simulación.
   */
  releaseResources(pid, releaseVector) {
    const proc = this.processes.find((p) => p.pid === Number(pid));
    if (!proc) {
      return { released: false, message: `Proceso P${pid} no registrado en matriz del Banquero.` };
    }
    const rel = releaseVector.map((x) => Math.max(0, Number(x) || 0));
    for (let j = 0; j < 3; j++) {
      if (rel[j] > proc.allocation[j]) {
        return {
          released: false,
          message: `ERR_RELEASE_EXCEEDS_ALLOCATION: P${pid} intentó liberar [${rel.join(', ')}] pero solo tiene Allocation=[${proc.allocation.join(', ')}].`
        };
      }
    }
    for (let j = 0; j < 3; j++) {
      proc.allocation[j] -= rel[j];
    }
    this.recalculateAvailable();
    this.lastVerdict = this.evaluateSafety();
    return {
      released: true,
      ...this.lastVerdict,
      message: `P${pid} liberó [${rel.join(', ')}]. Available=[${this.available.join(', ')}]. ${this.lastVerdict.message}`
    };
  }

  registerProcess(pcb) {
    if (this.processes.some((p) => p.pid === pcb.pid)) return;
    this.processes.push({
      pid: pcb.pid,
      name: `P${pcb.pid} (${pcb.name})`,
      allocation: [0, 0, 0],
      max: pcb.maxResources || [2, 1, 1]
    });
    this.recalculateAvailable();
    this.lastVerdict = this.evaluateSafety();
  }

  releaseProcessResources(pid) {
    const idx = this.processes.findIndex((p) => p.pid === Number(pid));
    if (idx !== -1 && !this.processes[idx].demo) {
      this.processes.splice(idx, 1);
      this.recalculateAvailable();
      this.lastVerdict = this.evaluateSafety();
    }
  }
}

export class ProcessManager {
  /**
   * @param {import('../core/Kernel.js').Kernel} kernel
   */
  constructor(kernel) {
    this.kernel = kernel;
    this.nextPid = 1; // PIDs reales desde 1; 101-105 quedan reservados a las filas demo del Banquero
    /** @type {Map<number, PCB>} */
    this.pcbTable = new Map();

    // Configuración del Planificador
    this.algorithm = 'RR'; // 'RR' | 'PRIORITY_PREEMPTIVE' | 'SRTF'
    this.quantum = 3;

    // Sincronización y Banquero
    this.banker = new BankerAlgorithm();
    /** @type {Map<string, Semaphore>} */
    this.semaphores = new Map([
      ['MUTEX_PRINTER', new Semaphore('MUTEX_PRINTER', 1)],
      ['SEM_DB_POOL', new Semaphore('SEM_DB_POOL', 2)]
    ]);

    this.kernel.registerServer(SERVER_ENDPOINTS.PROCESS_SERVER, (msg) => this.handleIPC(msg));
  }

  handleIPC(msg) {
    const { action, payload, authContext } = msg;

    switch (action) {
      case SYSCALL_ACTIONS.SYS_FORK:
        return this.createProcess({ ...payload, owner: authContext });

      case SYSCALL_ACTIONS.SYS_KILL:
        return this.killProcess(payload.pid, payload.reason || 'Terminado por señal de usuario');

      case 'SET_SCHEDULER':
        return this.setSchedulerConfig(payload.algorithm, payload.quantum);

      case 'PROC_CLOCK_TICK':
        return this.onClockTick(payload.tick);

      case 'PROC_FINISH_CONTEXT_SWITCH':
        return this.finishContextSwitch(payload.nextPid);

      case 'IPC_IO_WAKEUP':
        return this.wakeupProcess(payload.pid, payload.details);

      case 'PROC_BLOCK_IO': {
        const pcb = this.pcbTable.get(Number(payload.pid));
        if (!pcb || pcb.state === 'BLOCKED') return null; // ya espera otro evento
        return this.blockProcess(payload.pid, payload.reason || 'Esperando transferencia DMA/Disco');
      }

      case SYSCALL_ACTIONS.SYS_BANKER_REQ:
        return this.banker.requestResources(payload.pid, payload.requestVector);

      case 'BANKER_RELEASE':
        return this.banker.releaseResources(payload.pid, payload.releaseVector);

      case SYSCALL_ACTIONS.SYS_SEM_OP:
        return this.handleSemaphoreOp(payload.semName, payload.op, payload.pid);

      default:
        throw new Error(`Acción desconocida en PROCESS_SERVER: ${action}`);
    }
  }

  createProcess({
    name = 'app_worker',
    appType = 'COMPILED',
    priority = 2,
    burstTime = 6,
    memorySizeKB = 64,
    owner = { userId: 'usr-root', username: 'root', role: 'ROOT' }
  }) {
    const pid = this.nextPid++;
    const pcb = new PCB({
      pid,
      name,
      appType,
      priority,
      burstTime,
      memorySizeKB,
      arrivalTick: this.kernel.clock.currentTick,
      owner
    });

    // Solicitar asignación de memoria al MEMORY_SERVER vía IPC
    const allocMsg = this.kernel.sendIPC({
      sender: SERVER_ENDPOINTS.PROCESS_SERVER,
      receiver: SERVER_ENDPOINTS.MEMORY_SERVER,
      action: SYSCALL_ACTIONS.SYS_ALLOC,
      payload: { pid, processName: name, sizeKB: memorySizeKB },
      authContext: owner
    });

    if (allocMsg.status === 'REJECTED' || !allocMsg.response || !allocMsg.response.allocated) {
      pcb.state = 'TERMINATED';
      pcb.blockReason = allocMsg.errorReason || (allocMsg.response && allocMsg.response.reason) || 'Out of Memory';
      throw new Error(pcb.blockReason);
    }

    const memInfo = allocMsg.response.partition;
    pcb.memory.baseAddress = memInfo.baseAddress;
    pcb.memory.limitAddress = memInfo.baseAddress + memInfo.sizeKB * 1024;
    pcb.memory.partitionId = memInfo.id;
    pcb.state = 'READY';

    this.pcbTable.set(pid, pcb);
    this.banker.registerProcess(pcb);
    return pcb;
  }

  killProcess(pid, reason = 'Terminado') {
    const pcb = this.pcbTable.get(Number(pid));
    if (!pcb) throw new Error(`PID ${pid} no existe.`);

    pcb.state = 'TERMINATED';
    pcb.blockReason = reason;
    pcb.remainingTime = 0;
    pcb.finishTick = this.kernel.clock.currentTick;

    // Liberar memoria vía IPC
    this.kernel.sendIPC({
      sender: SERVER_ENDPOINTS.PROCESS_SERVER,
      receiver: SERVER_ENDPOINTS.MEMORY_SERVER,
      action: SYSCALL_ACTIONS.SYS_FREE,
      payload: { pid: pcb.pid }
    });

    this.banker.releaseProcessResources(pcb.pid);
    this._cleanupSemaphores(pcb.pid);
    if (this.kernel.activePid === pcb.pid) {
      this.kernel.activePid = null;
    }
    return pcb;
  }

  blockProcess(pid, reason = 'Bloqueado por E/S') {
    const pcb = this.pcbTable.get(Number(pid));
    if (!pcb || pcb.state === 'TERMINATED') return null;
    pcb.state = 'BLOCKED';
    pcb.blockReason = reason;
    pcb.quantumUsed = 0;
    if (this.kernel.activePid === pcb.pid) {
      this.kernel.activePid = null;
    }
    return pcb;
  }

  wakeupProcess(pid) {
    const pcb = this.pcbTable.get(Number(pid));
    if (!pcb || pcb.state !== 'BLOCKED') return null;
    pcb.state = 'READY';
    pcb.blockReason = null;
    pcb.quantumUsed = 0;
    return pcb;
  }

  /**
   * Libera una unidad del semáforo en nombre de `pid` (SIGNAL o limpieza al terminar el proceso).
   * Si hay procesos esperando, despierta al primero y le transfiere la posesión.
   */
  _releaseSemaphore(sem, pid) {
    sem.holderPids = sem.holderPids.filter((h) => h !== pid);
    sem.value += 1;
    if (sem.waitingPids.length > 0) {
      const wokenPid = sem.waitingPids.shift();
      this.wakeupProcess(wokenPid);
      sem.holderPids.push(wokenPid);
      sem.holderPid = wokenPid;
      return { status: 'WOKEN', wokenPid, sem };
    }
    sem.holderPid = sem.holderPids[sem.holderPids.length - 1] || null;
    return { status: 'RELEASED', sem };
  }

  /** Quita al proceso de todos los semáforos (espera y posesión). Se llama al terminarlo. */
  _cleanupSemaphores(pid) {
    for (const sem of this.semaphores.values()) {
      const waitIdx = sem.waitingPids.indexOf(pid);
      if (waitIdx !== -1) {
        sem.waitingPids.splice(waitIdx, 1);
        sem.value += 1; // el WAIT pendiente ya había restado 1
      }
      if (sem.holderPids.includes(pid)) {
        this._releaseSemaphore(sem, pid);
      }
    }
  }

  handleSemaphoreOp(semName, op, pid) {
    const sem = this.semaphores.get(semName);
    if (!sem) throw new Error(`Semáforo ${semName} no existe.`);

    const targetPid = Number(pid) || this.kernel.activePid;
    const pcb = targetPid ? this.pcbTable.get(targetPid) : null;
    if (!pcb || pcb.state === 'TERMINATED') {
      return { status: 'NO_PROCESS', message: `No hay un proceso válido para ${op} en ${semName}.`, sem };
    }

    if (op === 'WAIT') {
      if (pcb.state === 'BLOCKED') {
        return { status: 'ALREADY_BLOCKED', message: `P${targetPid} ya está bloqueado y no puede ejecutar wait().`, sem };
      }
      sem.value -= 1;
      if (sem.value < 0) {
        sem.waitingPids.push(targetPid);
        this.blockProcess(targetPid, `Wait en Semáforo ${semName}`);
        return { status: 'BLOCKED', sem };
      }
      sem.holderPids.push(targetPid);
      sem.holderPid = targetPid;
      return { status: 'ACQUIRED', sem };
    }

    if (op === 'SIGNAL') {
      if (!sem.holderPids.includes(targetPid)) {
        return { status: 'NOT_HOLDER', message: `P${targetPid} no posee ${semName}; signal() rechazado.`, sem };
      }
      return this._releaseSemaphore(sem, targetPid);
    }

    throw new Error(`Operación de semáforo inválida: ${op}`);
  }

  setSchedulerConfig(algorithm, quantum = 3) {
    if (['RR', 'PRIORITY_PREEMPTIVE', 'SRTF'].includes(algorithm)) {
      this.algorithm = algorithm;
    }
    if (quantum !== undefined) {
      this.quantum = Math.max(1, Math.min(20, Number(quantum) || 3));
    }
    return { algorithm: this.algorithm, quantum: this.quantum };
  }

  getQueues() {
    const ready = [];
    const running = [];
    const blocked = [];
    const terminated = [];

    for (const pcb of this.pcbTable.values()) {
      if (pcb.state === 'READY') ready.push(pcb);
      else if (pcb.state === 'RUNNING') running.push(pcb);
      else if (pcb.state === 'BLOCKED') blocked.push(pcb);
      else if (pcb.state === 'TERMINATED') terminated.push(pcb);
    }

    if (this.algorithm === 'PRIORITY_PREEMPTIVE') {
      ready.sort((a, b) => a.priority - b.priority || a.arrivalTick - b.arrivalTick);
    } else if (this.algorithm === 'SRTF') {
      ready.sort((a, b) => a.remainingTime - b.remainingTime || a.arrivalTick - b.arrivalTick);
    }

    return { ready, running, blocked, terminated };
  }

  /**
   * Métricas del planificador (RF-05 / RF-07) calculadas con el historial por tick del kernel.
   * Retorno = fin - llegada; Respuesta = primera ejecución - llegada; Espera = ticks en cola de listos.
   */
  getMetrics() {
    const timeline = this.kernel.cpuTimeline || [];
    const total = timeline.length;
    const run = timeline.filter((t) => t.kind === 'RUN').length;
    const cs = timeline.filter((t) => t.cs).length;
    const idle = timeline.filter((t) => t.kind === 'IDLE').length;

    const finished = [...this.pcbTable.values()].filter((p) => p.completedNormally && p.finishTick !== null);
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const perProcess = finished.map((p) => ({
      pid: p.pid,
      name: p.name,
      turnaround: p.finishTick - p.arrivalTick,
      waiting: p.waitingTime,
      response: p.firstRunTick === null ? 0 : p.firstRunTick - p.arrivalTick
    }));

    return {
      totalTicks: total,
      runTicks: run,
      csTicks: cs,
      idleTicks: idle,
      cpuUtilization: total ? (run / total) * 100 : 0,
      completed: finished.length,
      throughput: total ? finished.length / total : 0,
      avgTurnaround: avg(perProcess.map((m) => m.turnaround)),
      avgWaiting: avg(perProcess.map((m) => m.waiting)),
      avgResponse: avg(perProcess.map((m) => m.response)),
      perProcess
    };
  }

  /**
   * Evalúa un tick del planificador de CPU y determina si debe ocurrir un Context Switch.
   */
  onClockTick() {
    const queues = this.getQueues();
    let currentRunning = queues.running[0] || null;

    // Incrementar tiempo de espera de todos los procesos en Ready Queue
    for (const r of queues.ready) {
      r.waitingTime += 1;
    }

    // Si hay un proceso en RUNNING, avanzar 1 tick su ejecución
    let ranPid = null; // PID que usó la CPU en este tick (para el Gantt)
    if (currentRunning) {
      currentRunning.stepExecution();
      ranPid = currentRunning.pid;

      if (currentRunning.remainingTime <= 0) {
        const done = currentRunning;
        this.killProcess(done.pid, 'Ejecución completada exitosamente (Burst=0)');
        done.completedNormally = true;
        currentRunning = null;
      }
    }

    const updatedQueues = this.getQueues();
    const bestCandidate = updatedQueues.ready[0] || null;

    if (!currentRunning) {
      if (bestCandidate) {
        return {
          contextSwitchRequired: true,
          previousPid: null,
          nextPid: bestCandidate.pid,
          ranPid
        };
      }
      return { contextSwitchRequired: false, activePCB: null, ranPid };
    }

    // Verificar expropiación (Preemption) según algoritmo activo
    if (this.algorithm === 'RR' && currentRunning.quantumUsed >= this.quantum) {
      if (bestCandidate && bestCandidate.pid !== currentRunning.pid) {
        currentRunning.state = 'READY';
        currentRunning.quantumUsed = 0;
        // Mover al final del mapa para rotación FIFO en Round Robin
        this.pcbTable.delete(currentRunning.pid);
        this.pcbTable.set(currentRunning.pid, currentRunning);
        return {
          contextSwitchRequired: true,
          previousPid: currentRunning.pid,
          nextPid: bestCandidate.pid,
          ranPid
        };
      }
      currentRunning.quantumUsed = 0;
    } else if (this.algorithm === 'PRIORITY_PREEMPTIVE' && bestCandidate) {
      if (bestCandidate.priority < currentRunning.priority) {
        currentRunning.state = 'READY';
        currentRunning.quantumUsed = 0;
        return {
          contextSwitchRequired: true,
          previousPid: currentRunning.pid,
          nextPid: bestCandidate.pid,
          ranPid
        };
      }
    } else if (this.algorithm === 'SRTF' && bestCandidate) {
      if (bestCandidate.remainingTime < currentRunning.remainingTime) {
        currentRunning.state = 'READY';
        currentRunning.quantumUsed = 0;
        return {
          contextSwitchRequired: true,
          previousPid: currentRunning.pid,
          nextPid: bestCandidate.pid,
          ranPid
        };
      }
    }

    return {
      contextSwitchRequired: false,
      activePCB: currentRunning,
      ranPid
    };
  }

  finishContextSwitch(nextPid) {
    for (const pcb of this.pcbTable.values()) {
      if (pcb.state === 'RUNNING' && pcb.pid !== nextPid) {
        pcb.state = 'READY';
        pcb.quantumUsed = 0;
      }
    }
    const nextPCB = this.pcbTable.get(Number(nextPid));
    if (nextPCB && nextPCB.state === 'READY') {
      nextPCB.state = 'RUNNING';
      nextPCB.quantumUsed = 0;
      if (nextPCB.firstRunTick === null) nextPCB.firstRunTick = this.kernel.clock.currentTick;
      return { activePCB: nextPCB };
    }
    return { activePCB: null };
  }
}