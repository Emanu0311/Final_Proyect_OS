/**
 * @file PersistenceStore.js
 * @description Persistencia en LocalStorage (estado ligero y DISK_CONFIGS) e IndexedDB
 *              (DISK_CONFIGS, DISK_SECTORS y SYSTEM_LOGS del modelo ER, más el snapshot completo).
 */

const STORAGE_KEY = 'UD_MINIKERNEL_SO2026_STATE_V1';
const DISK_CONFIG_KEY = 'minikernel_disk_config';
const IDB_NAME = 'UDMinikernelDB_2026';
const IDB_VERSION = 2;

export class PersistenceStore {
  constructor() {
    this.storageKey = STORAGE_KEY;
    this.lastSavedAt = null;
    this._dbPromise = null;
  }

  saveSnapshot({ processManager, memoryManager, fileManager, deviceDriver, securityController }) {
    const io = deviceDriver.exportState();
    const snapshot = {
      version: '2026.2',
      savedAt: new Date().toISOString(),
      activeUserRole: securityController.activeUser.role,
      scheduler: { algorithm: processManager.algorithm, quantum: processManager.quantum },
      memory: { scheme: memoryManager.scheme, fitAlgorithm: memoryManager.fitAlgorithm },
      filesystem: fileManager.exportState(),
      disk: io,
      securityLogs: securityController.auditLogs.slice(0, 60)
    };

    try {
      if (typeof localStorage !== 'undefined') {
        // Los sectores pueden ser voluminosos: viven solo en IndexedDB
        localStorage.setItem(this.storageKey, JSON.stringify({ ...snapshot, disk: { ...io, disk_sectors: [] } }));
        localStorage.setItem(DISK_CONFIG_KEY, JSON.stringify(io.disk_config));
      }
      this.lastSavedAt = snapshot.savedAt;
    } catch (err) {
      console.warn('Persistencia local advertencia:', err);
    }
    this._saveToIndexedDB(snapshot);
    return snapshot;
  }

  loadSnapshot() {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(this.storageKey);
        if (raw) return JSON.parse(raw);
      }
    } catch (err) {
      console.warn('Error cargando snapshot de LocalStorage:', err);
    }
    return null;
  }

  loadDiskSectors(diskId) {
    return this._openDB()
      .then((db) => {
        if (!db) return [];
        return new Promise((resolve) => {
          const req = db
            .transaction('disk_sectors', 'readonly')
            .objectStore('disk_sectors')
            .index('idx_disk')
            .getAll(IDBKeyRange.only(diskId));
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        });
      })
      .catch(() => []);
  }

  clearSnapshot() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(this.storageKey);
        localStorage.removeItem(DISK_CONFIG_KEY);
      }
    } catch (e) {
      // sin LocalStorage disponible
    }
  }

  _openDB() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = (ev) => {
          const db = ev.target.result;
          if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('disk_configs')) db.createObjectStore('disk_configs', { keyPath: 'disk_id' });
          if (!db.objectStoreNames.contains('disk_sectors')) {
            const sectors = db.createObjectStore('disk_sectors', { keyPath: ['disk_id', 'lba'] });
            sectors.createIndex('idx_disk', 'disk_id', { unique: false });
            sectors.createIndex('idx_chs', ['cylinder', 'track', 'sector'], { unique: false });
          }
          if (!db.objectStoreNames.contains('system_logs')) {
            const logs = db.createObjectStore('system_logs', { keyPath: 'log_id' });
            logs.createIndex('idx_kernel_tick', 'kernel_tick');
            logs.createIndex('idx_module', 'module');
            logs.createIndex('idx_severity', 'severity');
            logs.createIndex('idx_user_id', 'user_id');
          }
        };
        req.onsuccess = (ev) => resolve(ev.target.result);
        req.onerror = () => {
          console.warn('IndexedDB no disponible:', req.error);
          resolve(null);
        };
      });
    }
    return this._dbPromise;
  }

  /** Una sola transacción readwrite multi-store: si falla (p. ej. QuotaExceededError) se revierte completa. */
  _saveToIndexedDB(snapshot) {
    return this._openDB()
      .then((db) => {
        if (!db) return false;
        const { disk } = snapshot;
        const tx = db.transaction(['snapshots', 'disk_configs', 'disk_sectors', 'system_logs'], 'readwrite');
        tx.objectStore('snapshots').put({ id: 'latest', ...snapshot, disk: { ...disk, disk_sectors: [] } });
        tx.objectStore('disk_configs').put(disk.disk_config);
        const sectors = tx.objectStore('disk_sectors');
        sectors.clear();
        for (const rec of disk.disk_sectors) sectors.put(rec);
        const logs = tx.objectStore('system_logs');
        for (const log of disk.system_logs) logs.put(log);
        return new Promise((resolve) => {
          tx.oncomplete = () => resolve(true);
          tx.onabort = () => {
            console.warn('Transacción IndexedDB revertida:', tx.error);
            resolve(false);
          };
        });
      })
      .catch((err) => {
        console.warn('Error de persistencia IndexedDB:', err);
        return false;
      });
  }
}
