/**
 * @file MemoryManager.js
 * @description Servidor de Administración de Memoria en espacio de usuario (Módulo 2.2):
 *  - Esquema Estático (Particiones Fijas) y Esquema Dinámico (Particiones Variables: First-Fit, Best-Fit, Worst-Fit)
 *  - Cálculo matemático en tiempo real de Fragmentación Interna y Fragmentación Externa
 *  - Protección del espacio de Kernel y validación de acceso a direcciones de memoria
 */

import { SERVER_ENDPOINTS, SYSCALL_ACTIONS } from '../core/IPCMessage.js';

export class MemoryPartition {
  constructor({
    id,
    baseAddress,
    sizeKB,
    isKernel = false,
    isOccupied = false,
    allocatedPid = null,
    processName = null,
    requestedSizeKB = 0
  }) {
    this.id = id;
    this.baseAddress = baseAddress;
    this.sizeKB = sizeKB;
    this.isKernel = isKernel;
    this.isOccupied = isOccupied;
    this.allocatedPid = allocatedPid;
    this.processName = processName;
    this.requestedSizeKB = requestedSizeKB;
  }

  get internalFragmentationKB() {
    if (!this.isOccupied || this.isKernel) return 0;
    return Math.max(0, this.sizeKB - this.requestedSizeKB);
  }
}

export class FragmentationReport {
  constructor({
    timestampTick = 0,
    activeScheme = 'DYNAMIC_VARIABLE',
    activeFitPolicy = 'FIRST_FIT',
    totalMemoryKB,
    kernelReservedKB,
    usedByProcessesKB,
    internalFragmentationKB,
    totalFreeKB,
    largestFreeBlockKB,
    externalFragmentationKB,
    externalFragmentationPercent,
    hasCriticalExternalFragmentation = false,
    lastFailedReqKB = 0,
    memoryUtilizationPercent = 0
  }) {
    this.timestampTick = timestampTick;
    this.activeScheme = activeScheme;
    this.activeFitPolicy = activeFitPolicy;
    this.totalMemoryKB = totalMemoryKB;
    this.kernelReservedKB = kernelReservedKB;
    this.usedByProcessesKB = usedByProcessesKB;
    this.internalFragmentationKB = internalFragmentationKB;
    this.totalFreeKB = totalFreeKB;
    this.largestFreeBlockKB = largestFreeBlockKB;
    this.externalFragmentationKB = externalFragmentationKB;
    this.externalFragmentationPercent = externalFragmentationPercent;
    this.hasCriticalExternalFragmentation = hasCriticalExternalFragmentation;
    this.lastFailedReqKB = lastFailedReqKB;
    this.memoryUtilizationPercent = memoryUtilizationPercent;
    Object.freeze(this); // Objeto inmutable (RF-16)
  }
}

export class MemoryManager {
  /**
   * @param {import('../core/Kernel.js').Kernel} kernel
   */
  constructor(kernel) {
    this.kernel = kernel;
    this.totalMemoryKB = 1024;
    this.kernelReservedKB = 128;
    this.scheme = 'DYNAMIC_VARIABLE'; // 'STATIC_FIXED' | 'DYNAMIC_VARIABLE'
    this.fitAlgorithm = 'FIRST_FIT'; // 'FIRST_FIT' | 'BEST_FIT' | 'WORST_FIT'
    this.fixedPartitionSizes = [128, 256, 128, 256, 128]; // Suma = 896 KB de espacio de usuario

    /** @type {MemoryPartition[]} */
    this.partitions = [];
    this.nextPartitionSeq = 1;
    /** Último tamaño solicitado que falló por falta de memoria (para la condición crítica de RF-16). */
    this.lastFailedReqKB = 0;

    this.initializeMemoryLayout();
    this.kernel.registerServer(SERVER_ENDPOINTS.MEMORY_SERVER, (msg) => this.handleIPC(msg));
  }

  initializeMemoryLayout() {
    this.partitions = [];
    this.nextPartitionSeq = 1;
    this.lastFailedReqKB = 0;

    // Partición 0: Reservada estrictamente para el Microkernel
    this.partitions.push(
      new MemoryPartition({
        id: 'PART-KERNEL',
        baseAddress: 0,
        sizeKB: this.kernelReservedKB,
        isKernel: true,
        isOccupied: true,
        allocatedPid: 0,
        processName: 'Minikernel Core',
        requestedSizeKB: this.kernelReservedKB
      })
    );

    if (this.scheme === 'STATIC_FIXED') {
      let currentBase = this.kernelReservedKB;
      for (const size of this.fixedPartitionSizes) {
        this.partitions.push(
          new MemoryPartition({
            id: `FIXED-${this.nextPartitionSeq++}`,
            baseAddress: currentBase,
            sizeKB: size
          })
        );
        currentBase += size;
      }
    } else {
      // Esquema Dinámico (Particiones Variables): un bloque contiguo inicial de 896 KB
      this.partitions.push(
        new MemoryPartition({
          id: `DYN-${this.nextPartitionSeq++}`,
          baseAddress: this.kernelReservedKB,
          sizeKB: this.totalMemoryKB - this.kernelReservedKB
        })
      );
    }
  }

  handleIPC(msg) {
    const { action, payload } = msg;

    switch (action) {
      case SYSCALL_ACTIONS.SYS_ALLOC:
        return this.allocateMemory(payload.pid, payload.processName, payload.sizeKB);

      case SYSCALL_ACTIONS.SYS_FREE:
        return this.freeMemory(payload.pid);

      case 'SET_MEMORY_CONFIG':
        return this.reconfigureMemory(payload.scheme, payload.fitAlgorithm);

      case SYSCALL_ACTIONS.SYS_MEM_ACCESS:
        return this.validateMemoryAccess(payload.pid, payload.targetAddressKB);

      case 'MEM_QUERY_REGION':
        return this.getProcessRegion(payload.pid);

      case 'IPC_MEM_STATUS_REPORT':
        return this.getStatusReport();

      default:
        throw new Error(`Acción desconocida en MEMORY_SERVER: ${action}`);
    }
  }

  /** Publica al monitor de la UI el estado generado por el servidor de memoria. */
  publishStatusReport() {
    return this.kernel.sendIPC({
      sender: SERVER_ENDPOINTS.MEMORY_SERVER,
      receiver: SERVER_ENDPOINTS.UI_MONITOR,
      action: 'IPC_MEM_STATUS_REPORT',
      payload: this.getStatusReport()
    });
  }

  reconfigureMemory(scheme, fitAlgorithm) {
    const modeChanged = scheme && scheme !== this.scheme;
    if (modeChanged && this.partitions.some((p) => !p.isKernel && p.isOccupied)) {
      throw new Error('ERR_SCHEME_CHANGE_BLOCKED: Hay procesos con memoria asignada; termínalos antes de cambiar el esquema.');
    }
    if (scheme && ['STATIC_FIXED', 'DYNAMIC_VARIABLE'].includes(scheme)) {
      this.scheme = scheme;
    }
    if (fitAlgorithm && ['FIRST_FIT', 'BEST_FIT', 'WORST_FIT'].includes(fitAlgorithm)) {
      this.fitAlgorithm = fitAlgorithm;
    }
    if (modeChanged) {
      this.initializeMemoryLayout();
    }
    const result = {
      scheme: this.scheme,
      fitAlgorithm: this.fitAlgorithm,
      fragmentation: this.calculateFragmentation()
    };
    this.publishStatusReport();
    return result;
  }

  allocateMemory(pid, processName, sizeKB) {
    const rawKB = Number(sizeKB);
    if (!Number.isFinite(rawKB) || rawKB <= 0) {
      return {
        allocated: false,
        reason: `ERR_INVALID_SIZE: el tamaño solicitado (${sizeKB}) debe ser un número mayor a 0 KB.`,
        fragmentation: this.calculateFragmentation()
      };
    }
    const reqKB = Math.max(4, Math.ceil(rawKB));
    if (this.partitions.some((p) => !p.isKernel && p.allocatedPid === Number(pid))) {
      return { allocated: false, reason: `ERR_PID_ALREADY_ALLOCATED: P${pid} ya posee una partición.`, fragmentation: this.calculateFragmentation() };
    }
    const candidates = this.partitions
      .map((part, index) => ({ part, index }))
      .filter(({ part }) => !part.isKernel && !part.isOccupied && part.sizeKB >= reqKB);

    if (candidates.length === 0) {
      this.lastFailedReqKB = reqKB;
      const frag = this.calculateFragmentation();
      const isExtFrag = frag.totalFreeKB >= reqKB;
      const result = {
        allocated: false,
        reason: isExtFrag
          ? `ERR_EXTERNAL_FRAGMENTATION: Hay ${frag.totalFreeKB} KB libres totales, pero el hueco contiguo mayor es de ${frag.largestFreeBlockKB} KB (< ${reqKB} KB solicitados).`
          : `ERR_OUT_OF_MEMORY: Memoria insuficiente para ${reqKB} KB (Libre total: ${frag.totalFreeKB} KB).`,
        fragmentation: frag
      };
      this.publishStatusReport();
      return result;
    }

    // Selección del bloque según First-Fit, Best-Fit o Worst-Fit
    let chosen = candidates[0];
    if (this.fitAlgorithm === 'BEST_FIT') {
      candidates.sort((a, b) => (a.part.sizeKB - reqKB) - (b.part.sizeKB - reqKB));
      chosen = candidates[0];
    } else if (this.fitAlgorithm === 'WORST_FIT') {
      candidates.sort((a, b) => (b.part.sizeKB - reqKB) - (a.part.sizeKB - reqKB));
      chosen = candidates[0];
    }

    const targetPart = chosen.part;

    if (this.scheme === 'STATIC_FIXED') {
      // En particiones fijas se asigna la partición completa y el sobrante es Fragmentación Interna
      targetPart.isOccupied = true;
      targetPart.allocatedPid = pid;
      targetPart.processName = processName;
      targetPart.requestedSizeKB = reqKB;
      this.lastFailedReqKB = 0;
      this.verifyInvariants();
      const result = {
        allocated: true,
        partition: targetPart,
        fragmentation: this.calculateFragmentation()
      };
      this.publishStatusReport();
      return result;
    }

    // Esquema Dinámico (Particiones Variables): dividir bloque (Splitting) si sobra espacio
    const remainderKB = targetPart.sizeKB - reqKB;
    targetPart.sizeKB = reqKB;
    targetPart.isOccupied = true;
    targetPart.allocatedPid = pid;
    targetPart.processName = processName;
    targetPart.requestedSizeKB = reqKB;

    if (remainderKB > 0) {
      const freeHole = new MemoryPartition({
        id: `DYN-${this.nextPartitionSeq++}`,
        baseAddress: targetPart.baseAddress + reqKB,
        sizeKB: remainderKB,
        isOccupied: false
      });
      this.partitions.splice(chosen.index + 1, 0, freeHole);
    }

    this.lastFailedReqKB = 0;
    this.verifyInvariants();
    const result = {
      allocated: true,
      partition: targetPart,
      fragmentation: this.calculateFragmentation()
    };
    this.publishStatusReport();
    return result;
  }

  freeMemory(pid) {
    let freed = false;
    for (const part of this.partitions) {
      if (!part.isKernel && part.allocatedPid === Number(pid)) {
        part.isOccupied = false;
        part.allocatedPid = null;
        part.processName = null;
        part.requestedSizeKB = 0;
        freed = true;
      }
    }

    if (freed && this.scheme === 'DYNAMIC_VARIABLE') {
      this.coalesceFreeBlocks();
    }
    if (freed) this.lastFailedReqKB = 0;
    this.verifyInvariants();

    const result = {
      freed,
      fragmentation: this.calculateFragmentation()
    };
    if (freed) this.publishStatusReport();
    return result;
  }

  coalesceFreeBlocks() {
    let i = 0;
    while (i < this.partitions.length - 1) {
      const curr = this.partitions[i];
      const next = this.partitions[i + 1];
      if (!curr.isKernel && !curr.isOccupied && !next.isKernel && !next.isOccupied) {
        curr.sizeKB += next.sizeKB;
        this.partitions.splice(i + 1, 1);
      } else {
        i += 1;
      }
    }
  }

  validateMemoryAccess(pid, targetAddressKB) {
    const addr = Number(targetAddressKB);
    if (addr < this.kernelReservedKB) {
      this.kernel.raiseInterrupt({
        irqCode: 'TRAP_SIGSEGV',
        type: 'EXCEPTION',
        priority: 0,
        sourceServer: SERVER_ENDPOINTS.MEMORY_SERVER,
        targetPid: pid,
        description: `Violación de protección de Kernel: P${pid} intentó acceder a dirección ${addr} KB (< ${this.kernelReservedKB} KB)`
      });
      throw new Error(`TRAP_SIGSEGV: Violación de espacio de memoria del Kernel por P${pid} en ${addr} KB.`);
    }

    const ownedPart = this.partitions.find((p) => p.allocatedPid === Number(pid));
    if (!ownedPart) {
      throw new Error(`Proceso P${pid} no posee partición de memoria activa.`);
    }

    const minAddr = ownedPart.baseAddress;
    const maxAddr = ownedPart.baseAddress + ownedPart.sizeKB;
    if (addr < minAddr || addr >= maxAddr) {
      this.kernel.raiseInterrupt({
        irqCode: 'TRAP_SIGSEGV',
        type: 'EXCEPTION',
        priority: 0,
        sourceServer: SERVER_ENDPOINTS.MEMORY_SERVER,
        targetPid: pid,
        description: `Violación Base/Límite: P${pid} accedió a ${addr} KB fuera de [${minAddr} KB, ${maxAddr} KB)`
      });
      throw new Error(`TRAP_SIGSEGV: Violación de segmento de P${pid}. Dirección ${addr} KB fuera de límites [${minAddr}, ${maxAddr}) KB.`);
    }

    return { valid: true, partitionId: ownedPart.id, addressKB: addr };
  }

  /** Región asignada en bytes, consultada por DeviceDriver para validar transferencias DMA. */
  getProcessRegion(pid) {
    const part = this.partitions.find((p) => !p.isKernel && p.allocatedPid === Number(pid));
    if (!part) return null;
    return {
      pid: Number(pid),
      partitionId: part.id,
      baseKB: part.baseAddress,
      sizeKB: part.sizeKB,
      baseBytes: part.baseAddress * 1024,
      limitBytes: (part.baseAddress + part.sizeKB) * 1024
    };
  }

  /**
   * Invariantes de RNF-06: suma de particiones == RAM total, sin huecos ni solapes,
   * tamaños positivos y ningún PID con más de una partición.
   */
  verifyInvariants() {
    const sum = this.partitions.reduce((acc, p) => acc + p.sizeKB, 0);
    if (sum !== this.totalMemoryKB) {
      throw new Error(`KERNEL_PANIC_INVARIANT_VIOLATION: suma de particiones ${sum} KB != RAM total ${this.totalMemoryKB} KB.`);
    }
    const seenPids = new Set();
    for (let i = 0; i < this.partitions.length; i++) {
      const part = this.partitions[i];
      if (part.sizeKB <= 0) {
        throw new Error(`KERNEL_PANIC_INVARIANT_VIOLATION: ${part.id} tiene tamaño ${part.sizeKB} KB.`);
      }
      if (i > 0) {
        const prev = this.partitions[i - 1];
        if (prev.baseAddress + prev.sizeKB !== part.baseAddress) {
          throw new Error(`KERNEL_PANIC_INVARIANT_VIOLATION: hueco o solape entre ${prev.id} y ${part.id}.`);
        }
      }
      if (!part.isKernel && part.isOccupied) {
        if (seenPids.has(part.allocatedPid)) {
          throw new Error(`KERNEL_PANIC_INVARIANT_VIOLATION: PID ${part.allocatedPid} posee más de una partición.`);
        }
        seenPids.add(part.allocatedPid);
      }
    }
    return true;
  }

  /** Reporte de solo lectura publicado por IPC (IPC_MEM_STATUS_REPORT). */
  getStatusReport() {
    return {
      fragmentation: this.calculateFragmentation(),
      partitions: this.partitions.map((p) => ({
        id: p.id,
        baseAddress: p.baseAddress,
        sizeKB: p.sizeKB,
        isKernel: p.isKernel,
        isOccupied: p.isOccupied,
        allocatedPid: p.allocatedPid,
        processName: p.processName,
        requestedSizeKB: p.requestedSizeKB,
        internalFragmentationKB: p.internalFragmentationKB
      }))
    };
  }

  calculateFragmentation() {
    let usedByProcessesKB = 0;
    let allocatedPartitionsKB = 0;
    let internalFragmentationKB = 0;
    let totalFreeKB = 0;
    let largestFreeBlockKB = 0;

    for (const part of this.partitions) {
      if (part.isKernel) continue;
      if (part.isOccupied) {
        usedByProcessesKB += part.requestedSizeKB;
        allocatedPartitionsKB += part.sizeKB;
        internalFragmentationKB += part.internalFragmentationKB;
      } else {
        totalFreeKB += part.sizeKB;
        if (part.sizeKB > largestFreeBlockKB) {
          largestFreeBlockKB = part.sizeKB;
        }
      }
    }

    // Condición crítica (RF-16): hay memoria libre suficiente en total, pero no contigua.
    const hasCritical =
      this.lastFailedReqKB > 0 && totalFreeKB >= this.lastFailedReqKB && largestFreeBlockKB < this.lastFailedReqKB;

    // RF-16 define FE como memoria libre total menos el mayor bloque contiguo.
    const externalFragmentationKB = Math.max(0, totalFreeKB - largestFreeBlockKB);

    const userSpaceKB = this.totalMemoryKB - this.kernelReservedKB;
    const externalFragmentationPercent =
      externalFragmentationKB > 0 ? Number(((externalFragmentationKB / userSpaceKB) * 100).toFixed(1)) : 0;
    const memoryUtilizationPercent = Number(((allocatedPartitionsKB / userSpaceKB) * 100).toFixed(1));

    return new FragmentationReport({
      timestampTick: this.kernel.clock ? this.kernel.clock.currentTick : 0,
      activeScheme: this.scheme,
      activeFitPolicy: this.fitAlgorithm,
      totalMemoryKB: this.totalMemoryKB,
      kernelReservedKB: this.kernelReservedKB,
      usedByProcessesKB,
      internalFragmentationKB,
      totalFreeKB,
      largestFreeBlockKB,
      externalFragmentationKB,
      externalFragmentationPercent,
      hasCriticalExternalFragmentation: hasCritical,
      lastFailedReqKB: this.lastFailedReqKB,
      memoryUtilizationPercent
    });
  }
}
