/**
 * @file DeviceDriver.js
 * @description Servidor de Entrada/Salida en espacio de usuario (Módulo 2.4).
 * Alineado con RF-20..RF-23, CU-07, CU-08 y las entidades DISK_CONFIGS, DISK_SECTORS y SYSTEM_LOGS del modelo ER.
 *
 * Escala temporal (RNF-08): 1 tick del SystemClock = MS_PER_TICK ms de hardware simulado.
 */

import { SERVER_ENDPOINTS, SYSCALL_ACTIONS } from '../core/IPCMessage.js';

export const MS_PER_TICK = 10;
const SSD_ACCESS_MS = 0.1;
// Buffer de rebote del driver dentro del espacio de kernel: destino DMA de peticiones del sistema (sin PID)
const KERNEL_IO_BUFFER = 96 * 1024;
const KERNEL_IO_BUFFER_END = 128 * 1024;
const DISK_ALGORITHMS = ['FCFS', 'SSTF', 'SCAN', 'C-SCAN'];
const SECTOR_SIZES = [512, 1024, 2048, 4096];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hex = (n) => `0x${Number(n || 0).toString(16).toUpperCase().padStart(6, '0')}`;
const ioError = (code, detail) => new Error(`${code}: ${detail}`);
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));
const maxSuffix = (ids) => ids.reduce((max, id) => Math.max(max, Number(String(id).split('-').pop()) || 0), 0);

function concatBytes(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export class DiskGeometry {
  constructor({
    diskId = 'DISK-0',
    mediaType = 'HDD',
    cylinders = 200,
    tracksPerCylinder = 8,
    sectorsPerTrack = 64,
    sectorSize = 512,
    rpm = 7200,
    seekTimePerCylinderMs = 0.1
  } = {}) {
    this.diskId = diskId;
    this.mediaType = mediaType === 'SSD' ? 'SSD' : 'HDD';
    this.cylinders = Number(cylinders);
    this.tracksPerCylinder = Number(tracksPerCylinder);
    this.sectorsPerTrack = Number(sectorsPerTrack);
    this.sectorSize = Number(sectorSize);
    // FA-07.1: un SSD no tiene rotación ni brazo mecánico
    this.rpm = this.mediaType === 'SSD' ? 0 : Number(rpm);
    this.seekTimePerCylinderMs = this.mediaType === 'SSD' ? 0 : Number(seekTimePerCylinderMs);
  }

  getTotalSectors() {
    return this.cylinders * this.tracksPerCylinder * this.sectorsPerTrack;
  }

  getTotalCapacityBytes() {
    return this.getTotalSectors() * this.sectorSize;
  }

  /** C = LBA / (H*S), H = (LBA mod (H*S)) / S, S = (LBA mod S) + 1 */
  lbaToCHS(lba) {
    const perCylinder = this.tracksPerCylinder * this.sectorsPerTrack;
    return {
      cylinder: Math.floor(lba / perCylinder),
      track: Math.floor((lba % perCylinder) / this.sectorsPerTrack),
      sector: (lba % this.sectorsPerTrack) + 1
    };
  }

  chsToLBA(cylinder, track, sector) {
    return (cylinder * this.tracksPerCylinder + track) * this.sectorsPerTrack + (sector - 1);
  }

  validateCHS(cylinder, track, sector) {
    return (
      [cylinder, track, sector].every(Number.isInteger) &&
      cylinder >= 0 && cylinder < this.cylinders &&
      track >= 0 && track < this.tracksPerCylinder &&
      sector >= 1 && sector <= this.sectorsPerTrack
    );
  }

  validateLBA(lba, sectorCount = 1) {
    return Number.isInteger(lba) && lba >= 0 && lba + sectorCount <= this.getTotalSectors();
  }

  calculateSeekTimeMs(distanceCylinders) {
    return Math.abs(distanceCylinders) * this.seekTimePerCylinderMs;
  }

  /** T_rot = 1/2 * (60000 / rpm) ms */
  calculateRotationalLatencyMs() {
    return this.rpm > 0 ? (0.5 * 60000) / this.rpm : 0;
  }

  calculateAccessTimeMs(distanceCylinders) {
    if (this.mediaType === 'SSD') return SSD_ACCESS_MS;
    return this.calculateSeekTimeMs(distanceCylinders) + this.calculateRotationalLatencyMs();
  }
}

export class DiskRequest {
  constructor({
    requestId,
    arrivalSeq,
    pid = null,
    operation = 'READ',
    lba,
    cylinder,
    track,
    sector,
    byteCount,
    sectorCount,
    targetMemoryAddress = null,
    path = '/dev/sda',
    data = null,
    blockedPid = null,
    arrivalTick = 0
  }) {
    this.requestId = requestId;
    this.arrivalSeq = arrivalSeq;
    this.pid = pid;
    this.operation = operation; // 'READ' | 'WRITE'
    this.lba = lba;
    this.cylinder = cylinder;
    this.track = track;
    this.sector = sector;
    this.byteCount = byteCount;
    this.sectorCount = sectorCount;
    this.targetMemoryAddress = targetMemoryAddress;
    this.path = path;
    this.data = data; // string o arreglo de bytes (solo WRITE)
    this.blockedPid = blockedPid;
    this.status = 'QUEUED'; // 'QUEUED' | 'SEEKING' | 'TRANSFERRING' | 'COMPLETED' | 'FAILED'
    this.arrivalTick = arrivalTick;
    this.dispatchTick = null;
    this.completionTick = null;
    this.seekDistance = 0;
    this.accessTimeMs = 0;
    this.errorCode = null;
    this.readData = null;
  }

  get id() {
    return this.requestId;
  }

  calculateCylinderDistance(currentCylinder) {
    return Math.abs(this.cylinder - currentCylinder);
  }

  getServiceLatencyTicks() {
    return this.completionTick === null ? null : this.completionTick - this.arrivalTick;
  }
}

export class DMAController {
  static CCR_START = 0x01;
  static CCR_IE = 0x02; // Interrupt Enable
  static CCR_MEM_TO_DEV = 0x04; // 1 = WRITE (RAM -> disco), 0 = READ (disco -> RAM)
  static CCR_DONE = 0x80;

  constructor({ channelId = 0, bytesTransferredPerTick = 512 } = {}) {
    this.channelId = channelId;
    this.bytesTransferredPerTick = bytesTransferredPerTick;
    this.completedTransfers = 0;
    this.faultCount = 0;
    this.lastFault = null;
    this.reset();
  }

  configureChannel({ sar, dar, bcr, mode, req, ramAddress }) {
    this.state = 'CONFIGURING';
    this.sourceAddressRegister = sar;
    this.destinationAddressRegister = dar;
    this.byteCountRegister = bcr;
    this.controlStatusRegister = DMAController.CCR_IE | (mode === 'WRITE' ? DMAController.CCR_MEM_TO_DEV : 0);
    this.currentTransferRequest = req;
    this.ramAddress = ramAddress;
  }

  startTransfer() {
    this.controlStatusRegister |= DMAController.CCR_START;
    this.state = 'TRANSFERRING';
  }

  /** Un tick de robo de ciclos: mueve hasta bytesTransferredPerTick sin usar la CPU. true cuando BCR llega a 0. */
  executeCycleStealingTick() {
    if (this.state !== 'TRANSFERRING') return false;
    const chunk = Math.min(this.bytesTransferredPerTick, this.byteCountRegister);
    this.byteCountRegister -= chunk;
    this.sourceAddressRegister += chunk;
    this.destinationAddressRegister += chunk;
    if (this.byteCountRegister > 0) return false;
    this.controlStatusRegister = (this.controlStatusRegister & ~DMAController.CCR_START) | DMAController.CCR_DONE;
    this.state = 'COMPLETED';
    this.completedTransfers += 1;
    return true;
  }

  abort(reason, req) {
    this.state = 'FAULT';
    this.faultCount += 1;
    this.lastFault = reason;
    this.controlStatusRegister = 0;
    this.byteCountRegister = 0;
    this.currentTransferRequest = req;
  }

  isBusy() {
    return this.state === 'CONFIGURING' || this.state === 'TRANSFERRING';
  }

  reset() {
    this.sourceAddressRegister = 0;
    this.destinationAddressRegister = 0;
    this.byteCountRegister = 0;
    this.controlStatusRegister = 0;
    this.state = 'IDLE'; // 'IDLE' | 'CONFIGURING' | 'TRANSFERRING' | 'COMPLETED' | 'FAULT'
    this.currentTransferRequest = null;
    this.ramAddress = null;
  }

  getRegisters() {
    return {
      SAR: hex(this.sourceAddressRegister),
      DAR: hex(this.destinationAddressRegister),
      BCR: this.byteCountRegister,
      CCR: `0x${this.controlStatusRegister.toString(16).toUpperCase().padStart(2, '0')}`
    };
  }

  get activeTransfer() {
    const req = this.currentTransferRequest;
    if (!req || this.state !== 'TRANSFERRING') return null;
    return {
      id: req.requestId,
      pid: req.pid,
      cylinder: req.cylinder,
      path: req.path,
      sizeBytes: req.byteCount,
      ramTargetAddress: hex(this.ramAddress)
    };
  }
}

export class SimulatedSocket {
  constructor({
    id,
    ownerPid = null,
    localPort,
    remotePort = null,
    targetPid = null,
    protocol = 'TCP_SIM',
    blockingMode = false,
    bufferCapacityBytes = 256,
    capacity = 8,
    mtu = 32
  }) {
    this.id = id;
    this.ownerPid = ownerPid;
    this.localPort = Number(localPort);
    this.remotePort = remotePort === null ? null : Number(remotePort);
    this.targetPid = targetPid;
    this.protocol = protocol === 'UDP_SIM' ? 'UDP_SIM' : 'TCP_SIM';
    this.blockingMode = Boolean(blockingMode);
    this.bufferCapacityBytes = bufferCapacityBytes;
    this.capacity = capacity; // máximo de paquetes por buffer
    this.mtu = mtu;
    this.state = this.remotePort === null ? 'LISTEN' : 'ESTABLISHED'; // | 'CLOSED'
    this.txBuffer = [];
    this.rxBuffer = [];
    this.txUsedBytes = 0;
    this.rxUsedBytes = 0;
    this.totalBytesSent = 0;
    this.totalBytesReceived = 0;
    this.droppedPacketsCount = 0;
    this.nextSeqNumber = 1;
    this.deliveredPackets = [];
    this.recvWaiters = [];
    this.sendWaiters = [];
  }

  hasSpaceInTX(bytes, packets = 1) {
    return this.txBuffer.length + packets <= this.capacity && this.txUsedBytes + bytes <= this.bufferCapacityBytes;
  }

  hasSpaceInRX(bytes) {
    return this.rxBuffer.length < this.capacity && this.rxUsedBytes + bytes <= this.bufferCapacityBytes;
  }

  enqueueTX(packet) {
    this.txBuffer.push(packet);
    this.txUsedBytes += packet.payloadSize;
  }

  dequeueTX() {
    const packet = this.txBuffer.shift();
    if (packet) this.txUsedBytes -= packet.payloadSize;
    return packet;
  }

  enqueueRX(packet) {
    this.rxBuffer.push(packet);
    this.rxUsedBytes += packet.payloadSize;
    this.totalBytesReceived += packet.payloadSize;
  }

  removeRX(packets) {
    this.rxBuffer = this.rxBuffer.filter((p) => !packets.includes(p));
    this.rxUsedBytes -= packets.reduce((acc, p) => acc + p.payloadSize, 0);
  }

  close() {
    this.state = 'CLOSED';
  }
}

export class DeviceDriver {
  /**
   * @param {import('../core/Kernel.js').Kernel} kernel
   */
  constructor(kernel) {
    this.kernel = kernel;
    this.driverId = 'IO-DRV-0';
    this.geometry = new DiskGeometry();
    this.diskAlgorithm = 'SCAN';
    this.currentHeadCylinder = 50;
    this.armDirection = 'UP';
    this.maxQueueDepth = 32;

    /** @type {DiskRequest[]} */
    this.requestQueue = [];
    /** @type {DiskRequest|null} */
    this.activeRequest = null;
    this.positioningTicksLeft = 0;
    /** @type {DiskRequest[]} */
    this.completedRequests = [];
    this.stats = { served: 0, failed: 0, latencyTicksSum: 0 };
    this.totalSeekDistance = 0;
    this.headHistory = [{ tick: 0, cylinder: 50, seekDelta: 0, algorithm: 'INIT', path: 'Posición inicial del cabezal' }];

    /** Tabla DISK_SECTORS del modelo ER (lba -> registro). @type {Map<number, object>} */
    this.sectorTable = new Map();
    /** Registros SYSTEM_LOGS con module = 'IO'. */
    this.systemLogs = [];

    this.dma = new DMAController({ bytesTransferredPerTick: this.geometry.sectorSize });

    this.sockets = [
      new SimulatedSocket({ id: 'SOCK-01', localPort: 8080, remotePort: 9090, ownerPid: 101, targetPid: 102 }),
      new SimulatedSocket({ id: 'SOCK-02', localPort: 9090, remotePort: 8080, ownerPid: 102, targetPid: 101 })
    ];

    this._seq = { request: 0, log: 0, packet: 0, message: 0, socket: this.sockets.length };

    this.kernel.registerServer(SERVER_ENDPOINTS.IO_SERVER, (msg) => this.handleIPC(msg));

    // Cola de demostración: peticiones del sistema (sin PID) que usan el buffer de kernel
    for (const [cylinder, operation, path] of [
      [95, 'READ', '/etc/kernel.conf'],
      [180, 'WRITE', '/home/proyecto_so.txt'],
      [34, 'READ', '/bin/sh'],
      [119, 'READ', '/pub/readme_guest.md'],
      [11, 'WRITE', '/var/sys.log'],
      [123, 'READ', '/home/data.bin'],
      [62, 'READ', '/etc/acl.conf']
    ]) {
      this.enqueueDiskRequest({ cylinder, operation, path });
    }
  }

  /** Alias usado por la versión anterior de la UI. */
  get pendingDiskQueue() {
    return this.requestQueue;
  }

  set pendingDiskQueue(queue) {
    this.requestQueue = queue;
  }

  handleIPC(msg) {
    const { action, payload = {} } = msg;

    switch (action) {
      case 'IO_CLOCK_TICK':
        return this.onClockTick(payload.tick);
      case SYSCALL_ACTIONS.SYS_IO_DISK_REQ:
        return this.enqueueDiskRequest(payload);
      case 'IPC_IO_COMPLETED':
        return this.acknowledgeInterrupt(payload);
      case 'EXEC_DISK_BATCH':
        return this.executeFullScheduleSimulation();
      case 'IO_COMPARE_ALGORITHMS':
        return this.compareAlgorithms();
      case 'SET_DISK_CONFIG':
        return this.updateDiskConfig(payload);
      case SYSCALL_ACTIONS.SYS_NET_BIND:
        return this.createSocket(payload);
      case SYSCALL_ACTIONS.SYS_NET_SEND:
        return this.sendNetworkPacket(payload);
      case SYSCALL_ACTIONS.SYS_NET_RECV:
        return this.receivePacket(payload);
      case SYSCALL_ACTIONS.SYS_NET_CLOSE:
        return this.closeSocket(payload);
      default:
        throw new Error(`Acción desconocida en IO_SERVER: ${action}`);
    }
  }

  // ------------------------------------------------------------------ Bitácora (SYSTEM_LOGS)

  _log(severity, eventCode, description, { pid = null, metadata = {} } = {}) {
    const auth = this.kernel._getCurrentAuthContext();
    const entry = {
      log_id: `IO-${String(++this._seq.log).padStart(5, '0')}`,
      kernel_tick: this.kernel.clock.currentTick,
      timestamp: new Date().toISOString(),
      module: 'IO',
      severity, // 'INFO' | 'WARN' | 'ERROR' | 'SECURITY_ALERT'
      pid_actor: pid,
      user_id: auth.uid ?? null,
      event_code: eventCode,
      description,
      metadata_payload: metadata
    };
    this.systemLogs.unshift(entry);
    if (this.systemLogs.length > 200) this.systemLogs.pop();
    return entry;
  }

  // ------------------------------------------------------------------ Geometría (RF-20, DISK_CONFIGS)

  updateDiskConfig({
    mediaType,
    cylinders,
    tracksPerCylinder,
    sectorsPerTrack,
    sectorSize,
    rpm,
    seekTimePerCylinderMs,
    algorithm,
    headCylinder,
    direction
  } = {}) {
    const g = this.geometry;
    const next = new DiskGeometry({
      diskId: g.diskId,
      mediaType: mediaType ?? g.mediaType,
      cylinders: cylinders ? clampInt(cylinders, 50, 1000) : g.cylinders,
      tracksPerCylinder: tracksPerCylinder ? clampInt(tracksPerCylinder, 1, 64) : g.tracksPerCylinder,
      sectorsPerTrack: sectorsPerTrack ? clampInt(sectorsPerTrack, 8, 512) : g.sectorsPerTrack,
      sectorSize: sectorSize ? Number(sectorSize) : g.sectorSize,
      rpm: rpm ?? g.rpm,
      seekTimePerCylinderMs: seekTimePerCylinderMs ?? g.seekTimePerCylinderMs
    });
    // Al volver de SSD a HDD se recupera un perfil mecánico válido
    if (next.mediaType === 'HDD' && next.rpm <= 0) next.rpm = 7200;
    if (next.mediaType === 'HDD' && next.seekTimePerCylinderMs <= 0) next.seekTimePerCylinderMs = 0.1;

    if (!SECTOR_SIZES.includes(next.sectorSize)) {
      throw ioError('-EINVAL', `Tamaño de sector no soportado: ${sectorSize}`);
    }
    if (next.mediaType === 'HDD' && (next.rpm < 1000 || next.rpm > 20000)) {
      throw ioError('-EINVAL', `RPM fuera de rango para HDD: ${next.rpm}`);
    }
    if (algorithm && !DISK_ALGORITHMS.includes(algorithm)) {
      throw ioError('-EINVAL', `Algoritmo de brazo desconocido: ${algorithm}`);
    }

    const layoutChanged = ['cylinders', 'tracksPerCylinder', 'sectorsPerTrack', 'sectorSize'].some((k) => next[k] !== g[k]);
    if (layoutChanged) {
      if (this.activeRequest) {
        throw ioError('-EBUSY', `Hay una transferencia en curso (${this.activeRequest.requestId}); espera a que termine.`);
      }
      const invalid = this.requestQueue.filter(
        (r) =>
          !next.validateCHS(r.cylinder, r.track, r.sector) ||
          !next.validateLBA(next.chsToLBA(r.cylinder, r.track, r.sector), Math.ceil(r.byteCount / next.sectorSize))
      );
      if (invalid.length) {
        throw ioError('-EBUSY', `${invalid.length} petición(es) quedarían fuera de la nueva geometría; ejecuta o vacía la cola primero.`);
      }
      for (const r of this.requestQueue) {
        r.lba = next.chsToLBA(r.cylinder, r.track, r.sector);
        r.sectorCount = Math.ceil(r.byteCount / next.sectorSize);
      }
      if (this.sectorTable.size) {
        this._log('WARN', 'DISK_RELAYOUT', `Geometría física cambiada: ${this.sectorTable.size} sectores descartados (medio nuevo).`);
        this.sectorTable.clear();
      }
    }

    this.geometry = next;
    this.dma.bytesTransferredPerTick = next.sectorSize;
    // FA-07.3: la cola pendiente se replanifica con la nueva política en el próximo despacho
    if (algorithm) this.diskAlgorithm = algorithm;
    if (direction === 'UP' || direction === 'DOWN') this.armDirection = direction;
    const head = Number(headCylinder);
    this.currentHeadCylinder =
      headCylinder !== undefined && Number.isFinite(head)
        ? clampInt(head, 0, next.cylinders - 1)
        : Math.min(this.currentHeadCylinder, next.cylinders - 1);

    this._log('INFO', 'DISK_CONFIG_UPDATED', `Disco ${next.mediaType} ${next.cylinders}x${next.tracksPerCylinder}x${next.sectorsPerTrack} @${next.sectorSize}B, ${this.diskAlgorithm}`, {
      metadata: this.getDiskConfigRecord()
    });

    return {
      geometry: next,
      diskAlgorithm: this.diskAlgorithm,
      currentHeadCylinder: this.currentHeadCylinder,
      armDirection: this.armDirection,
      metrics: this.getDiskMetrics()
    };
  }

  getDiskConfigRecord() {
    const g = this.geometry;
    return {
      disk_id: g.diskId,
      media_type: g.mediaType,
      cylinders: g.cylinders,
      tracks_per_cylinder: g.tracksPerCylinder,
      sectors_per_track: g.sectorsPerTrack,
      sector_size_bytes: g.sectorSize,
      rpm: g.rpm,
      seek_time_ms: g.seekTimePerCylinderMs,
      active_scheduler: this.diskAlgorithm,
      current_head_cylinder: this.currentHeadCylinder,
      head_direction: this.armDirection,
      updated_at: new Date().toISOString()
    };
  }

  getDiskMetrics() {
    const g = this.geometry;
    return {
      capacityBytes: g.getTotalCapacityBytes(),
      totalSectors: g.getTotalSectors(),
      rotationalLatencyMs: g.calculateRotationalLatencyMs(),
      fullStrokeSeekMs: g.calculateSeekTimeMs(g.cylinders - 1),
      totalSeekDistance: this.totalSeekDistance,
      servedRequests: this.stats.served,
      failedRequests: this.stats.failed,
      avgServiceLatencyTicks: this.stats.served ? this.stats.latencyTicksSum / this.stats.served : 0,
      writtenSectors: this.sectorTable.size
    };
  }

  // ------------------------------------------------------------------ Peticiones (CU-07 pasos 1-3)

  enqueueDiskRequest({
    lba = null,
    logicalBlock = null,
    blockSizeBytes = null,
    cylinder = null,
    track = 0,
    sector = 1,
    operation = 'READ',
    path = '/dev/sda',
    pid = null,
    blockProcess = false,
    byteCount = null,
    sizeBytes = null,
    data = null,
    memoryAddress = null
  } = {}) {
    const g = this.geometry;
    const op = operation === 'WRITE' ? 'WRITE' : 'READ';
    const owner = pid === null || pid === undefined || pid === '' ? null : Number(pid);
    const bytes = Math.floor(Number(byteCount ?? sizeBytes ?? g.sectorSize));
    if (!Number.isFinite(bytes) || bytes < 1) {
      this._rejectRequest(`Cantidad de bytes inválida: ${byteCount ?? sizeBytes}`, owner);
    }

    let targetLba;
    if (logicalBlock !== null && logicalBlock !== undefined) {
      // El FS solo conoce bloques lógicos; la traducción a LBA es responsabilidad del driver
      const sectorsPerBlock = Math.max(1, Math.ceil((Number(blockSizeBytes) || g.sectorSize) / g.sectorSize));
      targetLba = Number(logicalBlock) * sectorsPerBlock;
    } else if (lba !== null && lba !== undefined) {
      targetLba = Number(lba);
    } else {
      const c = Number(cylinder);
      const h = Number(track);
      const s = Number(sector);
      if (!g.validateCHS(c, h, s)) {
        this._rejectRequest(
          `Coordenada (C${cylinder}, H${track}, S${sector}) fuera de la geometría ${g.cylinders}x${g.tracksPerCylinder}x${g.sectorsPerTrack}`,
          owner
        );
      }
      targetLba = g.chsToLBA(c, h, s);
    }

    const sectorCount = Math.ceil(bytes / g.sectorSize);
    if (!g.validateLBA(targetLba, sectorCount)) {
      this._rejectRequest(`LBA ${targetLba} + ${sectorCount} sector(es) excede la capacidad (${g.getTotalSectors()} sectores)`, owner);
    }

    if (this.requestQueue.length >= this.maxQueueDepth) {
      this._log('WARN', 'IO_QUEUE_FULL', `Cola de disco saturada (${this.maxQueueDepth} peticiones)`, { pid: owner });
      throw ioError('-EBUSY', `Cola de disco llena (${this.maxQueueDepth}); reintente cuando se libere.`);
    }

    const seq = ++this._seq.request;
    const req = new DiskRequest({
      requestId: `REQ-${String(seq).padStart(3, '0')}`,
      arrivalSeq: seq,
      pid: owner,
      operation: op,
      lba: targetLba,
      ...g.lbaToCHS(targetLba),
      byteCount: bytes,
      sectorCount,
      targetMemoryAddress: memoryAddress === null || memoryAddress === undefined ? null : Number(memoryAddress),
      path,
      data,
      arrivalTick: this.kernel.clock.currentTick
    });

    if (blockProcess && owner !== null) {
      const blockMsg = this.kernel.sendIPC({
        sender: SERVER_ENDPOINTS.IO_SERVER,
        receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
        action: 'PROC_BLOCK_IO',
        payload: { pid: owner, reason: `Esperando E/S ${op} LBA ${targetLba} (C${req.cylinder})` }
      });
      if (blockMsg.status === 'SUCCESS' && blockMsg.response) req.blockedPid = owner;
    }

    this.requestQueue.push(req);
    this._log('INFO', 'IO_REQUEST_QUEUED', `${req.requestId} ${op} LBA ${targetLba} -> C${req.cylinder} H${req.track} S${req.sector} (${bytes} B)`, {
      pid: owner,
      metadata: { path }
    });
    return req;
  }

  /** EX-07.1: rechaza la petición sin mover el brazo ni iniciar el DMA. */
  _rejectRequest(reason, pid) {
    this.kernel.raiseInterrupt({
      irqCode: 'IRQ_DISK_ERROR',
      type: 'HARDWARE',
      priority: 1,
      sourceServer: SERVER_ENDPOINTS.IO_SERVER,
      targetPid: pid,
      description: reason
    });
    this._log('ERROR', 'IO_REQUEST_EINVAL', reason, { pid });
    throw ioError('-EINVAL', reason);
  }

  // ------------------------------------------------------------------ Planificación de brazo (RF-21)

  /**
   * Elige la siguiente petición según el algoritmo. `sweep` son los desplazamientos sin atender
   * (llegada al extremo en SCAN; extremo y retorno a 0 en C-SCAN), que también suman distancia.
   */
  _pickNext(pool, head, direction, algorithm = this.diskAlgorithm) {
    if (pool.length === 0) return null;
    const maxCylinder = this.geometry.cylinders - 1;
    const byArrival = (a, b) => (a.arrivalSeq ?? 0) - (b.arrivalSeq ?? 0);
    const nearest = (candidates, from) =>
      [...candidates].sort((a, b) => Math.abs(a.cylinder - from) - Math.abs(b.cylinder - from) || byArrival(a, b))[0];

    if (algorithm === 'FCFS') return { req: [...pool].sort(byArrival)[0], sweep: [], direction };
    if (algorithm === 'SSTF') return { req: nearest(pool, head), sweep: [], direction };

    if (algorithm === 'SCAN') {
      const ahead = pool.filter((r) => (direction === 'UP' ? r.cylinder >= head : r.cylinder <= head));
      if (ahead.length) return { req: nearest(ahead, head), sweep: [], direction };
      const edge = direction === 'UP' ? maxCylinder : 0;
      const reversed = direction === 'UP' ? 'DOWN' : 'UP';
      const sweep = edge === head ? [] : [{ cylinder: edge, label: `Extremo C${edge}: inversión a ${reversed}` }];
      return { req: nearest(pool, edge), sweep, direction: reversed };
    }

    // C-SCAN: atiende solo subiendo; al llegar a C_max-1 vuelve a 0 sin atender
    const ahead = pool.filter((r) => r.cylinder >= head);
    if (ahead.length) return { req: nearest(ahead, head), sweep: [], direction: 'UP' };
    const sweep = [];
    if (head !== maxCylinder) sweep.push({ cylinder: maxCylinder, label: `Extremo C${maxCylinder}` });
    sweep.push({ cylinder: 0, label: 'Retorno a C0 sin atender' });
    return { req: nearest(pool, 0), sweep, direction: 'UP' };
  }

  computeSchedulePlan(
    queue = this.requestQueue,
    startCylinder = this.currentHeadCylinder,
    direction = this.armDirection,
    algorithm = this.diskAlgorithm
  ) {
    const pool = [...queue];
    const order = [];
    const path = [{ cylinder: startCylinder, label: 'Inicio' }];
    let head = startCylinder;
    let dir = direction;
    let total = 0;

    while (pool.length > 0) {
      const pick = this._pickNext(pool, head, dir, algorithm);
      for (const stop of pick.sweep) {
        total += Math.abs(stop.cylinder - head);
        head = stop.cylinder;
        path.push(stop);
      }
      total += Math.abs(pick.req.cylinder - head);
      head = pick.req.cylinder;
      dir = pick.direction;
      path.push({ cylinder: head, label: pick.req.path ? `${pick.req.operation} ${pick.req.path}` : `C${head}` });
      order.push(pick.req);
      pool.splice(pool.indexOf(pick.req), 1);
    }

    return { algorithm, order, path, totalSeekDistance: total, finalHead: head, finalDirection: dir };
  }

  computeScheduleOrder(queue = this.requestQueue, startCylinder = this.currentHeadCylinder) {
    return this.computeSchedulePlan(queue, startCylinder).order;
  }

  /** RNF-08: misma cola y misma posición inicial, distancia total de cada algoritmo. */
  compareAlgorithms(queue = this.requestQueue, startCylinder = this.currentHeadCylinder) {
    return DISK_ALGORITHMS.map((algorithm) => {
      const plan = this.computeSchedulePlan(queue, startCylinder, this.armDirection, algorithm);
      return { algorithm, totalSeekDistance: plan.totalSeekDistance, sequence: plan.order.map((r) => r.cylinder) };
    });
  }

  _pushHistory(point) {
    this.headHistory.push(point);
    while (this.headHistory.length > 25) this.headHistory.shift();
  }

  // ------------------------------------------------------------------ Ciclo de reloj (CU-07 pasos 4-10)

  onClockTick(tick) {
    if (this.activeRequest && this.activeRequest.status === 'SEEKING') {
      this.positioningTicksLeft -= 1;
      if (this.positioningTicksLeft <= 0) this._programDMA(this.activeRequest, tick);
    } else if (this.activeRequest && this.activeRequest.status === 'TRANSFERRING') {
      if (this.dma.executeCycleStealingTick()) this._completeTransfer(this.activeRequest, tick);
    }

    // FA-07.2: la cola se reevalúa cada vez que el canal queda libre
    if (!this.activeRequest && this.requestQueue.length > 0) this._dispatchNext(tick);

    this.flushNetworkBuffers();

    return {
      currentHeadCylinder: this.currentHeadCylinder,
      dmaState: this.dma.state,
      pendingCount: this.requestQueue.length
    };
  }

  _dispatchNext(tick) {
    const pick = this._pickNext(this.requestQueue, this.currentHeadCylinder, this.armDirection);
    const req = pick.req;
    let travelled = 0;

    for (const stop of pick.sweep) {
      const d = Math.abs(stop.cylinder - this.currentHeadCylinder);
      travelled += d;
      this.currentHeadCylinder = stop.cylinder;
      this._pushHistory({ tick, cylinder: stop.cylinder, seekDelta: d, algorithm: this.diskAlgorithm, path: stop.label });
    }

    const delta = Math.abs(req.cylinder - this.currentHeadCylinder);
    travelled += delta;
    this.currentHeadCylinder = req.cylinder;
    this.armDirection = pick.direction;
    this.totalSeekDistance += travelled;
    this.requestQueue.splice(this.requestQueue.indexOf(req), 1);

    req.status = 'SEEKING';
    req.dispatchTick = tick;
    req.seekDistance = travelled;
    req.accessTimeMs = this.geometry.calculateAccessTimeMs(travelled);
    this.positioningTicksLeft = Math.max(1, Math.ceil(req.accessTimeMs / MS_PER_TICK));
    this.activeRequest = req;

    this._pushHistory({ tick, cylinder: req.cylinder, seekDelta: delta, algorithm: this.diskAlgorithm, path: `${req.operation} ${req.path}` });
    this._log(
      'INFO',
      'IO_ARM_DISPATCH',
      `${this.diskAlgorithm}: cabezal -> C${req.cylinder} H${req.track} S${req.sector} (${travelled} cilindros, ${req.accessTimeMs.toFixed(2)} ms)`,
      { pid: req.pid, metadata: { requestId: req.requestId, lba: req.lba } }
    );
  }

  _resolveRamAddress(req) {
    if (req.pid === null || req.pid === undefined) {
      if (KERNEL_IO_BUFFER + req.byteCount > KERNEL_IO_BUFFER_END) {
        return { ok: false, reason: `${req.byteCount} B exceden el buffer de E/S del kernel` };
      }
      return { ok: true, address: KERNEL_IO_BUFFER };
    }
    const msg = this.kernel.sendIPC({
      sender: SERVER_ENDPOINTS.IO_SERVER,
      receiver: SERVER_ENDPOINTS.MEMORY_SERVER,
      action: 'MEM_QUERY_REGION',
      payload: { pid: req.pid }
    });
    const region = msg.status === 'SUCCESS' ? msg.response : null;
    if (!region) return { ok: false, reason: `P${req.pid} no tiene región de memoria asignada en MEMORY_SERVER` };

    const address = req.targetMemoryAddress ?? region.baseBytes;
    if (address < region.baseBytes || address + req.byteCount > region.limitBytes) {
      return {
        ok: false,
        reason: `Buffer DMA [${hex(address)}, ${hex(address + req.byteCount)}) fuera de ${region.partitionId} de P${req.pid} [${hex(region.baseBytes)}, ${hex(region.limitBytes)})`
      };
    }
    return { ok: true, address };
  }

  _programDMA(req, tick) {
    if (this.dma.state === 'COMPLETED' || this.dma.state === 'FAULT') this.dma.reset();

    const target = this._resolveRamAddress(req);
    if (!target.ok) {
      this._failTransfer(req, tick, target.reason);
      return;
    }

    const deviceAddress = req.lba * this.geometry.sectorSize;
    const toDisk = req.operation === 'WRITE';
    this.dma.configureChannel({
      sar: toDisk ? target.address : deviceAddress,
      dar: toDisk ? deviceAddress : target.address,
      bcr: req.byteCount,
      mode: req.operation,
      req,
      ramAddress: target.address
    });
    this.dma.startTransfer();
    req.status = 'TRANSFERRING';
    req.targetMemoryAddress = target.address;
    this._log('INFO', 'DMA_PROGRAMMED', `${req.requestId}: ${req.byteCount} B, ${toDisk ? 'RAM -> disco' : 'disco -> RAM'}`, {
      pid: req.pid,
      metadata: this.dma.getRegisters()
    });
  }

  /** Despierta al proceso solo si esta era su última petición bloqueante pendiente. */
  _pidToWake(req) {
    const pid = req.blockedPid;
    if (!pid) return null;
    const stillWaiting =
      this.requestQueue.some((r) => r.blockedPid === pid) || (this.activeRequest && this.activeRequest.blockedPid === pid);
    return stillWaiting ? null : pid;
  }

  _archive(req) {
    if (req.status === 'COMPLETED') {
      this.stats.served += 1;
      this.stats.latencyTicksSum += req.getServiceLatencyTicks() ?? 0;
    } else {
      this.stats.failed += 1;
    }
    this.completedRequests.unshift(req);
    if (this.completedRequests.length > 30) this.completedRequests.pop();
  }

  /** EX-07.2: dirección RAM fuera del espacio del proceso. */
  _failTransfer(req, tick, reason) {
    this.dma.abort(reason, req);
    req.status = 'FAILED';
    req.errorCode = 'DMA_MEM_FAULT';
    req.completionTick = tick;
    this.activeRequest = null;
    this._archive(req);
    this.kernel.raiseInterrupt({
      irqCode: 'IRQ_DMA_FAULT',
      type: 'HARDWARE',
      priority: 0,
      sourceServer: SERVER_ENDPOINTS.IO_SERVER,
      targetPid: this._pidToWake(req),
      description: `DMA_MEM_FAULT: ${reason}`,
      data: { requestId: req.requestId, pid: req.pid, reason }
    });
    this._log('SECURITY_ALERT', 'DMA_MEM_FAULT', reason, { pid: req.pid, metadata: { requestId: req.requestId } });
  }

  _completeTransfer(req, tick) {
    if (req.operation === 'WRITE') this._writeSectors(req, tick);
    else req.readData = this._readSectors(req);

    req.status = 'COMPLETED';
    req.completionTick = tick;
    this.activeRequest = null;
    this._archive(req);

    this.kernel.raiseInterrupt({
      irqCode: 'IRQ_DMA_DONE',
      type: 'HARDWARE',
      priority: 1,
      sourceServer: SERVER_ENDPOINTS.IO_SERVER,
      targetPid: this._pidToWake(req),
      description: `DMA ${req.operation} ${req.path}: ${req.byteCount} B (${req.operation === 'READ' ? 'disco -> RAM' : 'RAM -> disco'} ${hex(req.targetMemoryAddress)})`,
      data: { requestId: req.requestId, pid: req.pid, lba: req.lba }
    });
    this._log('INFO', 'IRQ_DMA_DONE', `${req.requestId} completada en ${req.getServiceLatencyTicks()} ticks`, {
      pid: req.pid,
      metadata: { lba: req.lba, sectors: req.sectorCount }
    });
  }

  /** ISR del kernel -> IO_SERVER: libera el canal tras IRQ_DMA_DONE / IRQ_DMA_FAULT. */
  acknowledgeInterrupt({ requestId } = {}) {
    const current = this.dma.currentTransferRequest;
    if (current && current.requestId === requestId && (this.dma.state === 'COMPLETED' || this.dma.state === 'FAULT')) {
      this.dma.reset();
    }
    return { acknowledged: requestId ?? null, dmaState: this.dma.state };
  }

  // ------------------------------------------------------------------ Sectores (DISK_SECTORS)

  _writeSectors(req, tick) {
    const g = this.geometry;
    const bytes = Array.isArray(req.data)
      ? Uint8Array.from(req.data)
      : encoder.encode(req.data ?? `${req.operation} ${req.path} @T${tick}`);
    for (let i = 0; i < req.sectorCount; i++) {
      const lba = req.lba + i;
      const chunk = bytes.slice(i * g.sectorSize, (i + 1) * g.sectorSize);
      this.sectorTable.set(lba, {
        disk_id: g.diskId,
        lba,
        ...g.lbaToCHS(lba),
        raw_data_bytes: Array.from(chunk),
        checksum_crc32: crc32(chunk),
        last_written_at: new Date().toISOString()
      });
    }
  }

  _readSectors(req) {
    const chunks = [];
    for (let i = 0; i < req.sectorCount; i++) {
      const rec = this.sectorTable.get(req.lba + i);
      if (!rec) continue;
      const bytes = Uint8Array.from(rec.raw_data_bytes);
      if (crc32(bytes) !== rec.checksum_crc32) {
        req.errorCode = '-EIO';
        this._log('ERROR', 'SECTOR_CRC_MISMATCH', `LBA ${rec.lba} con CRC32 inválido`, { pid: req.pid });
        continue;
      }
      chunks.push(bytes);
    }
    return decoder.decode(concatBytes(chunks));
  }

  restoreSectors(records = []) {
    let corrupted = 0;
    for (const rec of records) {
      if (rec.disk_id !== this.geometry.diskId || !this.geometry.validateLBA(rec.lba)) continue;
      if (crc32(Uint8Array.from(rec.raw_data_bytes || [])) !== rec.checksum_crc32) {
        corrupted += 1;
        continue;
      }
      this.sectorTable.set(rec.lba, rec);
    }
    if (corrupted) {
      this._log('ERROR', 'SECTOR_CRC_MISMATCH', `${corrupted} sector(es) descartados al hidratar (CRC32 inválido)`);
    }
    return { loaded: this.sectorTable.size, corrupted };
  }

  // ------------------------------------------------------------------ Lote comparativo

  /**
   * Atiende toda la cola en el mismo tick para comparar algoritmos. No usa el canal DMA;
   * los procesos bloqueados por estas peticiones se despiertan con IRQ_DMA_DONE.
   */
  executeFullScheduleSimulation() {
    const tick = this.kernel.clock.currentTick;
    const plan = this.computeSchedulePlan();

    let prev = this.currentHeadCylinder;
    for (const stop of plan.path.slice(1)) {
      this._pushHistory({ tick, cylinder: stop.cylinder, seekDelta: Math.abs(stop.cylinder - prev), algorithm: this.diskAlgorithm, path: stop.label });
      prev = stop.cylinder;
    }
    this.totalSeekDistance += plan.totalSeekDistance;
    this.currentHeadCylinder = plan.finalHead;
    this.armDirection = plan.finalDirection;
    this.requestQueue = [];

    const pidsToWake = new Set();
    for (const req of plan.order) {
      if (req.operation === 'WRITE') this._writeSectors(req, tick);
      else req.readData = this._readSectors(req);
      req.status = 'COMPLETED';
      req.completionTick = tick;
      req.seekDistance = 0;
      this._archive(req);
      if (req.blockedPid && !(this.activeRequest && this.activeRequest.blockedPid === req.blockedPid)) {
        pidsToWake.add(req.blockedPid);
      }
    }
    for (const pid of pidsToWake) {
      this.kernel.raiseInterrupt({
        irqCode: 'IRQ_DMA_DONE',
        type: 'HARDWARE',
        priority: 1,
        sourceServer: SERVER_ENDPOINTS.IO_SERVER,
        targetPid: pid,
        description: `Lote ${this.diskAlgorithm} completado`,
        data: { requestId: null }
      });
    }

    this._log('INFO', 'IO_BATCH_EXECUTED', `${plan.order.length} peticiones con ${this.diskAlgorithm}: ${plan.totalSeekDistance} cilindros`, {
      metadata: { sequence: plan.path.map((p) => p.cylinder) }
    });

    return {
      servedCount: plan.order.length,
      totalSeekDistance: plan.totalSeekDistance,
      accumulatedSeekDistance: this.totalSeekDistance,
      path: plan.path,
      headHistory: this.headHistory
    };
  }

  // ------------------------------------------------------------------ Red simulada (RF-23, CU-08)

  _findListeningSocket(port) {
    return this.sockets.find((s) => s.localPort === Number(port) && s.state !== 'CLOSED');
  }

  createSocket({
    ownerPid = null,
    localPort,
    remotePort = null,
    protocol = 'TCP_SIM',
    blockingMode = false,
    bufferCapacityBytes = 256,
    capacity = 8,
    mtu = 32
  } = {}) {
    const port = Number(localPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw ioError('-EINVAL', `Puerto inválido: ${localPort}`);
    if (this._findListeningSocket(port)) throw ioError('-EADDRINUSE', `Puerto ${port} ya está en uso`);

    const sock = new SimulatedSocket({
      id: `SOCK-${String(++this._seq.socket).padStart(2, '0')}`,
      ownerPid,
      localPort: port,
      remotePort,
      protocol,
      blockingMode,
      bufferCapacityBytes,
      capacity,
      mtu
    });
    this.sockets.push(sock);
    this._log('INFO', 'NET_BIND', `${sock.id} ${sock.protocol} en :${port} (${sock.state})`, { pid: ownerPid });
    return sock;
  }

  sendNetworkPacket({ sourceSocketId = 'SOCK-01', destPort = null, payload = 'PING_IPC_PACKET', pid = null } = {}) {
    const src = this.sockets.find((s) => s.id === sourceSocketId);
    if (!src || src.state === 'CLOSED') throw ioError('-ENOTCONN', `Socket ${sourceSocketId} inexistente o cerrado`);

    const port = Number(destPort ?? src.remotePort);
    const dst = this._findListeningSocket(port);
    if (!dst) {
      src.droppedPacketsCount += 1;
      this._log('WARN', 'NET_ECONNREFUSED', `${src.id} -> :${port} sin socket escuchando`, { pid: src.ownerPid });
      throw ioError('-ECONNREFUSED', `No hay socket escuchando en :${port}`);
    }

    const message = String(payload);
    const bytes = encoder.encode(message);
    if (bytes.length > Math.min(src.bufferCapacityBytes, dst.bufferCapacityBytes)) {
      throw ioError('-EMSGSIZE', `${bytes.length} B superan la capacidad de buffer (${Math.min(src.bufferCapacityBytes, dst.bufferCapacityBytes)} B)`);
    }

    // FA-08.2: fragmentación por MTU
    const fragCount = Math.max(1, Math.ceil(bytes.length / src.mtu));
    if (!src.hasSpaceInTX(bytes.length, fragCount)) {
      if (src.blockingMode && pid) {
        const blockMsg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.IO_SERVER,
          receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
          action: 'PROC_BLOCK_IO',
          payload: { pid, reason: `WAIT_TX_BUFFER en ${src.id}` }
        });
        if (blockMsg.response) {
          src.sendWaiters.push(pid);
          this._log('WARN', 'NET_TX_BLOCKED', `P${pid} bloqueado: TX lleno en ${src.id}`, { pid });
          return { status: 'BLOCKED', socketId: src.id, pid, payload: message };
        }
      }
      this._log('WARN', 'NET_TX_BUFFER_FULL', `TX lleno en ${src.id}`, { pid: src.ownerPid });
      throw ioError(
        '-ENOBUFS',
        `Buffer TX lleno en ${src.id} (${src.txUsedBytes}/${src.bufferCapacityBytes} B, ${src.txBuffer.length}/${src.capacity} paquetes)`
      );
    }

    const messageId = `MSG-${String(++this._seq.message).padStart(4, '0')}`;
    for (let i = 0; i < fragCount; i++) {
      const chunk = bytes.slice(i * src.mtu, (i + 1) * src.mtu);
      src.enqueueTX({
        id: `PKT-${String(++this._seq.packet).padStart(4, '0')}`,
        messageId,
        fragIndex: i,
        fragCount,
        seqNumber: src.nextSeqNumber++,
        protocol: src.protocol,
        fromPid: src.ownerPid,
        toPid: dst.ownerPid,
        srcPort: src.localPort,
        dstPort: dst.localPort,
        payload: decoder.decode(chunk),
        bytes: Array.from(chunk),
        payloadSize: chunk.length,
        checksum: crc32(chunk),
        tick: this.kernel.clock.currentTick,
        status: 'IN_TX_BUFFER'
      });
    }
    src.totalBytesSent += bytes.length;
    this._log('INFO', 'NET_SEND', `${messageId}: ${bytes.length} B en ${fragCount} paquete(s) ${src.id} -> :${dst.localPort}`, { pid: src.ownerPid });

    return {
      id: messageId,
      status: 'IN_TX_BUFFER',
      socketId: src.id,
      payload: message,
      fragments: fragCount,
      sizeBytes: bytes.length,
      fromPid: src.ownerPid,
      toPid: dst.ownerPid,
      dstPort: dst.localPort
    };
  }

  /** Transmite el paquete en la cabeza del TX de `src`. Devuelve 'DELIVERED' | 'DROPPED' | 'BACKPRESSURE' | null. */
  _transmitHead(src) {
    const pkt = src.txBuffer[0];
    if (!pkt) return null;

    const dst = this._findListeningSocket(pkt.dstPort);
    if (!dst) {
      src.dequeueTX();
      src.droppedPacketsCount += 1;
      pkt.status = 'DROPPED_ECONNREFUSED';
      this._log('WARN', 'NET_ECONNREFUSED', `${pkt.id} descartado: no hay socket activo en :${pkt.dstPort}`, { pid: pkt.fromPid });
      this._wakeSender(src);
      return 'DROPPED';
    }

    if (!dst.hasSpaceInRX(pkt.payloadSize)) {
      if (pkt.protocol === 'UDP_SIM') {
        src.dequeueTX();
        dst.droppedPacketsCount += 1;
        pkt.status = 'DROPPED_RX_OVERFLOW';
        this._log('WARN', 'NET_RX_OVERFLOW', `${pkt.id} descartado: RX lleno en ${dst.id} (UDP_SIM)`, { pid: pkt.fromPid });
        this._wakeSender(src);
        return 'DROPPED';
      }
      if (pkt.status !== 'BACKPRESSURE') {
        pkt.status = 'BACKPRESSURE';
        this._log('WARN', 'NET_BACKPRESSURE', `${pkt.id} retenido: RX lleno en ${dst.id} (TCP_SIM)`, { pid: pkt.fromPid });
      }
      return 'BACKPRESSURE';
    }

    src.dequeueTX();
    pkt.status = 'DELIVERED_RX';
    dst.enqueueRX(pkt);
    dst.deliveredPackets.unshift(pkt);
    if (dst.deliveredPackets.length > 20) dst.deliveredPackets.pop();
    this._wakeSender(src);

    const messageComplete = dst.rxBuffer.filter((p) => p.messageId === pkt.messageId).length === pkt.fragCount;
    this.kernel.raiseInterrupt({
      irqCode: 'IRQ_NET_RX',
      type: 'HARDWARE',
      priority: 2,
      sourceServer: SERVER_ENDPOINTS.IO_SERVER,
      targetPid: messageComplete ? (dst.recvWaiters.shift() ?? null) : null,
      description: `${pkt.id} (${pkt.fragIndex + 1}/${pkt.fragCount}) en RX de ${dst.id}`,
      data: { socketId: dst.id, packetId: pkt.id }
    });
    return 'DELIVERED';
  }

  _wakeSender(src) {
    if (src.sendWaiters.length === 0 || !src.hasSpaceInTX(1)) return;
    this.kernel.raiseInterrupt({
      irqCode: 'IRQ_NET_TX_READY',
      type: 'HARDWARE',
      priority: 2,
      sourceServer: SERVER_ENDPOINTS.IO_SERVER,
      targetPid: src.sendWaiters.shift(),
      description: `Ventana TX liberada en ${src.id}`
    });
  }

  /** Un paquete por socket y por tick (latencia de enlace = 1 tick). */
  flushNetworkBuffers() {
    for (const src of this.sockets) this._transmitHead(src);
    return this.sockets;
  }

  receivePacket({ socketId, pid = null, blocking = null } = {}) {
    const sock = this.sockets.find((s) => s.id === socketId);
    if (!sock) throw ioError('-ENOTCONN', `Socket ${socketId} inexistente`);

    const head = sock.rxBuffer[0];
    const parts = head ? sock.rxBuffer.filter((p) => p.messageId === head.messageId) : [];
    if (!head || parts.length < head.fragCount) {
      const peer = this.sockets.find((s) => s !== sock && s.localPort === sock.remotePort);
      if (sock.state === 'CLOSED' || (peer && peer.state === 'CLOSED')) {
        return { status: 'EOF', socketId, bytes: 0 };
      }
      if ((blocking ?? sock.blockingMode) && pid) {
        const blockMsg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.IO_SERVER,
          receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
          action: 'PROC_BLOCK_IO',
          payload: { pid, reason: `recv() en ${sock.id}: esperando IRQ_NET_RX` }
        });
        if (blockMsg.response) {
          sock.recvWaiters.push(pid);
          return { status: 'BLOCKED', socketId, pid };
        }
      }
      throw ioError('-EAGAIN', `RX de ${sock.id} sin mensajes completos`);
    }

    sock.removeRX(parts);
    parts.sort((a, b) => a.fragIndex - b.fragIndex);

    // EX-08.3: verificación de checksum por fragmento
    const corrupted = parts.find((p) => crc32(Uint8Array.from(p.bytes)) !== p.checksum);
    if (corrupted) {
      sock.droppedPacketsCount += parts.length;
      this._log('ERROR', 'NET_CHECKSUM_ERR', `${corrupted.id} corrupto en ${sock.id}`, { pid: sock.ownerPid });
      throw ioError(
        'CHECKSUM_ERR',
        `Paquete ${corrupted.id} descartado${corrupted.protocol === 'TCP_SIM' ? '; se solicita retransmisión' : ''}`
      );
    }

    const bytes = concatBytes(parts.map((p) => Uint8Array.from(p.bytes)));
    const payload = decoder.decode(bytes);
    this._log('INFO', 'NET_RECV', `${head.messageId}: ${bytes.length} B entregados por ${sock.id}`, { pid: pid ?? sock.ownerPid });
    return {
      status: 'DELIVERED',
      socketId,
      messageId: head.messageId,
      payload,
      bytes: bytes.length,
      fromPid: head.fromPid,
      fragments: parts.length
    };
  }

  /** FA-08.3: drena TX, marca CLOSED y despierta con EOF a quien espere lectura. */
  closeSocket({ socketId } = {}) {
    const sock = this.sockets.find((s) => s.id === socketId);
    if (!sock || sock.state === 'CLOSED') throw ioError('-ENOTCONN', `Socket ${socketId} inexistente o ya cerrado`);

    let drained = 0;
    while (sock.txBuffer.length > 0) {
      if (this._transmitHead(sock) === 'BACKPRESSURE') {
        sock.droppedPacketsCount += sock.txBuffer.length;
        while (sock.txBuffer.length) sock.dequeueTX();
        break;
      }
      drained += 1;
    }
    sock.close();

    const peer = this.sockets.find((s) => s !== sock && s.localPort === sock.remotePort);
    const waiters = [...sock.recvWaiters.splice(0), ...(peer ? peer.recvWaiters.splice(0) : [])];
    for (const pid of waiters) {
      this.kernel.raiseInterrupt({
        irqCode: 'IRQ_NET_RX',
        type: 'HARDWARE',
        priority: 2,
        sourceServer: SERVER_ENDPOINTS.IO_SERVER,
        targetPid: pid,
        description: `FIN de ${sock.id}: recv() retorna EOF`
      });
    }
    this._log('INFO', 'NET_CLOSE', `${sock.id} cerrado (${drained} paquetes drenados)`, { pid: sock.ownerPid });
    return { status: 'CLOSED', socketId: sock.id, drainedPackets: drained };
  }

  // ------------------------------------------------------------------ Persistencia (RF-24)

  exportState({ includeSectors = true } = {}) {
    return {
      disk_config: this.getDiskConfigRecord(),
      total_seek_distance: this.totalSeekDistance,
      pending_requests: this.requestQueue.map((r) => ({ ...r, blockedPid: null })),
      disk_sectors: includeSectors ? [...this.sectorTable.values()] : [],
      system_logs: this.systemLogs.slice(0, 100),
      sockets: this.sockets.map((s) => ({ ...s, recvWaiters: [], sendWaiters: [] }))
    };
  }

  restoreState(state) {
    const cfg = state && state.disk_config;
    if (!cfg) return false;

    this.geometry = new DiskGeometry({
      diskId: cfg.disk_id,
      mediaType: cfg.media_type,
      cylinders: cfg.cylinders,
      tracksPerCylinder: cfg.tracks_per_cylinder,
      sectorsPerTrack: cfg.sectors_per_track,
      sectorSize: cfg.sector_size_bytes,
      rpm: cfg.rpm,
      seekTimePerCylinderMs: cfg.seek_time_ms
    });
    this.dma.reset();
    this.dma.bytesTransferredPerTick = this.geometry.sectorSize;
    if (DISK_ALGORITHMS.includes(cfg.active_scheduler)) this.diskAlgorithm = cfg.active_scheduler;
    this.currentHeadCylinder = Math.min(Number(cfg.current_head_cylinder) || 0, this.geometry.cylinders - 1);
    this.armDirection = cfg.head_direction === 'DOWN' ? 'DOWN' : 'UP';
    this.totalSeekDistance = Number(state.total_seek_distance) || 0;
    this.activeRequest = null;
    this.headHistory = [
      { tick: this.kernel.clock.currentTick, cylinder: this.currentHeadCylinder, seekDelta: 0, algorithm: 'RESTORE', path: 'Estado restaurado' }
    ];

    // Los PCB no se persisten: las peticiones restauradas pasan a ser del sistema (buffer de kernel)
    this.requestQueue = (state.pending_requests || [])
      .filter((r) => this.geometry.validateLBA(r.lba, r.sectorCount))
      .map((r) => new DiskRequest({ ...r, pid: null, blockedPid: null, targetMemoryAddress: null }));

    this.sectorTable.clear();
    this.restoreSectors(state.disk_sectors || []);
    this.systemLogs = (state.system_logs || []).slice(0, 200);

    if (Array.isArray(state.sockets) && state.sockets.length) {
      this.sockets = state.sockets.map((s) => Object.assign(new SimulatedSocket(s), s, { recvWaiters: [], sendWaiters: [] }));
    }

    this._seq.request = Math.max(this._seq.request, maxSuffix(this.requestQueue.map((r) => r.requestId)));
    this._seq.log = Math.max(this._seq.log, maxSuffix(this.systemLogs.map((l) => l.log_id)));
    this._seq.socket = Math.max(this._seq.socket, maxSuffix(this.sockets.map((s) => s.id)));

    this._log('INFO', 'IO_STATE_RESTORED', `Disco ${cfg.disk_id} restaurado: ${this.requestQueue.length} peticiones, ${this.sectorTable.size} sectores`);
    return true;
  }
}
