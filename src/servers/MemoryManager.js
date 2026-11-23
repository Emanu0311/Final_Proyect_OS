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
    totalMemoryKB,
    kernelReservedKB,
    usedByProcessesKB,
    internalFragmentationKB,
    totalFreeKB,
    largestFreeBlockKB,
    externalFragmentationKB,
    externalFragmentationPercent
  }) {
    this.totalMemoryKB = totalMemoryKB;
    this.kernelReservedKB = kernelReservedKB;
    this.usedByProcessesKB = usedByProcessesKB;
    this.internalFragmentationKB = internalFragmentationKB;
    this.totalFreeKB = totalFreeKB;
    this.largestFreeBlockKB = largestFreeBlockKB;
    this.externalFragmentationKB = externalFragmentationKB;
    this.externalFragmentationPercent = externalFragmentationPercent;
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

    this.initializeMemoryLayout();
    this.kernel.registerServer(SERVER_ENDPOINTS.MEMORY_SERVER, (msg) => this.handleIPC(msg));
  }

  initializeMemoryLayout() {
    this.partitions = [];
    this.nextPartitionSeq = 1;

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

      default:
        throw new Error(`Acción desconocida en MEMORY_SERVER: ${action}`);
    }
  }

  reconfigureMemory(scheme, fitAlgorithm) {
    const modeChanged = scheme && scheme !== this.scheme;
    if (scheme && ['STATIC_FIXED', 'DYNAMIC_VARIABLE'].includes(scheme)) {
      this.scheme = scheme;
    }
    if (fitAlgorithm && ['FIRST_FIT', 'BEST_FIT', 'WORST_FIT'].includes(fitAlgorithm)) {
      this.fitAlgorithm = fitAlgorithm;
    }
    if (modeChanged) {
      this.initializeMemoryLayout();
    }
    return {
      scheme: this.scheme,
      fitAlgorithm: this.fitAlgorithm,
      fragmentation: this.calculateFragmentation()
    };
  }

  allocateMemory(pid, processName, sizeKB) {
    const reqKB = Math.max(4, Number(sizeKB) || 32);
    const candidates = this.partitions
      .map((part, index) => ({ part, index }))
      .filter(({ part }) => !part.isKernel && !part.isOccupied && part.sizeKB >= reqKB);

    if (candidates.length === 0) {
      const frag = this.calculateFragmentation();
      const isExtFrag = frag.totalFreeKB >= reqKB;
      return {
        allocated: false,
        reason: isExtFrag
          ? `ERR_EXTERNAL_FRAGMENTATION: Hay ${frag.totalFreeKB} KB libres totales, pero el hueco contiguo mayor es de ${frag.largestFreeBlockKB} KB (< ${reqKB} KB solicitados).`
          : `ERR_OUT_OF_MEMORY: Memoria insuficiente para ${reqKB} KB (Libre total: ${frag.totalFreeKB} KB).`,
        fragmentation: frag
      };
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
      return {
        allocated: true,
        partition: targetPart,
        fragmentation: this.calculateFragmentation()
      };
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

    return {
      allocated: true,
      partition: targetPart,
      fragmentation: this.calculateFragmentation()
    };
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

    return {
      freed,
      fragmentation: this.calculateFragmentation()
    };
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

  calculateFragmentation() {
    let usedByProcessesKB = 0;
    let internalFragmentationKB = 0;
    let totalFreeKB = 0;
    let largestFreeBlockKB = 0;

    for (const part of this.partitions) {
      if (part.isKernel) continue;
      if (part.isOccupied) {
        usedByProcessesKB += part.requestedSizeKB;
        internalFragmentationKB += part.internalFragmentationKB;
      } else {
        totalFreeKB += part.sizeKB;
        if (part.sizeKB > largestFreeBlockKB) {
          largestFreeBlockKB = part.sizeKB;
        }
      }
    }

    const externalFragmentationKB =
      this.scheme === 'DYNAMIC_VARIABLE' ? Math.max(0, totalFreeKB - largestFreeBlockKB) : 0;
    const userSpaceKB = this.totalMemoryKB - this.kernelReservedKB;
    const externalFragmentationPercent =
      totalFreeKB > 0 ? Number(((externalFragmentationKB / userSpaceKB) * 100).toFixed(1)) : 0;

    return new FragmentationReport({
      totalMemoryKB: this.totalMemoryKB,
      kernelReservedKB: this.kernelReservedKB,
      usedByProcessesKB,
      internalFragmentationKB,
      totalFreeKB,
      largestFreeBlockKB,
      externalFragmentationKB,
      externalFragmentationPercent
    });
  }
}
