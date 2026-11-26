/**
 * @file verify_minikernel.js
 * @description Suite de verificación automatizada de los 5 módulos del Minikernel,
 *              algoritmos matemáticos, bus IPC y consistencia de IDs del DOM en index.html.
 */

import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Kernel } from '../src/core/Kernel.js';
import { SERVER_ENDPOINTS, SYSCALL_ACTIONS } from '../src/core/IPCMessage.js';
import { ProcessManager } from '../src/servers/ProcessManager.js';
import { MemoryManager } from '../src/servers/MemoryManager.js';
import { FileManager } from '../src/servers/FileManager.js';
import { DeviceDriver, crc32 } from '../src/servers/DeviceDriver.js';
import { SecurityController } from '../src/servers/SecurityController.js';
import { PersistenceStore } from '../src/persistence/PersistenceStore.js';

const kernel = new Kernel({ clockIntervalMs: 500, contextSwitchTicks: 1 });
const security = new SecurityController(kernel);
assert.equal(security.hasActiveSession(), false, 'La Terminal Web debe nacer bloqueada');
const memory = new MemoryManager(kernel);
const fileManager = new FileManager(kernel);
const io = new DeviceDriver(kernel);
const proc = new ProcessManager(kernel);
const store = new PersistenceStore();

// 1. Verificar Módulo 2.1 (Procesos, RR, Prioridades, SRTF, Context Switch y Banquero)
const f1 = kernel.sendIPC({
  sender: SERVER_ENDPOINTS.KERNEL,
  receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
  action: SYSCALL_ACTIONS.SYS_FORK,
  payload: { name: 'proc_alpha', priority: 3, burstTime: 5, memorySizeKB: 128 }
});
assert.equal(f1.status, 'SUCCESS');

const f2 = kernel.sendIPC({
  sender: SERVER_ENDPOINTS.KERNEL,
  receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
  action: SYSCALL_ACTIONS.SYS_FORK,
  payload: { name: 'proc_beta', priority: 1, burstTime: 3, memorySizeKB: 64 }
});
assert.equal(f2.status, 'SUCCESS');

for (let t = 0; t < 4; t++) kernel.clock.step();
assert.ok(kernel.totalContextSwitches >= 1, 'Debe registrar cambios de contexto');

// Probar cambio a Prioridades Apropiativas y SRTF
proc.setSchedulerConfig('PRIORITY_PREEMPTIVE', 3);
kernel.clock.step();
proc.setSchedulerConfig('SRTF', 3);
kernel.clock.step();

// Probar Algoritmo del Banquero (Estado Seguro vs Inseguro)
const safeReq = proc.banker.requestResources(102, [1, 0, 2]);
assert.equal(safeReq.granted, true);
assert.equal(safeReq.isSafe, true);

const unsafeReq = proc.banker.requestResources(101, [3, 3, 0]);
assert.equal(unsafeReq.granted, false);

// 2. Verificar Módulo 2.2 (Memoria Estática/Dinámica y Fragmentación)
const fragDyn = memory.calculateFragmentation();
assert.equal(fragDyn.internalFragmentationKB, 0, 'En memoria dinámica la fragmentación interna es 0 KB');

// Para cambiar de esquema no debe haber procesos con memoria asignada
for (const part of memory.partitions.filter((p) => !p.isKernel && p.isOccupied)) memory.freeMemory(part.allocatedPid);
assert.throws(() => { memory.allocateMemory(5001, 'x', 64); memory.reconfigureMemory('STATIC_FIXED'); }, /ERR_SCHEME_CHANGE_BLOCKED/);
memory.freeMemory(5001);
memory.reconfigureMemory('STATIC_FIXED', 'BEST_FIT');
memory.verifyInvariants();
const allocFixed = memory.allocateMemory(999, 'fixed_test', 100);
assert.equal(allocFixed.allocated, true);
assert.ok(allocFixed.fragmentation.internalFragmentationKB > 0, 'En particiones fijas debe reportar fragmentación interna');

// 3. Verificar Módulo 2.3 (Sistema de Archivos FAT e Inodos y CRUD)
fileManager.formatFileSystem('INODES', 1024);
const createdFile = fileManager.createNode({
  parentPath: '/home',
  name: 'test_inode.txt',
  type: 'FILE',
  content: 'Prueba de Inodo Simulado'
});
assert.ok(createdFile.inodeNumber >= 1);
fileManager.writeFile('/home/test_inode.txt', 'Contenido actualizado en inodo');
fileManager.renameNode('/home/test_inode.txt', 'renamed_inode.txt');
assert.equal(fileManager.readFile('/home/renamed_inode.txt').content, 'Contenido actualizado en inodo');
fileManager.deleteNode('/home/renamed_inode.txt');

// 4. Módulo 2.4: geometría, planificación, DMA con IRQ, sockets y persistencia
const geo = io.geometry;
for (const lba of [0, 511, 5120, geo.getTotalSectors() - 1]) {
  const chs = geo.lbaToCHS(lba);
  assert.equal(geo.chsToLBA(chs.cylinder, chs.track, chs.sector), lba, 'LBA <-> CHS debe ser biyectivo');
}

const sample = [{ id: '1', cylinder: 95 }, { id: '2', cylinder: 180 }, { id: '3', cylinder: 34 }];
const expectedSeek = { FCFS: 276, SSTF: 162, SCAN: 314, 'C-SCAN': 382 };
for (const algo of Object.keys(expectedSeek)) {
  io.updateDiskConfig({ algorithm: algo, headCylinder: 50, direction: 'UP' });
  assert.equal(io.computeScheduleOrder(sample, 50).length, 3);
  assert.equal(io.computeSchedulePlan(sample, 50, 'UP', algo).totalSeekDistance, expectedSeek[algo], `Seek total ${algo}`);
}

const ioReq = (payload) =>
  kernel.sendIPC({ sender: SERVER_ENDPOINTS.KERNEL, receiver: SERVER_ENDPOINTS.IO_SERVER, action: SYSCALL_ACTIONS.SYS_IO_DISK_REQ, payload });

const badReq = ioReq({ cylinder: 999, operation: 'READ' });
assert.equal(badReq.status, 'REJECTED');
assert.match(badReq.errorReason, /-EINVAL/);
assert.ok(kernel.interruptController.irqQueue.some((irq) => irq.irqCode === 'IRQ_DISK_ERROR'));

kernel.sendIPC({ sender: SERVER_ENDPOINTS.KERNEL, receiver: SERVER_ENDPOINTS.IO_SERVER, action: 'EXEC_DISK_BATCH' });
const ioProc = kernel.sendIPC({
  sender: SERVER_ENDPOINTS.KERNEL,
  receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
  action: SYSCALL_ACTIONS.SYS_FORK,
  payload: { name: 'io_worker', priority: 5, burstTime: 30, memorySizeKB: 64 }
}).response;
const writeReq = ioReq({ cylinder: 10, track: 0, sector: 1, operation: 'WRITE', data: 'DMA_TEST', byteCount: 8, pid: ioProc.pid, blockProcess: true }).response;
assert.equal(proc.pcbTable.get(ioProc.pid).state, 'BLOCKED');
for (let t = 0; t < 60 && proc.pcbTable.get(ioProc.pid).state === 'BLOCKED'; t++) kernel.clock.step();
assert.equal(writeReq.status, 'COMPLETED');
assert.notEqual(proc.pcbTable.get(ioProc.pid).state, 'BLOCKED', 'IRQ_DMA_DONE debe desbloquear al proceso');
assert.equal(io.sectorTable.get(writeReq.lba).checksum_crc32, crc32(new TextEncoder().encode('DMA_TEST')));

const faultReq = ioReq({ cylinder: 20, operation: 'READ', pid: 4242 }).response;
for (let t = 0; t < 30 && faultReq.status !== 'FAILED'; t++) kernel.clock.step();
assert.equal(faultReq.errorCode, 'DMA_MEM_FAULT');
kernel.clock.step();
assert.ok(security.auditLogs.some((l) => l.eventType === 'DMA_MEMORY_VIOLATION'));

const pkt = io.sendNetworkPacket({ sourceSocketId: 'SOCK-01', payload: 'HELLO_MINIKERNEL' });
assert.equal(pkt.payload, 'HELLO_MINIKERNEL');
io.flushNetworkBuffers();
assert.ok(io.sockets[1].rxBuffer.length >= 1);
assert.equal(io.receivePacket({ socketId: 'SOCK-02' }).payload, 'HELLO_MINIKERNEL');

const longMsg = 'X'.repeat(70);
assert.equal(io.sendNetworkPacket({ sourceSocketId: 'SOCK-01', payload: longMsg }).fragments, 3);
for (let i = 0; i < 3; i++) io.flushNetworkBuffers();
assert.equal(io.receivePacket({ socketId: 'SOCK-02' }).payload, longMsg, 'Reensamblaje por MTU');

const refused = kernel.sendIPC({
  sender: SERVER_ENDPOINTS.KERNEL,
  receiver: SERVER_ENDPOINTS.IO_SERVER,
  action: SYSCALL_ACTIONS.SYS_NET_SEND,
  payload: { sourceSocketId: 'SOCK-01', destPort: 7777, payload: 'x' }
});
assert.match(refused.errorReason, /-ECONNREFUSED/);

const restoredIO = new DeviceDriver(new Kernel());
assert.ok(restoredIO.restoreState(io.exportState()));
assert.equal(restoredIO.sectorTable.get(writeReq.lba).checksum_crc32, io.sectorTable.get(writeReq.lba).checksum_crc32);
assert.equal(restoredIO.diskAlgorithm, io.diskAlgorithm);

// 5. Verificar Módulo 2.5 (Seguridad, Perfiles, ACL y Logs Inmutables)
security.authenticate('guest', 'guest');
const guestFormat = kernel.sendIPC({
  sender: SERVER_ENDPOINTS.KERNEL,
  receiver: SERVER_ENDPOINTS.FS_SERVER,
  action: SYSCALL_ACTIONS.SYS_FORMAT_FS,
  payload: { formatType: 'FAT', blockSizeBytes: 1024 }
});
assert.equal(guestFormat.status, 'REJECTED', 'GUEST no puede formatear el sistema de archivos');
assert.ok(Object.isFrozen(security.auditLogs[0]), 'Cada SecurityAuditLog debe ser inmutable');

// Compuerta de la Terminal Web: sólo el botón del panel 2.5 la habilita.
const panelLogin = kernel.sendIPC({
  sender: SERVER_ENDPOINTS.KERNEL,
  receiver: SERVER_ENDPOINTS.SECURITY_SERVER,
  action: SYSCALL_ACTIONS.SYS_AUTH_LOGIN,
  payload: { username: 'root', password: 'root', source: 'SECURITY_PANEL_LOGIN' }
});
assert.equal(panelLogin.status, 'SUCCESS');
assert.equal(security.hasActiveSession(), true, 'El login del panel 2.5 habilita la terminal');

const topBarLogin = kernel.sendIPC({
  sender: SERVER_ENDPOINTS.KERNEL,
  receiver: SERVER_ENDPOINTS.SECURITY_SERVER,
  action: SYSCALL_ACTIONS.SYS_AUTH_LOGIN,
  payload: { username: 'guest', password: 'guest', source: 'TOP_BAR_SESSION' }
});
assert.equal(topBarLogin.status, 'SUCCESS');
assert.equal(security.hasActiveSession(), false, 'El selector superior no habilita la terminal');

const terminalDenied = kernel.sendIPC({
  sender: SERVER_ENDPOINTS.KERNEL,
  receiver: SERVER_ENDPOINTS.SECURITY_SERVER,
  action: 'SEC_TERMINAL_ACCESS_DENIED',
  payload: { command: 'whoami' }
});
assert.equal(terminalDenied.status, 'SUCCESS');
assert.equal(security.auditLogs[0].eventType, 'TERMINAL_ACCESS_DENIED');

// 6. Verificar correspondencia de todos los IDs de DOM entre index.html y AppController.js
const html = fs.readFileSync('./index.html', 'utf8');
const controllerCode = fs.readFileSync('./src/ui/AppController.js', 'utf8');
const idMatches = [...controllerCode.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
for (const id of idMatches) {
  assert.ok(html.includes(`id="${id}"`), `ID "${id}" referenciado en AppController.js debe existir en index.html`);
}

console.log('ALL TESTS PASSED:', {
  ipcMessagesDispatched: kernel.ipcBus.history.length,
  auditLogCount: security.auditLogs.length,
  verifiedDomIds: idMatches.length
});