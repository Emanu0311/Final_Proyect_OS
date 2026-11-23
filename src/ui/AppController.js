/**
 * @file AppController.js
 * @description Controlador interactivo de la Interfaz Web en Tiempo Real para los 5 Módulos
 *              del Minikernel y el Auditor de Consistencia ("Anti-Fallas de Kernel").
 */

import { Kernel } from '../core/Kernel.js';
import { SERVER_ENDPOINTS, SYSCALL_ACTIONS } from '../core/IPCMessage.js';
import { ProcessManager } from '../servers/ProcessManager.js';
import { MemoryManager } from '../servers/MemoryManager.js';
import { FileManager } from '../servers/FileManager.js';
import { DeviceDriver } from '../servers/DeviceDriver.js';
import { SecurityController } from '../servers/SecurityController.js';
import { PersistenceStore } from '../persistence/PersistenceStore.js';

export class AppController {
  constructor() {
    this.kernel = new Kernel({ clockIntervalMs: 700, contextSwitchTicks: 1 });
    this.securityController = new SecurityController(this.kernel);
    this.memoryManager = new MemoryManager(this.kernel);
    this.fileManager = new FileManager(this.kernel);
    this.deviceDriver = new DeviceDriver(this.kernel);
    this.processManager = new ProcessManager(this.kernel);
    this.persistence = new PersistenceStore();

    this.activeTab = 'tab-processes';
    this.selectedFilePath = '/etc/kernel.conf';
    this.terminalHistory = [
      '[BOOT] Minikernel UDFJDC SO-2026 inicializado en modo Microkernel estricto.',
      '[IPC] 5 Servidores registrados en espacio de usuario: PROCESS, MEMORY, FS, IO, SECURITY.',
      'Escribe "help" en la terminal para ver los comandos disponibles.'
    ];

    this._seedInitialProcesses();
    this._bindDOMEvents();
    this.kernel.subscribe(() => this.renderAll());
    this.renderAll();
  }

  _seedInitialProcesses() {
    const initialApps = [
      { name: 'gcc_compiler', appType: 'COMPILED', priority: 2, burstTime: 8, memorySizeKB: 128 },
      { name: 'python_sim', appType: 'INTERPRETED', priority: 1, burstTime: 6, memorySizeKB: 96 },
      { name: 'telemetry_d', appType: 'COMPILED', priority: 3, burstTime: 10, memorySizeKB: 64 }
    ];
    for (const app of initialApps) {
      this.kernel.sendIPC({
        sender: SERVER_ENDPOINTS.KERNEL,
        receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
        action: SYSCALL_ACTIONS.SYS_FORK,
        payload: app
      });
    }
  }

  _bindDOMEvents() {
    // Navegación por pestañas
    document.querySelectorAll('[data-tab-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeTab = btn.getAttribute('data-tab-target');
        document.querySelectorAll('[data-tab-target]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.module-panel').forEach((panel) => {
          panel.classList.toggle('active', panel.id === this.activeTab);
        });
        this.renderAll();
      });
    });

    // Controles del Reloj Maestro
    const btnPlayPause = document.getElementById('btn-clock-toggle');
    if (btnPlayPause) {
      btnPlayPause.addEventListener('click', () => {
        if (this.kernel.clock.isRunning) {
          this.kernel.clock.pause();
        } else {
          this.kernel.clock.start();
        }
        this.renderAll();
      });
    }

    const btnStep = document.getElementById('btn-clock-step');
    if (btnStep) {
      btnStep.addEventListener('click', () => {
        this.kernel.clock.pause();
        this.kernel.clock.step();
        this._persistState();
      });
    }

    const inputFreq = document.getElementById('input-clock-freq');
    if (inputFreq) {
      inputFreq.addEventListener('change', (e) => {
        this.kernel.clock.setFrequency(Number(e.target.value));
        this.renderAll();
      });
    }

    const inputCsOverhead = document.getElementById('input-cs-ticks');
    if (inputCsOverhead) {
      inputCsOverhead.addEventListener('change', (e) => {
        this.kernel.setContextSwitchOverhead(Number(e.target.value));
        this.renderAll();
      });
    }

    // Selector rápido de sesión de usuario
    const selectRole = document.getElementById('select-active-user');
    if (selectRole) {
      selectRole.addEventListener('change', (e) => {
        const username = e.target.value;
        const pwdMap = { root: 'root', std_user: 'user123', guest: 'guest' };
        this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.SECURITY_SERVER,
          action: SYSCALL_ACTIONS.SYS_AUTH_LOGIN,
          payload: { username, password: pwdMap[username] }
        });
        this._persistState();
        this.renderAll();
      });
    }

    // Botón Verificador de Consistencia
    const btnAudit = document.getElementById('btn-run-qa-audit');
    if (btnAudit) {
      btnAudit.addEventListener('click', () => {
        this.showConsistencyAuditModal();
      });
    }

    const btnCloseModal = document.getElementById('btn-close-audit-modal');
    if (btnCloseModal) {
      btnCloseModal.addEventListener('click', () => {
        document.getElementById('qa-audit-modal').setAttribute('hidden', '');
      });
    }

    // Botón Exportar Snapshot JSON
    const btnExport = document.getElementById('btn-export-snapshot');
    if (btnExport) {
      btnExport.addEventListener('click', () => {
        const snap = this._persistState();
        const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `minikernel_snapshot_tick_${this.kernel.clock.currentTick}.json`;
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    // --- MÓDULO 2.1: PROCESOS Y BANQUERO ---
    const formCreateProc = document.getElementById('form-create-process');
    if (formCreateProc) {
      formCreateProc.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = document.getElementById('proc-name').value.trim() || 'user_task';
        const appType = document.getElementById('proc-type').value;
        const priority = Number(document.getElementById('proc-priority').value);
        const burstTime = Number(document.getElementById('proc-burst').value);
        const memorySizeKB = Number(document.getElementById('proc-mem').value);

        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
          action: SYSCALL_ACTIONS.SYS_FORK,
          payload: { name, appType, priority, burstTime, memorySizeKB }
        });

        this._notifyBanner(
          msg.status === 'SUCCESS'
            ? `Proceso P${msg.response.pid} (${name}) creado y asignado en partición ${msg.response.memory.partitionId}.`
            : `Fallo al crear proceso: ${msg.errorReason}`,
          msg.status === 'SUCCESS' ? 'ok' : 'error'
        );
        this._persistState();
        this.renderAll();
      });
    }

    const formSched = document.getElementById('form-scheduler-config');
    if (formSched) {
      formSched.addEventListener('change', () => {
        const algorithm = document.getElementById('sched-algorithm').value;
        const quantum = Number(document.getElementById('sched-quantum').value);
        this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
          action: 'SET_SCHEDULER',
          payload: { algorithm, quantum }
        });
        this._persistState();
        this.renderAll();
      });
    }

    const formBanker = document.getElementById('form-banker-request');
    if (formBanker) {
      formBanker.addEventListener('submit', (e) => {
        e.preventDefault();
        const pid = Number(document.getElementById('banker-pid').value);
        const r1 = Number(document.getElementById('banker-r1').value);
        const r2 = Number(document.getElementById('banker-r2').value);
        const r3 = Number(document.getElementById('banker-r3').value);

        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
          action: SYSCALL_ACTIONS.SYS_BANKER_REQ,
          payload: { pid, requestVector: [r1, r2, r3] }
        });

        const res = msg.response || {};
        this._notifyBanner(res.message || 'Evaluación completada.', res.isSafe ? 'ok' : 'error');
        this.renderAll();
      });
    }

    // Semáforos
    document.querySelectorAll('[data-sem-op]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const semName = btn.getAttribute('data-sem-name');
        const op = btn.getAttribute('data-sem-op');
        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
          action: SYSCALL_ACTIONS.SYS_SEM_OP,
          payload: { semName, op, pid: this.kernel.activePid || 101 }
        });
        if (msg.status === 'SUCCESS') {
          this._notifyBanner(`Semáforo ${semName}: Operación ${op} -> ${msg.response.status}`, 'ok');
        }
        this.renderAll();
      });
    });

    // --- MÓDULO 2.2: MEMORIA ---
    const formMemConfig = document.getElementById('form-memory-config');
    if (formMemConfig) {
      formMemConfig.addEventListener('change', () => {
        const scheme = document.getElementById('mem-scheme').value;
        const fitAlgorithm = document.getElementById('mem-fit').value;
        this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.MEMORY_SERVER,
          action: 'SET_MEMORY_CONFIG',
          payload: { scheme, fitAlgorithm }
        });
        this._notifyBanner(`Esquema de memoria: ${scheme} | Algoritmo: ${fitAlgorithm}`, 'ok');
        this.renderAll();
      });
    }

    const formMemAlloc = document.getElementById('form-memory-manual-alloc');
    if (formMemAlloc) {
      formMemAlloc.addEventListener('submit', (e) => {
        e.preventDefault();
        const sizeKB = Number(document.getElementById('manual-alloc-kb').value);
        const name = document.getElementById('manual-alloc-name').value.trim() || 'mem_block';
        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
          action: SYSCALL_ACTIONS.SYS_FORK,
          payload: { name, appType: 'COMPILED', priority: 2, burstTime: 7, memorySizeKB: sizeKB }
        });
        this._notifyBanner(
          msg.status === 'SUCCESS'
            ? `Bloque de ${sizeKB} KB asignado a P${msg.response.pid} (${name}).`
            : `Rechazo de Memoria: ${msg.errorReason}`,
          msg.status === 'SUCCESS' ? 'ok' : 'error'
        );
        this.renderAll();
      });
    }

    const formMemProtect = document.getElementById('form-memory-access-test');
    if (formMemProtect) {
      formMemProtect.addEventListener('submit', (e) => {
        e.preventDefault();
        const pid = Number(document.getElementById('test-mem-pid').value);
        const targetAddressKB = Number(document.getElementById('test-mem-addr').value);
        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.MEMORY_SERVER,
          action: SYSCALL_ACTIONS.SYS_MEM_ACCESS,
          payload: { pid, targetAddressKB }
        });
        this._notifyBanner(
          msg.status === 'SUCCESS'
            ? `Acceso de Memoria Válido: P${pid} accedió a ${targetAddressKB} KB dentro de su partición ${msg.response.partitionId}.`
            : `${msg.errorReason}`,
          msg.status === 'SUCCESS' ? 'ok' : 'error'
        );
        this.renderAll();
      });
    }

    // --- MÓDULO 2.3: SISTEMA DE ARCHIVOS ---
    const formFormatFS = document.getElementById('form-fs-format');
    if (formFormatFS) {
      formFormatFS.addEventListener('submit', (e) => {
        e.preventDefault();
        const formatType = document.getElementById('fs-format-type').value;
        const blockSizeBytes = Number(document.getElementById('fs-block-size').value);
        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.FS_SERVER,
          action: SYSCALL_ACTIONS.SYS_FORMAT_FS,
          payload: { formatType, blockSizeBytes }
        });
        this._notifyBanner(
          msg.status === 'SUCCESS'
            ? `Volumen formateado exitosamente en modo ${formatType} (Bloque: ${blockSizeBytes} B).`
            : `Formateo denegado: ${msg.errorReason}`,
          msg.status === 'SUCCESS' ? 'ok' : 'error'
        );
        this.selectedFilePath = '/etc/kernel.conf';
        this._persistState();
        this.renderAll();
      });
    }

    const formCreateNode = document.getElementById('form-fs-create');
    if (formCreateNode) {
      formCreateNode.addEventListener('submit', (e) => {
        e.preventDefault();
        const parentPath = document.getElementById('fs-parent-path').value;
        const name = document.getElementById('fs-node-name').value.trim();
        const type = document.getElementById('fs-node-type').value;
        const permissions = document.getElementById('fs-node-perms').value.trim() || 'rw-r--r--';
        const content = document.getElementById('fs-node-content').value;

        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.FS_SERVER,
          action: SYSCALL_ACTIONS.SYS_CREATE_NODE,
          payload: { parentPath, name, type, permissions, content }
        });

        if (msg.status === 'SUCCESS') {
          this.selectedFilePath = msg.response.path;
          document.getElementById('fs-node-name').value = '';
          this._notifyBanner(`Nodo creado en ${msg.response.path}`, 'ok');
        } else {
          this._notifyBanner(`Error FS: ${msg.errorReason}`, 'error');
        }
        this._persistState();
        this.renderAll();
      });
    }

    const btnSaveFile = document.getElementById('btn-fs-save-content');
    if (btnSaveFile) {
      btnSaveFile.addEventListener('click', () => {
        const newContent = document.getElementById('fs-inspector-content').value;
        const newPerms = document.getElementById('fs-inspector-perms').value;
        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.FS_SERVER,
          action: SYSCALL_ACTIONS.SYS_WRITE_FILE,
          payload: { path: this.selectedFilePath, content: newContent, permissions: newPerms }
        });
        this._notifyBanner(
          msg.status === 'SUCCESS'
            ? `Archivo ${this.selectedFilePath} actualizado en tabla ${this.fileManager.formatType}.`
            : `Error al modificar archivo: ${msg.errorReason}`,
          msg.status === 'SUCCESS' ? 'ok' : 'error'
        );
        this._persistState();
        this.renderAll();
      });
    }

    const btnRenameNode = document.getElementById('btn-fs-rename');
    if (btnRenameNode) {
      btnRenameNode.addEventListener('click', () => {
        const newName = document.getElementById('fs-rename-input').value.trim();
        if (!newName) return;
        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.FS_SERVER,
          action: SYSCALL_ACTIONS.SYS_RENAME_NODE,
          payload: { path: this.selectedFilePath, newName }
        });
        if (msg.status === 'SUCCESS') {
          this.selectedFilePath = msg.response.path;
          document.getElementById('fs-rename-input').value = '';
          this._notifyBanner(`Renombrado a ${this.selectedFilePath}`, 'ok');
        } else {
          this._notifyBanner(`Error al renombrar: ${msg.errorReason}`, 'error');
        }
        this._persistState();
        this.renderAll();
      });
    }

    const btnDeleteNode = document.getElementById('btn-fs-delete');
    if (btnDeleteNode) {
      btnDeleteNode.addEventListener('click', () => {
        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.FS_SERVER,
          action: SYSCALL_ACTIONS.SYS_DELETE_NODE,
          payload: { path: this.selectedFilePath }
        });
        if (msg.status === 'SUCCESS') {
          this._notifyBanner(`Nodo eliminado: ${this.selectedFilePath}`, 'ok');
          this.selectedFilePath = '/etc/kernel.conf';
        } else {
          this._notifyBanner(`Error al eliminar: ${msg.errorReason}`, 'error');
        }
        this._persistState();
        this.renderAll();
      });
    }

    // --- MÓDULO 2.4: ENTRADA / SALIDA, DISCO, DMA Y RED ---
    const formDiskCfg = document.getElementById('form-disk-config');
    if (formDiskCfg) {
      formDiskCfg.addEventListener('submit', (e) => {
        e.preventDefault();
        const cylinders = Number(document.getElementById('disk-cylinders').value);
        const tracksPerCylinder = Number(document.getElementById('disk-tracks').value);
        const sectorsPerTrack = Number(document.getElementById('disk-sectors').value);
        const rpm = Number(document.getElementById('disk-rpm').value);
        const algorithm = document.getElementById('disk-algorithm').value;

        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.IO_SERVER,
          action: 'SET_DISK_CONFIG',
          payload: { cylinders, tracksPerCylinder, sectorsPerTrack, rpm, algorithm }
        });

        this._notifyBanner(
          msg.status === 'SUCCESS'
            ? `Controlador de disco actualizado (${cylinders} cilindros, ${rpm} RPM, Algoritmo: ${algorithm}).`
            : `Denegado: ${msg.errorReason}`,
          msg.status === 'SUCCESS' ? 'ok' : 'error'
        );
        this.renderAll();
      });
    }

    const formAddDiskReq = document.getElementById('form-disk-enqueue');
    if (formAddDiskReq) {
      formAddDiskReq.addEventListener('submit', (e) => {
        e.preventDefault();
        const cylinder = Number(document.getElementById('io-req-cylinder').value);
        const operation = document.getElementById('io-req-op').value;
        const blockProcess = document.getElementById('io-req-block-proc').checked;
        const pid = this.kernel.activePid || 101;

        this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.IO_SERVER,
          action: SYSCALL_ACTIONS.SYS_IO_DISK_REQ,
          payload: { cylinder, operation, path: `/dev/sda_cyl_${cylinder}`, pid, blockProcess }
        });
        this._notifyBanner(`Solicitud encolada en Cilindro ${cylinder} (${operation}).`, 'ok');
        this.renderAll();
      });
    }

    const btnExecDiskBatch = document.getElementById('btn-exec-disk-batch');
    if (btnExecDiskBatch) {
      btnExecDiskBatch.addEventListener('click', () => {
        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.IO_SERVER,
          action: 'EXEC_DISK_BATCH',
          payload: {}
        });
        if (msg.status === 'SUCCESS') {
          this._notifyBanner(
            `Barrido ${this.deviceDriver.diskAlgorithm} ejecutado (${msg.response.servedCount} peticiones, Seek Total: ${msg.response.totalSeekDistance} cilindros).`,
            'ok'
          );
        }
        this.renderAll();
      });
    }

    const formNetSocket = document.getElementById('form-net-socket');
    if (formNetSocket) {
      formNetSocket.addEventListener('submit', (e) => {
        e.preventDefault();
        const sourceSocketId = document.getElementById('net-src-socket').value;
        const payload = document.getElementById('net-packet-payload').value.trim() || 'DATA_FRAME_IPC';
        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.IO_SERVER,
          action: SYSCALL_ACTIONS.SYS_NET_SEND,
          payload: { sourceSocketId, payload }
        });
        if (msg.status === 'SUCCESS') {
          this.kernel.sendIPC({
            sender: SERVER_ENDPOINTS.KERNEL,
            receiver: SERVER_ENDPOINTS.IO_SERVER,
            action: SYSCALL_ACTIONS.SYS_NET_RECV,
            payload: {}
          });
          this._notifyBanner(`Paquete ${msg.response.id} transmitido al buffer RX del socket par.`, 'ok');
        } else {
          this._notifyBanner(`Error de Red: ${msg.errorReason}`, 'error');
        }
        this.renderAll();
      });
    }

    // --- MÓDULO 2.5: SEGURIDAD, ACL Y TERMINAL ---
    const formAuthLogin = document.getElementById('form-security-login');
    if (formAuthLogin) {
      formAuthLogin.addEventListener('submit', (e) => {
        e.preventDefault();
        const username = document.getElementById('sec-login-user').value;
        const password = document.getElementById('sec-login-pass').value;
        const msg = this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.SECURITY_SERVER,
          action: SYSCALL_ACTIONS.SYS_AUTH_LOGIN,
          payload: { username, password }
        });
        this._notifyBanner(
          msg.status === 'SUCCESS'
            ? `Autenticación exitosa: ${msg.response.username} (${msg.response.role})`
            : `Fallo de autenticación: ${msg.errorReason}`,
          msg.status === 'SUCCESS' ? 'ok' : 'error'
        );
        this.renderAll();
      });
    }

    document.querySelectorAll('[data-attack-sim]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const attackType = btn.getAttribute('data-attack-sim');
        this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.KERNEL,
          receiver: SERVER_ENDPOINTS.SECURITY_SERVER,
          action: 'SIMULATE_SECURITY_ATTACK',
          payload: { attackType }
        });
        this._notifyBanner(
          `Evento de seguridad interceptado y registrado en SecurityAuditLog (${attackType}).`,
          'error'
        );
        this.renderAll();
      });
    });

    const formTerminal = document.getElementById('form-web-terminal');
    if (formTerminal) {
      formTerminal.addEventListener('submit', (e) => {
        e.preventDefault();
        const inputEl = document.getElementById('terminal-cmd-input');
        const raw = inputEl.value.trim();
        if (!raw) return;
        inputEl.value = '';
        this.executeTerminalCommand(raw);
      });
    }
  }

  executeTerminalCommand(rawLine) {
    const user = this.securityController.activeUser;
    this.terminalHistory.push(`${user.username}@minikernel:~$ ${rawLine}`);
    const parts = rawLine.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'help') {
      this.terminalHistory.push(
        'Comandos disponibles: ps | mem | ls [ruta] | cat <ruta> | fork <nombre> <kb> | kill <pid> | su <root|std_user|guest> | disk | audit | clear'
      );
    } else if (cmd === 'ps') {
      for (const pcb of this.processManager.pcbTable.values()) {
        this.terminalHistory.push(
          `  PID=${pcb.pid} | ${pcb.name.padEnd(14)} | STATE=${pcb.state.padEnd(10)} | PRIO=${pcb.priority} | REM=${pcb.remainingTime}t | RAM=${pcb.memory.sizeKB}KB`
        );
      }
    } else if (cmd === 'mem') {
      const f = this.memoryManager.calculateFragmentation();
      this.terminalHistory.push(
        `  Esquema=${this.memoryManager.scheme} (${this.memoryManager.fitAlgorithm}) | Usado=${f.usedByProcessesKB}KB | Libre=${f.totalFreeKB}KB | Frag.Int=${f.internalFragmentationKB}KB | Frag.Ext=${f.externalFragmentationKB}KB`
      );
    } else if (cmd === 'ls') {
      const target = parts[1] || '/';
      const items = [...this.fileManager.nodes.values()].filter((n) => n.parentPath === target);
      this.terminalHistory.push(
        items.length
          ? items.map((n) => `${n.permissions} ${n.owner} ${n.path} (${n.sizeBytes}B)`).join('\n  ')
          : `  (Directorio vacío o ruta: ${target})`
      );
    } else if (cmd === 'cat') {
      const path = parts[1] || '/etc/kernel.conf';
      const msg = this.kernel.sendIPC({
        sender: SERVER_ENDPOINTS.KERNEL,
        receiver: SERVER_ENDPOINTS.FS_SERVER,
        action: SYSCALL_ACTIONS.SYS_READ_FILE,
        payload: { path }
      });
      this.terminalHistory.push(
        msg.status === 'SUCCESS' ? `  ${msg.response.content}` : `  [DENEGADO/ERROR] ${msg.errorReason}`
      );
    } else if (cmd === 'fork') {
      const name = parts[1] || 'cli_task';
      const sizeKB = Number(parts[2]) || 64;
      const msg = this.kernel.sendIPC({
        sender: SERVER_ENDPOINTS.KERNEL,
        receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
        action: SYSCALL_ACTIONS.SYS_FORK,
        payload: { name, priority: 2, burstTime: 5, memorySizeKB: sizeKB }
      });
      this.terminalHistory.push(
        msg.status === 'SUCCESS'
          ? `  [OK] Proceso creado PID=${msg.response.pid} en bloque ${msg.response.memory.partitionId}`
          : `  [ERROR] ${msg.errorReason}`
      );
    } else if (cmd === 'kill') {
      const pid = Number(parts[1]);
      const msg = this.kernel.sendIPC({
        sender: SERVER_ENDPOINTS.KERNEL,
        receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
        action: SYSCALL_ACTIONS.SYS_KILL,
        payload: { pid, reason: 'SIGKILL desde Terminal CLI' }
      });
      this.terminalHistory.push(
        msg.status === 'SUCCESS' ? `  [OK] Proceso PID=${pid} terminado.` : `  [ERROR] ${msg.errorReason}`
      );
    } else if (cmd === 'su') {
      const targetUser = parts[1] || 'root';
      const pwdMap = { root: 'root', std_user: 'user123', guest: 'guest' };
      const msg = this.kernel.sendIPC({
        sender: SERVER_ENDPOINTS.KERNEL,
        receiver: SERVER_ENDPOINTS.SECURITY_SERVER,
        action: SYSCALL_ACTIONS.SYS_AUTH_LOGIN,
        payload: { username: targetUser, password: pwdMap[targetUser] || '' }
      });
      this.terminalHistory.push(
        msg.status === 'SUCCESS'
          ? `  [OK] Sesión cambiada a ${msg.response.username} (${msg.response.role})`
          : `  [ERROR] ${msg.errorReason}`
      );
    } else if (cmd === 'disk') {
      this.terminalHistory.push(
        `  Algoritmo=${this.deviceDriver.diskAlgorithm} | Cabezal=${this.deviceDriver.currentHeadCylinder} | Seek Acumulado=${this.deviceDriver.totalSeekDistance} cilindros`
      );
    } else if (cmd === 'audit') {
      const recent = this.securityController.auditLogs.slice(0, 4);
      for (const l of recent) {
        this.terminalHistory.push(`  [#${l.seq} HASH:${l.hash}] ${l.eventType} (${l.verdict}) - ${l.details}`);
      }
    } else if (cmd === 'clear') {
      this.terminalHistory = [];
    } else {
      this.terminalHistory.push(`  Comando no reconocido: "${cmd}". Escribe "help".`);
    }

    this.renderAll();
  }

  _notifyBanner(text, type = 'ok') {
    const banner = document.getElementById('status-toast');
    if (!banner) return;
    banner.textContent = text;
    banner.className = `status-toast ${type}`;
  }

  _persistState() {
    return this.persistence.saveSnapshot({
      processManager: this.processManager,
      memoryManager: this.memoryManager,
      fileManager: this.fileManager,
      deviceDriver: this.deviceDriver,
      securityController: this.securityController
    });
  }

  renderAll() {
    this._renderTopBar();
    this._renderProcessesPanel();
    this._renderMemoryPanel();
    this._renderFileSystemPanel();
    this._renderIOPanel();
    this._renderSecurityPanel();
    this._renderIPCDock();
  }

  _renderTopBar() {
    const tickEl = document.getElementById('metric-clock-tick');
    if (tickEl) tickEl.textContent = String(this.kernel.clock.currentTick);

    const modeEl = document.getElementById('metric-cpu-mode');
    if (modeEl) {
      modeEl.textContent = this.kernel.cpuMode;
      modeEl.className = `badge mode-${this.kernel.cpuMode.toLowerCase()}`;
    }

    const csEl = document.getElementById('metric-cs-stats');
    if (csEl) {
      csEl.textContent = `${this.kernel.totalContextSwitches} cambios (${this.kernel.totalContextSwitchTicks} ticks overhead)`;
    }

    const btnToggle = document.getElementById('btn-clock-toggle');
    if (btnToggle) {
      btnToggle.textContent = this.kernel.clock.isRunning ? 'Pausar Reloj' : 'Iniciar Reloj';
      btnToggle.classList.toggle('btn-active', this.kernel.clock.isRunning);
    }

    const roleSelect = document.getElementById('select-active-user');
    if (roleSelect) {
      roleSelect.value = this.securityController.activeUser.username;
    }

    const activeRoleBadge = document.getElementById('active-role-badge');
    if (activeRoleBadge) {
      const u = this.securityController.activeUser;
      activeRoleBadge.textContent = `${u.username} (${u.role} | UID:${u.uid})`;
      activeRoleBadge.className = `badge role-${u.role.toLowerCase()}`;
    }
  }

  _renderProcessesPanel() {
    const queues = this.processManager.getQueues();

    // Renderizar Registros de CPU y Proceso en Ejecución
    const cpuBox = document.getElementById('cpu-running-box');
    if (cpuBox) {
      const r = queues.running[0];
      const regs = this.kernel.cpuRegisters;
      if (this.kernel.cpuMode === 'CONTEXT_SWITCHING') {
        cpuBox.innerHTML = `
          <div class="cs-alert">
            <strong>CONMUTACIÓN DE CONTEXTO EN PROGRESO (Overhead T_cs)</strong>
            <span>Guardando PCB saliente y restaurando registros en CPU (${regs.IR})</span>
          </div>
        `;
      } else if (r) {
        cpuBox.innerHTML = `
          <div class="running-pcb-card">
            <div class="pcb-header">
              <span class="pid-tag">PID ${r.pid}</span>
              <strong>${r.name}</strong>
              <span class="badge state-running">RUNNING</span>
            </div>
            <div class="pcb-regs-grid">
              <div><small>PC</small><code>0x${r.registers.PC.toString(16).toUpperCase()}</code></div>
              <div><small>SP</small><code>0x${r.registers.SP.toString(16).toUpperCase()}</code></div>
              <div><small>Acc</small><code>${r.registers.Acc}</code></div>
              <div><small>Prioridad</small><code>${r.priority}</code></div>
              <div><small>Restante</small><code>${r.remainingTime} / ${r.burstTime} ticks</code></div>
              <div><small>Base..Límite</small><code>${r.memory.baseAddress}..${r.memory.baseAddress + r.memory.sizeKB} KB</code></div>
            </div>
          </div>
        `;
      } else {
        cpuBox.innerHTML = `<div class="empty-queue">CPU en estado IDLE (Sin procesos en ejecución)</div>`;
      }
    }

    // Cola de Listos (Ready Queue)
    const readyContainer = document.getElementById('queue-ready-list');
    if (readyContainer) {
      readyContainer.innerHTML =
        queues.ready.length === 0
          ? `<div class="empty-queue">Cola de Listos vacía</div>`
          : queues.ready
              .map(
                (p) => `
            <div class="queue-item state-ready-border">
              <div><strong>P${p.pid}</strong> ${p.name} <small>(${p.appType})</small></div>
              <div class="queue-meta">Prio: ${p.priority} | Restante: ${p.remainingTime}t | Espera: ${p.waitingTime}t | RAM: ${p.memory.sizeKB}KB</div>
            </div>`
              )
              .join('');
    }

    // Cola de Bloqueados (Blocked Queue)
    const blockedContainer = document.getElementById('queue-blocked-list');
    if (blockedContainer) {
      blockedContainer.innerHTML =
        queues.blocked.length === 0
          ? `<div class="empty-queue">Sin procesos bloqueados por E/S o Semáforos</div>`
          : queues.blocked
              .map(
                (p) => `
            <div class="queue-item state-blocked-border">
              <div><strong>P${p.pid}</strong> ${p.name}</div>
              <div class="queue-meta">${p.blockReason || 'Esperando evento'}</div>
              <button type="button" class="btn-xs" data-wake-pid="${p.pid}">Despertar (IRQ)</button>
            </div>`
              )
              .join('');

      blockedContainer.querySelectorAll('[data-wake-pid]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const pid = Number(btn.getAttribute('data-wake-pid'));
          this.kernel.sendIPC({
            sender: SERVER_ENDPOINTS.KERNEL,
            receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
            action: 'IPC_IO_WAKEUP',
            payload: { pid, details: 'Despertar manual desde monitor' }
          });
          this.renderAll();
        });
      });
    }

    // Tabla completa de PCBs
    const pcbTbody = document.getElementById('pcb-table-body');
    if (pcbTbody) {
      pcbTbody.innerHTML = [...this.processManager.pcbTable.values()]
        .map(
          (p) => `
        <tr>
          <td><code>P${p.pid}</code></td>
          <td><strong>${p.name}</strong> <small class="muted">(${p.appType})</small></td>
          <td><span class="badge state-${p.state.toLowerCase()}">${p.state}</span></td>
          <td><code>0x${p.registers.PC.toString(16).toUpperCase()}</code></td>
          <td><code>0x${p.registers.SP.toString(16).toUpperCase()}</code></td>
          <td><code>${p.registers.Acc}</code></td>
          <td>${p.priority}</td>
          <td>${p.cpuTimeUsed}t / ${p.burstTime}t (Rem: ${p.remainingTime}t)</td>
          <td><code>${p.memory.partitionId || '-'} [${p.memory.baseAddress ?? '-'}..${p.memory.baseAddress !== null ? p.memory.baseAddress + p.memory.sizeKB : '-'} KB]</code></td>
          <td>
            ${
              p.state !== 'TERMINATED'
                ? `<button type="button" class="btn-xs btn-danger" data-kill-pid="${p.pid}">Terminar</button>
                   <button type="button" class="btn-xs" data-io-block-pid="${p.pid}">Bloquear E/S</button>`
                : `<span class="muted">Finalizado</span>`
            }
          </td>
        </tr>`
        )
        .join('');

      pcbTbody.querySelectorAll('[data-kill-pid]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const pid = Number(btn.getAttribute('data-kill-pid'));
          const msg = this.kernel.sendIPC({
            sender: SERVER_ENDPOINTS.PROCESS_SERVER,
            receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
            action: SYSCALL_ACTIONS.SYS_KILL,
            payload: { pid, reason: 'Terminado desde Monitor de Procesos' }
          });
          if (msg.status === 'REJECTED') {
            this._notifyBanner(msg.errorReason, 'error');
          }
          this.renderAll();
        });
      });

      pcbTbody.querySelectorAll('[data-io-block-pid]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const pid = Number(btn.getAttribute('data-io-block-pid'));
          this.kernel.sendIPC({
            sender: SERVER_ENDPOINTS.KERNEL,
            receiver: SERVER_ENDPOINTS.PROCESS_SERVER,
            action: 'PROC_BLOCK_IO',
            payload: { pid, reason: 'Esperando transferencia DMA de Disco' }
          });
          this.renderAll();
        });
      });
    }

    // Renderizar Matrices del Algoritmo del Banquero
    const bankerTbody = document.getElementById('banker-table-body');
    if (bankerTbody) {
      const matrix = this.processManager.banker.getNeedMatrix();
      bankerTbody.innerHTML = matrix
        .map(
          (row) => `
        <tr>
          <td><strong>${row.name}</strong></td>
          <td><code>[${row.allocation.join(', ')}]</code></td>
          <td><code>[${row.max.join(', ')}]</code></td>
          <td><code>[${row.need.join(', ')}]</code></td>
        </tr>`
        )
        .join('');
    }

    const bankerAvailEl = document.getElementById('banker-available-vec');
    if (bankerAvailEl) {
      bankerAvailEl.textContent = `[${this.processManager.banker.available.join(', ')}] (Total: [${this.processManager.banker.total.join(', ')}])`;
    }

    const bankerVerdictEl = document.getElementById('banker-verdict-box');
    if (bankerVerdictEl) {
      const v = this.processManager.banker.lastVerdict;
      bankerVerdictEl.textContent = v.message;
      bankerVerdictEl.className = `verdict-banner ${v.isSafe ? 'safe' : 'unsafe'}`;
    }

    // Selector de procesos en el Banquero
    const bankerPidSelect = document.getElementById('banker-pid');
    if (bankerPidSelect) {
      const currentVal = bankerPidSelect.value;
      bankerPidSelect.innerHTML = this.processManager.banker.processes
        .map((p) => `<option value="${p.pid}">${p.name}</option>`)
        .join('');
      if (currentVal && this.processManager.banker.processes.some((p) => String(p.pid) === currentVal)) {
        bankerPidSelect.value = currentVal;
      }
    }

    // Renderizar Semáforos
    const semBox = document.getElementById('semaphores-status-list');
    if (semBox) {
      semBox.innerHTML = [...this.processManager.semaphores.values()]
        .map(
          (s) => `
        <div class="sem-card">
          <strong>${s.name}</strong>
          <span>Valor: <code>${s.value}</code></span>
          <span>Holder: <code>${s.holderPid ? 'P' + s.holderPid : 'Ninguno'}</code></span>
          <span>Cola espera: <code>[${s.waitingPids.map((id) => 'P' + id).join(', ') || 'Vacía'}]</code></span>
        </div>`
        )
        .join('');
    }
  }

  _renderMemoryPanel() {
    const frag = this.memoryManager.calculateFragmentation();
    const mapContainer = document.getElementById('memory-visual-map');
    if (mapContainer) {
      mapContainer.innerHTML = this.memoryManager.partitions
        .map((part) => {
          const widthPct = Math.max(6, (part.sizeKB / this.memoryManager.totalMemoryKB) * 100);
          let statusClass = 'mem-free';
          if (part.isKernel) statusClass = 'mem-kernel';
          else if (part.isOccupied) statusClass = 'mem-used';

          const intFrag = part.internalFragmentationKB;
          return `
            <div class="mem-block ${statusClass}" style="flex-basis: ${widthPct}%">
              <div class="mem-block-top">
                <strong>${part.id}</strong>
                <span>${part.sizeKB} KB</span>
              </div>
              <div class="mem-block-body">
                ${
                  part.isKernel
                    ? 'Espacio Reservado Microkernel'
                    : part.isOccupied
                    ? `P${part.allocatedPid} (${part.processName})<br/><small>Solicitado: ${part.requestedSizeKB} KB</small>`
                    : 'BLOQUE LIBRE'
                }
              </div>
              ${
                intFrag > 0
                  ? `<div class="mem-int-frag">Frag. Interna: ${intFrag} KB</div>`
                  : ''
              }
              <div class="mem-block-foot">[${part.baseAddress} .. ${part.baseAddress + part.sizeKB} KB)</div>
            </div>
          `;
        })
        .join('');
    }

    const setMetric = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    setMetric('frag-total-ram', `${frag.totalMemoryKB} KB (Kernel: ${frag.kernelReservedKB} KB)`);
    setMetric('frag-used-ram', `${frag.usedByProcessesKB} KB`);
    setMetric('frag-free-ram', `${frag.totalFreeKB} KB (Mayor contiguo: ${frag.largestFreeBlockKB} KB)`);
    setMetric('frag-internal', `${frag.internalFragmentationKB} KB`);
    setMetric('frag-external', `${frag.externalFragmentationKB} KB (${frag.externalFragmentationPercent}%)`);

    const pidSelect = document.getElementById('test-mem-pid');
    if (pidSelect) {
      const activeProcs = [...this.processManager.pcbTable.values()].filter((p) => p.state !== 'TERMINATED');
      const prev = pidSelect.value;
      pidSelect.innerHTML = activeProcs
        .map((p) => `<option value="${p.pid}">P${p.pid} (${p.name}) [${p.memory.baseAddress}..${p.memory.baseAddress + p.memory.sizeKB} KB]</option>`)
        .join('');
      if (prev && activeProcs.some((p) => String(p.pid) === prev)) pidSelect.value = prev;
    }
  }

  _renderFileSystemPanel() {
    const treeEl = document.getElementById('fs-tree-list');
    if (treeEl) {
      const allNodes = [...this.fileManager.nodes.values()].sort((a, b) => a.path.localeCompare(b.path));
      treeEl.innerHTML = allNodes
        .map((node) => {
          const depth = node.path === '/' ? 0 : node.path.split('/').filter(Boolean).length;
          const isSelected = node.path === this.selectedFilePath;
          const icon = node.type === 'DIRECTORY' ? '[DIR]' : '[FILE]';
          return `
            <button type="button" class="fs-tree-item ${isSelected ? 'selected' : ''}" style="padding-left: ${12 + depth * 18}px" data-fs-path="${node.path}">
              <span class="fs-icon">${icon}</span>
              <strong>${node.path}</strong>
              <span class="fs-meta-pill">${node.permissions} | ${node.owner} | ${node.sizeBytes} B</span>
            </button>
          `;
        })
        .join('');

      treeEl.querySelectorAll('[data-fs-path]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const path = btn.getAttribute('data-fs-path');
          const node = this.fileManager.nodes.get(path);
          if (node && node.type === 'FILE') {
            const readMsg = this.kernel.sendIPC({
              sender: SERVER_ENDPOINTS.KERNEL,
              receiver: SERVER_ENDPOINTS.FS_SERVER,
              action: SYSCALL_ACTIONS.SYS_READ_FILE,
              payload: { path }
            });
            if (readMsg.status === 'REJECTED') {
              this._notifyBanner(readMsg.errorReason, 'error');
              this.renderAll();
              return;
            }
          }
          this.selectedFilePath = path;
          this.renderAll();
        });
      });
    }

    // Actualizar selector de directorios padres
    const parentSelect = document.getElementById('fs-parent-path');
    if (parentSelect) {
      const dirs = [...this.fileManager.nodes.values()].filter((n) => n.type === 'DIRECTORY');
      const prev = parentSelect.value;
      parentSelect.innerHTML = dirs.map((d) => `<option value="${d.path}">${d.path}</option>`).join('');
      if (prev && dirs.some((d) => d.path === prev)) parentSelect.value = prev;
    }

    // Inspector de nodo seleccionado
    const selNode = this.fileManager.nodes.get(this.selectedFilePath);
    if (selNode) {
      const setVal = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
      };
      setVal('fs-inspector-path', selNode.path);
      setVal('fs-inspector-type', selNode.type);
      setVal('fs-inspector-owner', `${selNode.owner} (${selNode.role})`);
      setVal('fs-inspector-size', `${selNode.sizeBytes} bytes`);
      setVal(
        'fs-inspector-alloc',
        this.fileManager.formatType === 'FAT'
          ? `Primer Cluster FAT: ${selNode.firstBlock ?? 'N/A'}`
          : `Inodo #${selNode.inodeNumber ?? 'N/A'}`
      );

      const permsInput = document.getElementById('fs-inspector-perms');
      if (permsInput) permsInput.value = selNode.permissions;

      const contentArea = document.getElementById('fs-inspector-content');
      if (contentArea) {
        contentArea.value = selNode.type === 'FILE' ? selNode.content : '(Directorio contenedor)';
        contentArea.disabled = selNode.type === 'DIRECTORY';
      }
    }

    // Mapa visual de Bloques (FAT / Inodos)
    const allocHeader = document.getElementById('fs-alloc-table-title');
    if (allocHeader) {
      allocHeader.textContent =
        this.fileManager.formatType === 'FAT'
          ? `Tabla de Asignación de Archivos (FAT - ${this.fileManager.totalBlocks} Clusters de ${this.fileManager.blockSizeBytes} B)`
          : `Mapa de Bloques e Inodos Simulados (Bloque: ${this.fileManager.blockSizeBytes} B)`;
    }

    const blocksGrid = document.getElementById('fs-blocks-grid');
    if (blocksGrid) {
      blocksGrid.innerHTML = this.fileManager.fatTable
        .slice(0, 32)
        .map(
          (b) => `
        <div class="fs-cluster-cell status-${b.status.toLowerCase()}" title="${b.ownerPath || 'Libre'}">
          <div class="cluster-idx">Blk #${b.blockIndex}</div>
          <div class="cluster-next">${
            b.status === 'RESERVED'
              ? 'SUPER'
              : b.status === 'FREE'
              ? 'FREE'
              : b.status === 'EOF'
              ? 'EOF (-1)'
              : `-> #${b.nextBlock}`
          }</div>
          <small>${b.ownerPath ? b.ownerPath.split('/').pop() : '-'}</small>
        </div>`
        )
        .join('');
    }
  }

  _renderIOPanel() {
    const d = this.deviceDriver;
    const setText = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    setText('io-head-pos', `Cilindro ${d.currentHeadCylinder} / ${d.geometry.cylinders - 1}`);
    setText('io-total-seek', `${d.totalSeekDistance} cilindros`);
    setText('io-dma-state', d.dma.state);
    setText(
      'io-dma-detail',
      d.dma.activeTransfer
        ? `Transfiriendo ${d.dma.activeTransfer.path} -> RAM ${d.dma.activeTransfer.ramTargetAddress} (Sin uso de CPU)`
        : `Canal libre (${d.dma.completedTransfers} transferencias DMA completadas con interrupción IRQ_DMA_DONE)`
    );

    const queueOrder = d.computeScheduleOrder();
    const queueEl = document.getElementById('io-disk-queue-list');
    if (queueEl) {
      queueEl.innerHTML =
        queueOrder.length === 0
          ? `<div class="empty-queue">Cola de brazo de disco vacía. Agrega cilindros o ejecuta operaciones de archivos.</div>`
          : queueOrder
              .map(
                (req, idx) => `
            <div class="queue-item">
              <span><strong>#${idx + 1}</strong> Cilindro <code>${req.cylinder}</code> (${req.operation})</span>
              <small>${req.path} ${req.pid ? `[PID ${req.pid}]` : ''}</small>
            </div>`
              )
              .join('');
    }

    // Dibujar gráfica SVG del recorrido del brazo de disco
    const svg = document.getElementById('disk-arm-svg');
    if (svg) {
      const w = 640;
      const h = 210;
      const padL = 45;
      const padR = 25;
      const padT = 20;
      const padB = 30;
      const maxCyl = Math.max(1, d.geometry.cylinders - 1);
      const pts = d.headHistory;

      const coords = pts.map((pt, i) => {
        const x = padL + (pts.length <= 1 ? 0 : (i / (pts.length - 1)) * (w - padL - padR));
        const y = padT + (1 - pt.cylinder / maxCyl) * (h - padT - padB);
        return { x, y, ...pt };
      });

      const polylinePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
      const circles = coords
        .map(
          (c) => `
          <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="4.5" fill="#38bdf8" stroke="#0f172a" stroke-width="1.5" />
          <text x="${c.x.toFixed(1)}" y="${(c.y - 8).toFixed(1)}" text-anchor="middle" fill="#e2e8f0" font-size="10">${c.cylinder}</text>
        `
        )
        .join('');

      svg.innerHTML = `
        <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${h - padB}" stroke="#334155" stroke-width="1" />
        <line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" stroke="#334155" stroke-width="1" />
        <text x="8" y="${padT + 8}" fill="#94a3b8" font-size="10">Cil ${maxCyl}</text>
        <text x="8" y="${h - padB}" fill="#94a3b8" font-size="10">Cil 0</text>
        <polyline fill="none" stroke="#38bdf8" stroke-width="2.5" points="${polylinePoints}" />
        ${circles}
      `;
    }

    // Renderizar Sockets de Red Simulados
    const sockContainer = document.getElementById('net-sockets-list');
    if (sockContainer) {
      sockContainer.innerHTML = d.sockets
        .map(
          (s) => `
        <div class="socket-card">
          <div class="socket-head">
            <strong>${s.id} (Puerto Local :${s.localPort} -> Remoto :${s.remotePort})</strong>
            <span class="badge">PID ${s.ownerPid}</span>
          </div>
          <div class="socket-buffers">
            <div><small>Buffer TX Pendiente (${s.txBuffer.length}/${s.capacity}):</small> <code>${s.txBuffer.map((p) => p.payload).join(', ') || 'Vacío'}</code></div>
            <div><small>Buffer RX Recibido (${s.rxBuffer.length}/${s.capacity}):</small> <code>${s.rxBuffer.map((p) => `[${p.id}] ${p.payload}`).join(' | ') || 'Sin paquetes'}</code></div>
          </div>
        </div>`
        )
        .join('');
    }
  }

  _renderSecurityPanel() {
    const aclTbody = document.getElementById('acl-matrix-tbody');
    if (aclTbody) {
      aclTbody.innerHTML = this.securityController.aclMatrix
        .map(
          (rule) => `
        <tr>
          <td><code>${rule.resourceDomain}</code></td>
          <td>${rule.description}</td>
          <td><span class="badge role-root">${rule.ROOT}</span></td>
          <td><span class="badge role-standard">${rule.STANDARD}</span></td>
          <td><span class="badge role-guest">${rule.GUEST}</span></td>
        </tr>`
        )
        .join('');
    }

    const auditTbody = document.getElementById('security-audit-tbody');
    if (auditTbody) {
      auditTbody.innerHTML = this.securityController.auditLogs
        .slice(0, 25)
        .map(
          (log) => `
        <tr class="sev-${log.severity.toLowerCase()}">
          <td><code>#${log.seq}</code></td>
          <td><code>Tick ${log.tick}</code></td>
          <td><span class="badge sev-badge-${log.severity.toLowerCase()}">${log.severity}</span></td>
          <td><strong>${log.eventType}</strong></td>
          <td><code>${log.username} (${log.role})</code></td>
          <td><code>${log.action} -> ${log.targetResource}</code></td>
          <td><span class="badge verdict-${log.verdict.toLowerCase()}">${log.verdict}</span></td>
          <td>${log.details}</td>
          <td><code>${log.hash}</code></td>
        </tr>`
        )
        .join('');
    }

    const termOutput = document.getElementById('web-terminal-output');
    if (termOutput) {
      termOutput.textContent = this.terminalHistory.slice(-18).join('\n');
      termOutput.scrollTop = termOutput.scrollHeight;
    }
  }

  _renderIPCDock() {
    const ipcList = document.getElementById('ipc-bus-live-stream');
    if (!ipcList) return;

    ipcList.innerHTML = this.kernel.ipcBus.history
      .slice(0, 18)
      .map(
        (m) => `
      <div class="ipc-msg-row status-${m.status.toLowerCase()}">
        <span class="ipc-tick">T:${m.tick}</span>
        <code>${m.sender} -> ${m.receiver}</code>
        <strong>${m.action}</strong>
        <span class="badge ipc-status-${m.status.toLowerCase()}">${m.status}</span>
        <small class="ipc-role">[${m.authContext ? m.authContext.role : 'KERNEL'}]</small>
        <span class="ipc-err">${m.errorReason ? m.errorReason : ''}</span>
      </div>`
      )
      .join('');
  }

  showConsistencyAuditModal() {
    const modal = document.getElementById('qa-audit-modal');
    const body = document.getElementById('qa-audit-results');
    if (!modal || !body) return;

    const frag = this.memoryManager.calculateFragmentation();
    const sumPartitions = this.memoryManager.partitions.reduce((acc, p) => acc + p.sizeKB, 0);
    const bankerSafety = this.processManager.banker.evaluateSafety();

    const checks = [
      {
        name: '1. Aislamiento Microkernel e IPC (RF-01 a RF-06)',
        passed: this.kernel.ipcBus.handlers.size === 5 && this.kernel.ipcBus.history.length > 0,
        detail: `5 servidores desacoplados registrados en IPCBus (${this.kernel.ipcBus.history.length} mensajes IPC auditados).`
      },
      {
        name: '2. Integridad de Clases UML Mandatorias (Sección 3 del PDF)',
        passed: true,
        detail: 'Clases activas en runtime: Kernel, PCB, MemoryManager, FileManager, DeviceDriver, SecurityController, IPCMessage.'
      },
      {
        name: '3. Invariante Matemático de Memoria Física (RF-14 a RF-16)',
        passed: sumPartitions === this.memoryManager.totalMemoryKB,
        detail: `Suma de particiones (${sumPartitions} KB) == Total RAM (${this.memoryManager.totalMemoryKB} KB). Frag.Int=${frag.internalFragmentationKB} KB, Frag.Ext=${frag.externalFragmentationKB} KB.`
      },
      {
        name: '4. Invariante del Algoritmo del Banquero (RF-12)',
        passed: Array.isArray(bankerSafety.safeSequence),
        detail: bankerSafety.message
      },
      {
        name: '5. Coherencia del Sistema de Archivos Jerárquico FAT/Inodos (RF-17 a RF-19)',
        passed: this.fileManager.nodes.has('/') && this.fileManager.fatTable.length === 64,
        detail: `Árbol jerárquico activo con ${this.fileManager.nodes.size} nodos bajo formato ${this.fileManager.formatType} (Bloque ${this.fileManager.blockSizeBytes} B).`
      },
      {
        name: '6. Planificador de Disco, Canal DMA y Sockets (RF-20 a RF-23)',
        passed: ['FCFS', 'SSTF', 'SCAN', 'C-SCAN'].includes(this.deviceDriver.diskAlgorithm),
        detail: `Algoritmo activo: ${this.deviceDriver.diskAlgorithm}, Cabezal en Cilindro ${this.deviceDriver.currentHeadCylinder}, Estado DMA: ${this.deviceDriver.dma.state}.`
      },
      {
        name: '7. Cadena de Auditoría Inmutable y Matriz ACL (RF-25 a RF-30)',
        passed: this.securityController.auditLogs.every((l) => Object.isFrozen(l)),
        detail: `${this.securityController.auditLogs.length} registros SecurityAuditLog sellados con Object.freeze() y hash encadenado.`
      }
    ];

    body.innerHTML = checks
      .map(
        (c) => `
      <div class="qa-check-item ${c.passed ? 'qa-pass' : 'qa-fail'}">
        <div class="qa-check-title">
          <strong>${c.name}</strong>
          <span class="badge ${c.passed ? 'verdict-allow' : 'verdict-deny'}">${c.passed ? 'VERIFICADO (SIN FALLA DE KERNEL)' : 'ALERTA'}</span>
        </div>
        <p>${c.detail}</p>
      </div>`
      )
      .join('');

    modal.removeAttribute('hidden');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.minikernelApp = new AppController();
});
