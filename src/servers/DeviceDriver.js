/**
 * @file DeviceDriver.js
 * @description Servidor de Entrada/Salida en espacio de usuario (Módulo 2.4):
 *  - Parametrización geométrica de Disco (Cilindros, Pistas, Sectores, RPM)
 *  - Algoritmos de planificación de brazo de disco: FCFS, SSTF, SCAN, C-SCAN
 *  - Canal DMA (Direct Memory Access) con transferencia directa a RAM e interrupción IRQ_DMA_DONE
 *  - Interfaces de Red Simuladas mediante Sockets entre procesos con buffers TX/RX
 */

import { SERVER_ENDPOINTS, SYSCALL_ACTIONS } from '../core/IPCMessage.js';

export class DiskGeometry {
  constructor({ cylinders = 200, tracksPerCylinder = 8, sectorsPerTrack = 64, rpm = 7200 } = {}) {
    this.cylinders = Number(cylinders);
    this.tracksPerCylinder = Number(tracksPerCylinder);
    this.sectorsPerTrack = Number(sectorsPerTrack);
    this.rpm = Number(rpm);
  }
}

export class DMAController {
  constructor() {
    this.state = 'IDLE'; // 'IDLE' | 'CONFIGURING' | 'TRANSFERRING' | 'IRQ_ASSERTED'
    this.activeTransfer = null;
    this.completedTransfers = 0;
  }

  startTransfer({ pid = null, cylinder, path = '/dev/sda', sizeBytes = 1024, durationTicks = 2 }) {
    this.state = 'TRANSFERRING';
    this.activeTransfer = {
      id: `DMA-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      pid,
      cylinder,
      path,
      sizeBytes,
      remainingTicks: durationTicks,
      totalTicks: durationTicks,
      ramTargetAddress: `0x${(0x20000 + cylinder * 64).toString(16).toUpperCase()}`
    };
    return this.activeTransfer;
  }

  stepTick() {
    if (!this.activeTransfer) {
      this.state = 'IDLE';
      return null;
    }
    this.activeTransfer.remainingTicks -= 1;
    if (this.activeTransfer.remainingTicks <= 0) {
      const done = this.activeTransfer;
      this.activeTransfer = null;
      this.state = 'IRQ_ASSERTED';
      this.completedTransfers += 1;
      return done;
    }
    return null;
  }
}

export class SimulatedSocket {
  constructor({ id, localPort, remotePort, ownerPid, targetPid, capacity = 8 }) {
    this.id = id;
    this.localPort = localPort;
    this.remotePort = remotePort;
    this.ownerPid = ownerPid;
    this.targetPid = targetPid;
    this.capacity = capacity;
    this.txBuffer = [];
    this.rxBuffer = [];
    this.deliveredPackets = [];
  }
}

export class DeviceDriver {
  /**
   * @param {import('../core/Kernel.js').Kernel} kernel
   */
  constructor(kernel) {
    this.kernel = kernel;
    this.geometry = new DiskGeometry({ cylinders: 200, tracksPerCylinder: 8, sectorsPerTrack: 64, rpm: 7200 });
    this.diskAlgorithm = 'SCAN'; // 'FCFS' | 'SSTF' | 'SCAN' | 'C-SCAN'
    this.currentHeadCylinder = 50;
    this.scanDirection = 'UP'; // 'UP' | 'DOWN'

    /** @type {Array<{id: string, cylinder: number, operation: string, path: string, pid: number|null}>} */
    this.pendingDiskQueue = [
      { id: 'REQ-1', cylinder: 95, operation: 'READ', path: '/etc/kernel.conf', pid: 101 },
      { id: 'REQ-2', cylinder: 180, operation: 'WRITE', path: '/home/proyecto_so.txt', pid: 102 },
      { id: 'REQ-3', cylinder: 34, operation: 'READ', path: '/bin/sh', pid: 103 },
      { id: 'REQ-4', cylinder: 119, operation: 'READ', path: '/pub/readme_guest.md', pid: 104 },
      { id: 'REQ-5', cylinder: 11, operation: 'WRITE', path: '/var/sys.log', pid: 105 },
      { id: 'REQ-6', cylinder: 123, operation: 'READ', path: '/home/data.bin', pid: 101 },
      { id: 'REQ-7', cylinder: 62, operation: 'READ', path: '/etc/acl.conf', pid: 102 }
    ];

    /** @type {Array<{tick: number, cylinder: number, seekDelta: number, algorithm: string, path: string}>} */
    this.headHistory = [
      { tick: 0, cylinder: 50, seekDelta: 0, algorithm: 'INIT', path: 'Posición Inicial Cabezal' }
    ];
    this.totalSeekDistance = 0;

    this.dma = new DMAController();

    /** @type {SimulatedSocket[]} */
    this.sockets = [
      new SimulatedSocket({ id: 'SOCK-01', localPort: 8080, remotePort: 9090, ownerPid: 101, targetPid: 102 }),
      new SimulatedSocket({ id: 'SOCK-02', localPort: 9090, remotePort: 8080, ownerPid: 102, targetPid: 101 })
    ];

    this.kernel.registerServer(SERVER_ENDPOINTS.IO_SERVER, (msg) => this.handleIPC(msg));
  }

  handleIPC(msg) {
    const { action, payload } = msg;

    switch (action) {
      case 'IO_CLOCK_TICK':
        return this.onClockTick(payload.tick);

      case SYSCALL_ACTIONS.SYS_IO_DISK_REQ:
        return this.enqueueDiskRequest(payload);

      case 'EXEC_DISK_BATCH':
        return this.executeFullScheduleSimulation();

      case 'SET_DISK_CONFIG':
        return this.updateDiskConfig(payload);

      case SYSCALL_ACTIONS.SYS_NET_SEND:
        return this.sendNetworkPacket(payload);

      case SYSCALL_ACTIONS.SYS_NET_RECV:
        return this.flushNetworkBuffers();

      default:
        throw new Error(`Acción desconocida en IO_SERVER: ${action}`);
    }
  }

  updateDiskConfig({ cylinders, tracksPerCylinder, sectorsPerTrack, rpm, algorithm, headCylinder }) {
    if (cylinders) this.geometry.cylinders = Math.max(50, Math.min(1000, Number(cylinders)));
    if (tracksPerCylinder) this.geometry.tracksPerCylinder = Math.max(1, Number(tracksPerCylinder));
    if (sectorsPerTrack) this.geometry.sectorsPerTrack = Math.max(8, Number(sectorsPerTrack));
    if (rpm !== undefined) this.geometry.rpm = Math.max(0, Number(rpm));
    if (algorithm && ['FCFS', 'SSTF', 'SCAN', 'C-SCAN'].includes(algorithm)) {
      this.diskAlgorithm = algorithm;
    }
    if (headCylinder !== undefined) {
      this.currentHeadCylinder = Math.max(0, Math.min(this.geometry.cylinders - 1, Number(headCylinder)));
    }
    return {
      geometry: this.geometry,
      diskAlgorithm: this.diskAlgorithm,
      currentHeadCylinder: this.currentHeadCylinder
    };
  }

  enqueueDiskRequest({ cylinder, operation = 'READ', path = '/dev/sda', pid = null, blockProcess = false }) {
    const cyl = Math.max(0, Math.min(this.geometry.cylinders - 1, Number(cylinder) || 0));
    const req = {
      id: `REQ-${Date.now().toString(36).slice(-3).toUpperCase()}-${Math.floor(Math.random() * 90 + 10)}`,
      cylinder: cyl,
      operation,
      path,
      pid
    };
    this.pendingDiskQueue.push(req);

    if (blockProcess && pid) {
      this.kernel.sendIPC({
        sender: SERVER_ENDPOINTS.IO_SERVER,
        receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
        action: 'PROC_BLOCK_IO',
        payload: { pid, reason: `Esperando E/S Disco Cilindro ${cyl} (${operation})` }
      });
    }

    return req;
  }

  /**
   * Calcula el orden exacto de atención según el algoritmo activo (FCFS, SSTF, SCAN, C-SCAN).
   */
  computeScheduleOrder(queue = this.pendingDiskQueue, startCylinder = this.currentHeadCylinder) {
    const items = [...queue];
    if (items.length === 0) return [];

    if (this.diskAlgorithm === 'FCFS') {
      return items;
    }

    if (this.diskAlgorithm === 'SSTF') {
      const ordered = [];
      let curr = startCylinder;
      const pool = [...items];
      while (pool.length > 0) {
        pool.sort((a, b) => Math.abs(a.cylinder - curr) - Math.abs(b.cylinder - curr));
        const next = pool.shift();
        ordered.push(next);
        curr = next.cylinder;
      }
      return ordered;
    }

    if (this.diskAlgorithm === 'SCAN') {
      const upper = items.filter((r) => r.cylinder >= startCylinder).sort((a, b) => a.cylinder - b.cylinder);
      const lower = items.filter((r) => r.cylinder < startCylinder).sort((a, b) => b.cylinder - a.cylinder);
      return this.scanDirection === 'UP' ? [...upper, ...lower] : [...lower, ...upper];
    }

    if (this.diskAlgorithm === 'C-SCAN') {
      const upper = items.filter((r) => r.cylinder >= startCylinder).sort((a, b) => a.cylinder - b.cylinder);
      const lower = items.filter((r) => r.cylinder < startCylinder).sort((a, b) => a.cylinder - b.cylinder);
      return [...upper, ...lower];
    }

    return items;
  }

  onClockTick(tick) {
    // 1. Si hay transferencia DMA activa, avanzarla sin ocupar CPU
    const completedDMA = this.dma.stepTick();
    if (completedDMA) {
      this.kernel.raiseInterrupt({
        irqCode: 'IRQ_DMA_DONE',
        type: 'HARDWARE',
        priority: 1,
        sourceServer: SERVER_ENDPOINTS.IO_SERVER,
        targetPid: completedDMA.pid,
        description: `Transferencia DMA completada (${completedDMA.path} -> RAM ${completedDMA.ramTargetAddress})`
      });
    }

    // 2. Si el canal DMA está libre y hay peticiones en la cola de disco, atender la siguiente
    if (this.dma.state !== 'TRANSFERRING' && this.pendingDiskQueue.length > 0) {
      const ordered = this.computeScheduleOrder();
      const nextReq = ordered[0];
      const idx = this.pendingDiskQueue.findIndex((r) => r.id === nextReq.id);
      if (idx !== -1) this.pendingDiskQueue.splice(idx, 1);

      const delta = Math.abs(nextReq.cylinder - this.currentHeadCylinder);
      this.totalSeekDistance += delta;
      this.currentHeadCylinder = nextReq.cylinder;

      this.headHistory.push({
        tick,
        cylinder: nextReq.cylinder,
        seekDelta: delta,
        algorithm: this.diskAlgorithm,
        path: `${nextReq.operation} ${nextReq.path}`
      });
      if (this.headHistory.length > 25) {
        this.headHistory.shift();
      }

      this.dma.startTransfer({
        pid: nextReq.pid,
        cylinder: nextReq.cylinder,
        path: nextReq.path,
        sizeBytes: 1024,
        durationTicks: 1
      });
    }

    // 3. Avanzar paquetes en tránsito en los sockets simulados
    this.flushNetworkBuffers();

    return {
      currentHeadCylinder: this.currentHeadCylinder,
      dmaState: this.dma.state,
      pendingCount: this.pendingDiskQueue.length
    };
  }

  /**
   * Ejecuta todo el lote actual de la cola de disco para comparar algoritmos de brazo instantáneamente.
   */
  executeFullScheduleSimulation() {
    const ordered = this.computeScheduleOrder();
    let tickCursor = this.kernel.clock.currentTick;

    for (const req of ordered) {
      tickCursor += 1;
      const delta = Math.abs(req.cylinder - this.currentHeadCylinder);
      this.totalSeekDistance += delta;
      this.currentHeadCylinder = req.cylinder;
      this.headHistory.push({
        tick: tickCursor,
        cylinder: req.cylinder,
        seekDelta: delta,
        algorithm: this.diskAlgorithm,
        path: `${req.operation} ${req.path}`
      });
    }
    while (this.headHistory.length > 25) {
      this.headHistory.shift();
    }

    const lastReq = ordered[ordered.length - 1];
    this.pendingDiskQueue = [];
    if (lastReq) {
      this.dma.startTransfer({
        pid: lastReq.pid,
        cylinder: lastReq.cylinder,
        path: lastReq.path,
        sizeBytes: 2048,
        durationTicks: 1
      });
    }

    return {
      servedCount: ordered.length,
      totalSeekDistance: this.totalSeekDistance,
      headHistory: this.headHistory
    };
  }

  sendNetworkPacket({ sourceSocketId = 'SOCK-01', payload = 'PING_IPC_PACKET' }) {
    const srcSock = this.sockets.find((s) => s.id === sourceSocketId) || this.sockets[0];
    const dstSock = this.sockets.find((s) => s.localPort === srcSock.remotePort) || this.sockets[1];

    if (srcSock.txBuffer.length >= srcSock.capacity) {
      throw new Error(`ENOBUFS: Buffer de salida TX lleno en ${srcSock.id}`);
    }

    const packet = {
      id: `PKT-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      fromPid: srcSock.ownerPid,
      toPid: dstSock.ownerPid,
      srcPort: srcSock.localPort,
      dstPort: dstSock.localPort,
      payload,
      sizeBytes: payload.length * 8,
      tick: this.kernel.clock.currentTick,
      status: 'IN_TX_BUFFER'
    };

    srcSock.txBuffer.push(packet);
    return packet;
  }

  flushNetworkBuffers() {
    for (const srcSock of this.sockets) {
      if (srcSock.txBuffer.length > 0) {
        const pkt = srcSock.txBuffer.shift();
        const dstSock = this.sockets.find((s) => s.localPort === pkt.dstPort);
        if (dstSock) {
          pkt.status = 'DELIVERED_RX';
          dstSock.rxBuffer.unshift(pkt);
          if (dstSock.rxBuffer.length > dstSock.capacity) {
            dstSock.rxBuffer.pop();
          }
          dstSock.deliveredPackets.unshift(pkt);
        }
      }
    }
    return this.sockets;
  }
}
