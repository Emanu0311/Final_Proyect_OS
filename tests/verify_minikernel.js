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
import { DeviceDriver } from '../src/servers/DeviceDriver.js';
import { SecurityController } from '../src/servers/SecurityController.js';
import { PersistenceStore } from '../src/persistence/PersistenceStore.js';

const kernel = new Kernel({ clockIntervalMs: 500, contextSwitchTicks: 1 });
const security = new SecurityController(kernel);
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

// 4. Verificar Módulo 2.4 (Planificador de Brazo de Disco FCFS, SSTF, SCAN, C-SCAN, DMA y Sockets)
for (const algo of ['FCFS', 'SSTF', 'SCAN', 'C-SCAN']) {
  io.updateDiskConfig({ algorithm: algo, headCylinder: 50 });
  const order = io.computeScheduleOrder([
    { id: '1', cylinder: 95 },
    { id: '2', cylinder: 180 },
    { id: '3', cylinder: 34 }
  ], 50);
  assert.equal(order.length, 3);
}
const pkt = io.sendNetworkPacket({ sourceSocketId: 'SOCK-01', payload: 'HELLO_MINIKERNEL' });
assert.equal(pkt.payload, 'HELLO_MINIKERNEL');
io.flushNetworkBuffers();
assert.ok(io.sockets[1].rxBuffer.length >= 1);

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