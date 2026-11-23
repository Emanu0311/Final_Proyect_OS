/**
 * @file PersistenceStore.js
 * @description Capa de Persistencia Relacional/Documental en LocalStorage e IndexedDB (Sección 3 del PDF):
 *  Almacena usuarios, logs de seguridad, configuración de discos y árbol del sistema de archivos.
 */

const STORAGE_KEY = 'UD_MINIKERNEL_SO2026_STATE_V1';
const IDB_NAME = 'UDMinikernelDB_2026';
const IDB_VERSION = 1;

export class PersistenceStore {
  constructor() {
    this.storageKey = STORAGE_KEY;
    this.lastSavedAt = null;
  }

  saveSnapshot({ processManager, memoryManager, fileManager, deviceDriver, securityController }) {
    const snapshot = {
      version: '2026.2',
      savedAt: new Date().toISOString(),
      activeUserRole: securityController.activeUser.role,
      scheduler: {
        algorithm: processManager.algorithm,
        quantum: processManager.quantum
      },
      memory: {
        scheme: memoryManager.scheme,
        fitAlgorithm: memoryManager.fitAlgorithm
      },
      filesystem: {
        formatType: fileManager.formatType,
        blockSizeBytes: fileManager.blockSizeBytes,
        nodes: [...fileManager.nodes.values()],
        fatTable: fileManager.fatTable,
        inodeTable: fileManager.inodeTable
      },
      disk: {
        geometry: deviceDriver.geometry,
        diskAlgorithm: deviceDriver.diskAlgorithm,
        currentHeadCylinder: deviceDriver.currentHeadCylinder,
        totalSeekDistance: deviceDriver.totalSeekDistance
      },
      securityLogs: securityController.auditLogs.slice(0, 60)
    };

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(this.storageKey, JSON.stringify(snapshot));
      }
      this._saveToIndexedDB(snapshot);
      this.lastSavedAt = snapshot.savedAt;
    } catch (err) {
      console.warn('Persistencia local advertencia:', err);
    }
    return snapshot;
  }

  loadSnapshot() {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(this.storageKey);
        if (raw) {
          return JSON.parse(raw);
        }
      }
    } catch (err) {
      console.warn('Error cargando snapshot de LocalStorage:', err);
    }
    return null;
  }

  clearSnapshot() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(this.storageKey);
      }
    } catch (e) {
      // ignore
    }
  }

  _saveToIndexedDB(snapshot) {
    if (typeof indexedDB === 'undefined') return;
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'id' });
        }
      };
      req.onsuccess = (ev) => {
        const db = ev.target.result;
        const tx = db.transaction('snapshots', 'readwrite');
        tx.objectStore('snapshots').put({ id: 'latest', ...snapshot });
      };
    } catch (e) {
      // ignore in headless/node environments
    }
  }
}
