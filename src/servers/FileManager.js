/**
 * @file FileManager.js
 * @description Servidor de Administración de Archivos en espacio de usuario (Módulo 2.3):
 *  - Árbol jerárquico de directorios y archivos con metadatos (tamaño, fecha creación, propietario, permisos rwx)
 *  - Formateo seleccionable: FAT (File Allocation Table) o Inodos simulados (12 directos + indirecto simple + indirecto doble)
 *    con tamaño de bloque y tamaño total de volumen configurables
 *  - Operaciones CRUD completas: crear, leer, modificar, renombrar y eliminar archivos y directorios
 *  - Control de permisos rwx por nodo (propietario / otros) sobre cada petición IPC
 *  - Exportación / importación del estado con verificación de consistencia (fsck) para la persistencia
 *  - Comunicación con el Servidor de E/S solo mediante direcciones lógicas de bloque (LBA)
 */

import { SERVER_ENDPOINTS, SYSCALL_ACTIONS } from '../core/IPCMessage.js';

export const FS_BLOCK_SIZES = Object.freeze([512, 1024, 4096]);
export const FS_TOTAL_SIZES = Object.freeze([65536, 131072, 262144]); // 64 KB, 128 KB, 256 KB
export const FS_DEFAULT_TOTAL_SIZE = 131072;
export const INODE_DIRECT_POINTERS = 12;
export const INODE_POINTER_SIZE_BYTES = 4;
const PROTECTED_DIRS = Object.freeze(['/bin', '/etc', '/home', '/pub']);

export class FSNode {
  constructor({
    id,
    name,
    path,
    parentPath = '/',
    type = 'FILE', // 'FILE' | 'DIRECTORY'
    sizeBytes = 0,
    owner = 'root',
    role = 'ROOT',
    permissions = 'rwxr-xr-x',
    content = '',
    createdAt = new Date().toISOString(),
    updatedAt = new Date().toISOString(),
    firstBlock = null,
    inodeNumber = null
  }) {
    this.id = id;
    this.name = name;
    this.path = path;
    this.parentPath = parentPath;
    this.type = type;
    this.sizeBytes = sizeBytes;
    this.owner = owner;
    this.role = role;
    this.permissions = permissions;
    this.content = content;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.firstBlock = firstBlock;
    this.inodeNumber = inodeNumber;
  }
}

export class FileManager {
  /**
   * @param {import('../core/Kernel.js').Kernel} kernel
   */
  constructor(kernel) {
    this.kernel = kernel;
    this.formatType = 'FAT'; // 'FAT' | 'INODES'
    this.blockSizeBytes = 1024; // 512 | 1024 | 4096
    this.totalSizeBytes = FS_DEFAULT_TOTAL_SIZE;
    this.totalBlocks = Math.floor(this.totalSizeBytes / this.blockSizeBytes);

    /** @type {Map<string, FSNode>} */
    this.nodes = new Map();
    /**
     * Mapa de bloques del volumen (FAT para formato FAT, mapa de bits/propietarios para formato INODES).
     * status: FREE | USED | EOF | INDEX (bloque de índice del inodo) | RESERVED
     * @type {Array<{blockIndex: number, status: string, nextBlock: number|null, ownerPath: string|null}>}
     */
    this.fatTable = [];
    /**
     * @type {Array<{inodeNumber: number, ownerPath: string, sizeBytes: number, permissions: string,
     *   directBlocks: number[], singleIndirectBlock: number|null, singleIndirectPointers: number[],
     *   doubleIndirectBlock: number|null, doubleIndirectTable: Array<{indexBlock: number, pointers: number[]}>}>}
     */
    this.inodeTable = [];
    this.nextNodeId = 1;
    this.nextInodeNumber = 1;

    this.formatFileSystem(this.formatType, this.blockSizeBytes, this.totalSizeBytes);
    this.kernel.registerServer(SERVER_ENDPOINTS.FS_SERVER, (msg) => this.handleIPC(msg));
  }

  // ---------------------------------------------------------------------------
  // IPC
  // ---------------------------------------------------------------------------

  handleIPC(msg) {
    const { action, payload, authContext } = msg;
    const auth = authContext || { username: 'root', role: 'ROOT' };

    switch (action) {
      case SYSCALL_ACTIONS.SYS_FORMAT_FS:
        return this.formatFileSystem(payload.formatType, payload.blockSizeBytes, payload.totalSizeBytes);

      case SYSCALL_ACTIONS.SYS_CREATE_NODE: {
        const parentPath = payload.parentPath || '/';
        const parent = this.nodes.get(parentPath);
        if (parent) this._assertAccess(parent, auth, 'w', `crear en ${parentPath}`);
        const type = payload.type || 'FILE';
        return this.createNode({
          parentPath,
          name: payload.name,
          type,
          content: payload.content || '',
          permissions: payload.permissions || (type === 'DIRECTORY' ? 'rwxr-xr-x' : 'rw-r--r--'),
          owner: auth.username || 'root',
          role: auth.role || 'ROOT'
        });
      }

      case SYSCALL_ACTIONS.SYS_READ_FILE: {
        const node = this.nodes.get(payload.path);
        if (node) this._assertAccess(node, auth, 'r', `leer ${payload.path}`);
        return this.readFile(payload.path);
      }

      case SYSCALL_ACTIONS.SYS_WRITE_FILE: {
        const node = this.nodes.get(payload.path);
        if (node) {
          this._assertAccess(node, auth, 'w', `escribir ${payload.path}`);
          const wantsChmod =
            payload.permissions && this._normalizePermissions(payload.permissions) !== node.permissions;
          if (wantsChmod && auth.role !== 'ROOT' && node.owner !== auth.username) {
            throw new Error(`EPERM: Solo el propietario (${node.owner}) o ROOT puede cambiar los permisos de ${payload.path}.`);
          }
        }
        return this.writeFile(payload.path, payload.content, payload.permissions);
      }

      case SYSCALL_ACTIONS.SYS_RENAME_NODE: {
        const node = this.nodes.get(payload.path);
        if (node) this._assertDirEntryChange(node, auth, `renombrar ${payload.path}`);
        return this.renameNode(payload.path, payload.newName);
      }

      case SYSCALL_ACTIONS.SYS_DELETE_NODE: {
        const node = this.nodes.get(payload.path);
        if (node) this._assertDirEntryChange(node, auth, `eliminar ${payload.path}`);
        return this.deleteNode(payload.path);
      }

      default:
        throw new Error(`Acción desconocida en FS_SERVER: ${action}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Permisos rwx
  // ---------------------------------------------------------------------------

  /** Acepta 'rwxr-xr-x' o notación octal ('755', '0644') y devuelve siempre la forma simbólica. */
  _normalizePermissions(perms) {
    const raw = String(perms ?? '').trim();
    if (/^[r-][w-][x-][r-][w-][x-][r-][w-][x-]$/.test(raw)) return raw;
    if (/^0?[0-7]{3}$/.test(raw)) {
      const digits = raw.slice(-3).split('').map(Number);
      return digits.map((d) => `${d & 4 ? 'r' : '-'}${d & 2 ? 'w' : '-'}${d & 1 ? 'x' : '-'}`).join('');
    }
    throw new Error(`EINVAL: Permisos inválidos "${perms}". Use formato rwxr-xr-x u octal (ej. 644).`);
  }

  /** ROOT todo; el propietario usa los bits de usuario; los demás usan los bits "otros". */
  _canAccess(node, auth, mode) {
    if (!auth || auth.role === 'ROOT') return true;
    const bits = node.owner === auth.username ? node.permissions.slice(0, 3) : node.permissions.slice(6, 9);
    return bits['rwx'.indexOf(mode)] !== '-';
  }

  _assertAccess(node, auth, mode, what) {
    if (!this._canAccess(node, auth, mode)) {
      throw new Error(
        `EACCES: Permiso '${mode}' denegado a ${auth.username} (${auth.role}) para ${what} [${node.permissions}, dueño ${node.owner}].`
      );
    }
  }

  /** Renombrar/eliminar: requiere 'w' en el directorio padre y ser propietario del nodo (semántica sticky-bit). */
  _assertDirEntryChange(node, auth, what) {
    const parent = node.parentPath ? this.nodes.get(node.parentPath) : null;
    if (parent) this._assertAccess(parent, auth, 'w', `${what} (directorio padre)`);
    if (auth.role !== 'ROOT' && node.owner !== auth.username) {
      throw new Error(`EACCES: ${auth.username} no es propietario de ${node.path} (dueño: ${node.owner}); no puede ${what}.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Formateo
  // ---------------------------------------------------------------------------

  formatFileSystem(formatType = 'FAT', blockSizeBytes = 1024, totalSizeBytes = this.totalSizeBytes) {
    if (['FAT', 'INODES'].includes(formatType)) {
      this.formatType = formatType;
    }
    if (FS_BLOCK_SIZES.includes(Number(blockSizeBytes))) {
      this.blockSizeBytes = Number(blockSizeBytes);
    }
    if (FS_TOTAL_SIZES.includes(Number(totalSizeBytes))) {
      this.totalSizeBytes = Number(totalSizeBytes);
    }
    // RF-18: N_bloques = floor(totalSize / blockSize)
    this.totalBlocks = Math.floor(this.totalSizeBytes / this.blockSizeBytes);

    this.nodes.clear();
    this.inodeTable = [];
    this.nextNodeId = 1;
    this.nextInodeNumber = 1;
    this.fatTable = Array.from({ length: this.totalBlocks }, (_, idx) => ({
      blockIndex: idx,
      status: idx < 2 ? 'RESERVED' : 'FREE',
      nextBlock: null,
      ownerPath: idx < 2 ? 'SUPERBLOCK/BOOT' : null
    }));

    // Crear jerarquía inicial UNIX
    this._insertDirectory('/', null, 'root', 'rwxr-xr-x');
    this._insertDirectory('/bin', '/', 'root', 'rwxr-xr-x');
    this._insertDirectory('/etc', '/', 'root', 'rwxr-xr-x');
    this._insertDirectory('/home', '/', 'std_user', 'rwxr-xr-x');
    this._insertDirectory('/pub', '/', 'guest', 'rwxrwxrwx'); // público: STANDARD también escribe (matriz ACL)

    // Archivos iniciales demostrativos
    this.createNode({
      parentPath: '/etc',
      name: 'kernel.conf',
      type: 'FILE',
      content: 'ARCH=MICROKERNEL\nIPC_BUS=STRICT\nCLOCK_HZ=2\nDEFAULT_SCHED=RR\nQUANTUM=3',
      permissions: 'rw-r--r--',
      owner: 'root',
      role: 'ROOT',
      skipDiskIO: true
    });

    this.createNode({
      parentPath: '/home',
      name: 'proyecto_so.txt',
      type: 'FILE',
      content: 'Universidad Distrital Francisco José de Caldas - Simulación Web Minikernel SO 2026-2.',
      permissions: 'rw-rw-r--',
      owner: 'std_user',
      role: 'STANDARD',
      skipDiskIO: true
    });

    this.createNode({
      parentPath: '/pub',
      name: 'readme_guest.md',
      type: 'FILE',
      content: 'Archivo público de lectura para perfil Invitado (GUEST).',
      permissions: 'r--r--r--',
      owner: 'root',
      role: 'ROOT',
      skipDiskIO: true
    });

    return {
      formatType: this.formatType,
      blockSizeBytes: this.blockSizeBytes,
      totalSizeBytes: this.totalSizeBytes,
      totalBlocks: this.totalBlocks
    };
  }

  _insertDirectory(path, parentPath, owner, permissions) {
    const name = path === '/' ? '/' : path.split('/').filter(Boolean).pop();
    const node = new FSNode({
      id: `NODE-${this.nextNodeId++}`,
      name,
      path,
      parentPath,
      type: 'DIRECTORY',
      sizeBytes: 0,
      owner,
      permissions
    });
    this.nodes.set(path, node);
    return node;
  }

  // ---------------------------------------------------------------------------
  // Asignación de bloques (FAT / Inodos)
  // ---------------------------------------------------------------------------

  _dataBlocksFor(sizeBytes) {
    return Math.max(1, Math.ceil(Math.max(0, sizeBytes) / this.blockSizeBytes));
  }

  _pointersPerBlock() {
    return Math.floor(this.blockSizeBytes / INODE_POINTER_SIZE_BYTES);
  }

  /** Bloques de índice extra que necesita un inodo (indirecto simple + indirecto doble). */
  _indexBlocksFor(dataBlocks) {
    const ppb = this._pointersPerBlock();
    let remaining = dataBlocks - INODE_DIRECT_POINTERS;
    if (remaining <= 0) return 0;
    let index = 1; // indirecto simple
    remaining -= Math.min(remaining, ppb);
    if (remaining > 0) {
      if (remaining > ppb * ppb) {
        throw new Error('EFBIG: El archivo excede el tamaño máximo direccionable por un inodo.');
      }
      index += 1 + Math.ceil(remaining / ppb); // bloque doble + bloques de segundo nivel
    }
    return index;
  }

  _allocateBlocksForFile(path, sizeBytes, permissions) {
    const dataBlocks = this._dataBlocksFor(sizeBytes);
    const indexBlocks = this.formatType === 'INODES' ? this._indexBlocksFor(dataBlocks) : 0;
    const blocksNeeded = dataBlocks + indexBlocks;
    const freeBlocks = this.fatTable.filter((b) => b.status === 'FREE').map((b) => b.blockIndex);

    if (freeBlocks.length < blocksNeeded) {
      throw new Error(`ENOSPC (Disco lleno): Se requieren ${blocksNeeded} bloques pero solo hay ${freeBlocks.length} libres.`);
    }

    const allocated = freeBlocks.slice(0, blocksNeeded);
    const data = allocated.slice(0, dataBlocks);
    const index = allocated.slice(dataBlocks);

    if (this.formatType === 'FAT') {
      // Encadenamiento FAT: cada entrada apunta al siguiente cluster; el último marca EOF (-1)
      for (let i = 0; i < data.length; i++) {
        const isLast = i === data.length - 1;
        const entry = this.fatTable[data[i]];
        entry.status = isLast ? 'EOF' : 'USED';
        entry.nextBlock = isLast ? -1 : data[i + 1];
        entry.ownerPath = path;
      }
    } else {
      for (const blk of data) {
        const entry = this.fatTable[blk];
        entry.status = 'USED';
        entry.nextBlock = null;
        entry.ownerPath = path;
      }
      for (const blk of index) {
        const entry = this.fatTable[blk];
        entry.status = 'INDEX';
        entry.nextBlock = null;
        entry.ownerPath = path;
      }
    }

    let inodeNum = null;
    if (this.formatType === 'INODES') {
      const ppb = this._pointersPerBlock();
      const directBlocks = data.slice(0, INODE_DIRECT_POINTERS);
      let rest = data.slice(INODE_DIRECT_POINTERS);
      let idx = 0;

      let singleIndirectBlock = null;
      let singleIndirectPointers = [];
      if (rest.length > 0) {
        singleIndirectBlock = index[idx++];
        singleIndirectPointers = rest.slice(0, ppb);
        rest = rest.slice(ppb);
      }

      let doubleIndirectBlock = null;
      const doubleIndirectTable = [];
      if (rest.length > 0) {
        doubleIndirectBlock = index[idx++];
        while (rest.length > 0) {
          doubleIndirectTable.push({ indexBlock: index[idx++], pointers: rest.slice(0, ppb) });
          rest = rest.slice(ppb);
        }
      }

      inodeNum = this.nextInodeNumber++;
      this.inodeTable.push({
        inodeNumber: inodeNum,
        ownerPath: path,
        sizeBytes,
        permissions,
        directBlocks,
        singleIndirectBlock,
        singleIndirectPointers,
        doubleIndirectBlock,
        doubleIndirectTable
      });
    }

    return { firstBlock: data[0], inodeNumber: inodeNum, allocatedBlocks: allocated, dataBlocks: data };
  }

  _freeBlocksOfPath(path) {
    for (const entry of this.fatTable) {
      if (entry.ownerPath === path && entry.blockIndex >= 2) {
        entry.status = 'FREE';
        entry.nextBlock = null;
        entry.ownerPath = null;
      }
    }
    this.inodeTable = this.inodeTable.filter((ino) => ino.ownerPath !== path);
  }

  /** Bloques de datos de un archivo en orden lógico (siguiendo la cadena FAT o el inodo). */
  getBlockChain(path) {
    const node = this.nodes.get(path);
    if (!node || node.type !== 'FILE') return [];
    if (this.formatType === 'FAT') {
      const chain = [];
      let cur = node.firstBlock;
      const guard = new Set();
      while (cur !== null && cur !== undefined && cur >= 0 && !guard.has(cur)) {
        guard.add(cur);
        chain.push(cur);
        cur = this.fatTable[cur] ? this.fatTable[cur].nextBlock : null;
      }
      return chain;
    }
    const ino = this.inodeTable.find((i) => i.ownerPath === path);
    if (!ino) return [];
    return [
      ...ino.directBlocks,
      ...ino.singleIndirectPointers,
      ...ino.doubleIndirectTable.flatMap((t) => t.pointers)
    ];
  }

  getInode(path) {
    return this.inodeTable.find((i) => i.ownerPath === path) || null;
  }

  // ---------------------------------------------------------------------------
  // Métricas del volumen (RNF-08)
  // ---------------------------------------------------------------------------

  /** F_int = (bloques de datos asignados x blockSize) - tamaño del archivo */
  internalFragmentationBytes(node) {
    if (!node || node.type !== 'FILE') return 0;
    return this._dataBlocksFor(node.sizeBytes) * this.blockSizeBytes - node.sizeBytes;
  }

  getVolumeStats() {
    const free = this.fatTable.filter((b) => b.status === 'FREE').length;
    const reserved = this.fatTable.filter((b) => b.status === 'RESERVED').length;
    const index = this.fatTable.filter((b) => b.status === 'INDEX').length;
    let internalFragmentationBytes = 0;
    let files = 0;
    let directories = 0;
    for (const n of this.nodes.values()) {
      if (n.type === 'FILE') {
        files += 1;
        internalFragmentationBytes += this.internalFragmentationBytes(n);
      } else {
        directories += 1;
      }
    }
    return {
      formatType: this.formatType,
      blockSizeBytes: this.blockSizeBytes,
      totalSizeBytes: this.totalSizeBytes,
      totalBlocks: this.totalBlocks,
      freeBlocks: free,
      reservedBlocks: reserved,
      indexBlocks: index,
      usedBlocks: this.totalBlocks - free - reserved,
      files,
      directories,
      internalFragmentationBytes
    };
  }

  // ---------------------------------------------------------------------------
  // Comunicación con el Servidor de E/S (solo LBA)
  // ---------------------------------------------------------------------------

  _sendDiskRequest(operation, node) {
    const blocks = this.getBlockChain(node.path);
    this._issueBlockIO(operation, node.path, blocks, operation === 'WRITE' ? node.content : '', node.sizeBytes);
  }

  /** RF-19/RF-20: el FS envía bloques lógicos; el DeviceDriver los traduce a LBA y CHS. */
  _issueBlockIO(operation, path, blocks, content = '', sizeBytes = null) {
    if (!this.kernel.ipcBus.handlers.has(SERVER_ENDPOINTS.IO_SERVER)) return;
    const bytes = new TextEncoder().encode(content);
    const totalBytes = sizeBytes ?? bytes.length;
    blocks.forEach((logicalBlock, i) => {
      const offset = i * this.blockSizeBytes;
      const byteCount = Math.max(1, Math.min(this.blockSizeBytes, totalBytes - offset));
      this.kernel.sendIPC({
        sender: SERVER_ENDPOINTS.FS_SERVER,
        receiver: SERVER_ENDPOINTS.IO_SERVER,
        action: SYSCALL_ACTIONS.SYS_IO_DISK_REQ,
        payload: {
          operation,
          path,
          logicalBlock,
          blockSizeBytes: this.blockSizeBytes,
          byteCount,
          data: operation === 'WRITE' ? Array.from(bytes.slice(offset, offset + byteCount)) : null
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  _cleanName(name) {
    const cleanName = String(name || '').trim().replace(/\//g, '');
    if (!cleanName) throw new Error('Nombre de archivo o directorio vacío.');
    if (cleanName === '.' || cleanName === '..') throw new Error(`EINVAL: Nombre reservado "${cleanName}".`);
    if (cleanName.length > 64) throw new Error('ENAMETOOLONG: El nombre excede 64 caracteres.');
    return cleanName;
  }

  createNode({
    parentPath = '/',
    name,
    type = 'FILE',
    content = '',
    permissions = 'rw-r--r--',
    owner = 'root',
    role = 'ROOT',
    skipDiskIO = false
  }) {
    const cleanName = this._cleanName(name);
    const parent = this.nodes.get(parentPath);
    if (!parent) throw new Error(`Directorio padre no existe: ${parentPath}`);
    if (parent.type !== 'DIRECTORY') throw new Error(`ENOTDIR: ${parentPath} no es un directorio.`);
    const perms = this._normalizePermissions(permissions);

    const fullPath = parentPath === '/' ? `/${cleanName}` : `${parentPath}/${cleanName}`;
    if (this.nodes.has(fullPath)) {
      throw new Error(`EEXIST: El nodo ${fullPath} ya existe.`);
    }

    let sizeBytes = 0;
    let firstBlock = null;
    let inodeNumber = null;

    if (type === 'FILE') {
      sizeBytes = new TextEncoder().encode(content).length;
      const alloc = this._allocateBlocksForFile(fullPath, sizeBytes, perms);
      firstBlock = alloc.firstBlock;
      inodeNumber = alloc.inodeNumber;
    }

    const node = new FSNode({
      id: `NODE-${this.nextNodeId++}`,
      name: cleanName,
      path: fullPath,
      parentPath,
      type,
      sizeBytes,
      owner,
      role,
      permissions: perms,
      content,
      firstBlock,
      inodeNumber
    });

    this.nodes.set(fullPath, node);
    parent.updatedAt = new Date().toISOString();
    if (type === 'FILE' && !skipDiskIO) this._sendDiskRequest('WRITE', node);
    return node;
  }

  readFile(path) {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`ENOENT: Archivo no encontrado: ${path}`);
    if (node.type === 'DIRECTORY') throw new Error(`EISDIR: ${path} es un directorio.`);
    this._sendDiskRequest('READ', node);
    return node;
  }

  writeFile(path, newContent, newPermissions = null) {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`ENOENT: Archivo no encontrado: ${path}`);
    if (node.type === 'DIRECTORY') throw new Error(`EISDIR: No se puede escribir contenido plano en directorio ${path}.`);

    const content = String(newContent ?? '');
    const sizeBytes = new TextEncoder().encode(content).length;
    const perms = newPermissions ? this._normalizePermissions(newPermissions) : node.permissions;

    // Respaldo para rollback: si no hay espacio, el archivo original queda intacto
    const fatBackup = this.fatTable.map((b) => ({ ...b }));
    const inodeBackup = this.inodeTable.map((i) => structuredClone(i));
    const nextInodeBackup = this.nextInodeNumber;
    this._freeBlocksOfPath(path);
    let alloc;
    try {
      alloc = this._allocateBlocksForFile(path, sizeBytes, perms);
    } catch (err) {
      this.fatTable = fatBackup;
      this.inodeTable = inodeBackup;
      this.nextInodeNumber = nextInodeBackup;
      throw err;
    }

    node.content = content;
    node.sizeBytes = sizeBytes;
    node.permissions = perms;
    node.firstBlock = alloc.firstBlock;
    node.inodeNumber = alloc.inodeNumber;
    node.updatedAt = new Date().toISOString();

    this._sendDiskRequest('WRITE', node);
    return node;
  }

  renameNode(path, newName) {
    if (path === '/') throw new Error('No se puede renombrar el directorio raíz /.');
    if (PROTECTED_DIRS.includes(path)) {
      throw new Error(`EPERM: Directorio crítico del sistema protegido contra renombrado: ${path}`);
    }
    const node = this.nodes.get(path);
    if (!node) throw new Error(`ENOENT: Nodo no existe: ${path}`);

    const cleanName = this._cleanName(newName);
    const newPath = node.parentPath === '/' ? `/${cleanName}` : `${node.parentPath}/${cleanName}`;
    if (this.nodes.has(newPath)) throw new Error(`EEXIST: Ya existe un nodo en ${newPath}`);

    // Recolectar el nodo y TODOS sus descendientes (cualquier profundidad) antes de mutar
    const prefix = `${path}/`;
    const affected = [...this.nodes.values()].filter((n) => n.path === path || n.path.startsWith(prefix));
    for (const n of affected) this.nodes.delete(n.path);

    for (const n of affected) {
      const oldPath = n.path;
      n.path = newPath + oldPath.slice(path.length);
      if (n === node) {
        n.name = cleanName;
      } else {
        n.parentPath = newPath + n.parentPath.slice(path.length);
      }
      n.updatedAt = new Date().toISOString();
      this.nodes.set(n.path, n);
      for (const entry of this.fatTable) if (entry.ownerPath === oldPath) entry.ownerPath = n.path;
      for (const ino of this.inodeTable) if (ino.ownerPath === oldPath) ino.ownerPath = n.path;
    }

    return node;
  }

  deleteNode(path) {
    if (path === '/' || PROTECTED_DIRS.includes(path)) {
      throw new Error(`EPERM: Directorio crítico del sistema protegido contra eliminación: ${path}`);
    }
    const node = this.nodes.get(path);
    if (!node) throw new Error(`ENOENT: Nodo no existe: ${path}`);

    // Si es directorio, verificar que esté vacío
    const hasChildren = [...this.nodes.values()].some((n) => n.parentPath === path);
    if (hasChildren) {
      throw new Error(`ENOTEMPTY: El directorio ${path} no está vacío.`);
    }

    this._freeBlocksOfPath(path);
    this.nodes.delete(path);
    return { deletedPath: path };
  }

  // ---------------------------------------------------------------------------
  // Persistencia: exportar / importar con verificación de consistencia (RF-24, RNF-09)
  // ---------------------------------------------------------------------------

  exportState() {
    return {
      formatType: this.formatType,
      blockSizeBytes: this.blockSizeBytes,
      totalSizeBytes: this.totalSizeBytes,
      totalBlocks: this.totalBlocks,
      nextNodeId: this.nextNodeId,
      nextInodeNumber: this.nextInodeNumber,
      nodes: [...this.nodes.values()].map((n) => ({ ...n })),
      fatTable: this.fatTable.map((b) => ({ ...b })),
      inodeTable: this.inodeTable.map((i) => structuredClone(i))
    };
  }

  /**
   * fsck simulado: devuelve la lista de inconsistencias entre el árbol (FSNode)
   * y las tablas de asignación (FAT / Inodos). Lista vacía = volumen consistente.
   */
  fsck(state = this.exportState()) {
    const issues = [];
    const nodes = new Map((state.nodes || []).map((n) => [n.path, n]));
    const table = state.fatTable || [];
    const inodes = state.inodeTable || [];
    const blockSize = Number(state.blockSizeBytes) || 1024;
    const isFat = state.formatType === 'FAT';

    if (!nodes.has('/')) issues.push('Falta el directorio raíz "/".');
    if (table.length !== Math.floor((Number(state.totalSizeBytes) || 0) / blockSize)) {
      issues.push(`Tamaño de la tabla de bloques (${table.length}) no coincide con totalSize/blockSize.`);
    }

    for (const n of nodes.values()) {
      if (n.path !== '/') {
        const parent = nodes.get(n.parentPath);
        if (!parent) issues.push(`${n.path}: directorio padre ${n.parentPath} no existe.`);
        else if (parent.type !== 'DIRECTORY') issues.push(`${n.path}: el padre ${n.parentPath} no es directorio.`);
        const expected = n.parentPath === '/' ? `/${n.name}` : `${n.parentPath}/${n.name}`;
        if (n.path !== expected) issues.push(`${n.path}: la ruta no coincide con padre + nombre (${expected}).`);
      }
      if (n.type === 'FILE') {
        const owned = table.filter((b) => b.ownerPath === n.path && b.blockIndex >= 2);
        const needed = Math.max(1, Math.ceil(Math.max(0, n.sizeBytes) / blockSize));
        if (owned.length < needed) {
          issues.push(`${n.path}: tiene ${owned.length} bloques asignados pero necesita al menos ${needed}.`);
        }
        if (!isFat && !inodes.some((i) => i.ownerPath === n.path)) {
          issues.push(`${n.path}: no tiene inodo asociado.`);
        }
        if (isFat) {
          const seen = new Set();
          let cur = n.firstBlock;
          let reachedEof = false;
          while (cur !== null && cur !== undefined && !seen.has(cur) && table[cur]) {
            seen.add(cur);
            if (table[cur].status === 'EOF') {
              reachedEof = true;
              break;
            }
            cur = table[cur].nextBlock;
          }
          if (!reachedEof) issues.push(`${n.path}: la cadena FAT no termina en EOF (cadena rota o con ciclo).`);
        }
      }
    }

    for (const b of table) {
      if (b.status === 'FREE' || b.status === 'RESERVED') continue;
      const owner = nodes.get(b.ownerPath);
      if (!owner || owner.type !== 'FILE') issues.push(`Bloque #${b.blockIndex} huérfano (dueño: ${b.ownerPath}).`);
    }
    for (const i of inodes) {
      if (!nodes.has(i.ownerPath)) issues.push(`Inodo #${i.inodeNumber} huérfano (dueño: ${i.ownerPath}).`);
    }
    const nums = inodes.map((i) => i.inodeNumber);
    if (new Set(nums).size !== nums.length) issues.push('Hay números de inodo duplicados.');

    return issues;
  }

  /**
   * Restaura un estado exportado. Si el fsck detecta corrupción NO se monta el volumen
   * (se conserva el volumen recién formateado) y se devuelven las inconsistencias.
   */
  importState(state) {
    if (!state || !Array.isArray(state.nodes) || !Array.isArray(state.fatTable)) {
      return { mounted: false, issues: ['Snapshot de sistema de archivos ausente o incompleto.'] };
    }
    const blockSizeBytes = Number(state.blockSizeBytes) || 1024;
    const totalBlocks = Number(state.totalBlocks) || state.fatTable.length;
    const normalized = {
      ...state,
      blockSizeBytes,
      totalBlocks,
      // Snapshots previos no guardaban el tamaño del volumen; se infiere del mapa de bloques.
      totalSizeBytes: Number(state.totalSizeBytes) || totalBlocks * blockSizeBytes,
      inodeTable: (state.inodeTable || []).map((inode) => {
        if (Array.isArray(inode.singleIndirectPointers) && Array.isArray(inode.doubleIndirectTable)) return inode;
        // En el formato anterior los inodos no enumeraban todos los bloques de datos.
        const dataBlocks = state.fatTable
          .filter((block) => block.ownerPath === inode.ownerPath && block.status !== 'INDEX')
          .map((block) => block.blockIndex);
        return {
          ...inode,
          directBlocks: dataBlocks,
          singleIndirectBlock: null,
          singleIndirectPointers: [],
          doubleIndirectBlock: null,
          doubleIndirectTable: []
        };
      })
    };
    const issues = this.fsck(normalized);
    if (issues.length > 0) return { mounted: false, issues };

    this.formatType = normalized.formatType;
    this.blockSizeBytes = normalized.blockSizeBytes;
    this.totalSizeBytes = normalized.totalSizeBytes;
    this.totalBlocks = normalized.totalBlocks;
    this.nodes = new Map(normalized.nodes.map((n) => [n.path, new FSNode(n)]));
    this.fatTable = normalized.fatTable.map((b) => ({ ...b }));
    this.inodeTable = normalized.inodeTable.map((i) => structuredClone(i));
    this.nextNodeId = Number(normalized.nextNodeId) || this.nodes.size + 1;
    this.nextInodeNumber =
      Number(normalized.nextInodeNumber) || Math.max(0, ...this.inodeTable.map((i) => i.inodeNumber)) + 1;
    return { mounted: true, issues: [] };
  }
}
