/**
 * @file FileManager.js
 * @description Servidor de Administración de Archivos en espacio de usuario (Módulo 2.3):
 *  - Árbol jerárquico de directorios y archivos con metadatos (tamaño, fecha creación, propietario, permisos rwx)
 *  - Formateo seleccionable: FAT (File Allocation Table) o Inodos simulados con tamaño de bloque configurable
 *  - Operaciones CRUD completas: crear, leer, modificar, renombrar y eliminar archivos y directorios
 */

import { SERVER_ENDPOINTS, SYSCALL_ACTIONS } from '../core/IPCMessage.js';

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
    this.totalBlocks = 64;

    /** @type {Map<string, FSNode>} */
    this.nodes = new Map();
    /** @type {Array<{blockIndex: number, status: 'FREE'|'USED'|'EOF'|'RESERVED', nextBlock: number|null, ownerPath: string|null}>} */
    this.fatTable = [];
    /** @type {Array<{inodeNumber: number, ownerPath: string, sizeBytes: number, permissions: string, directBlocks: number[], indirectBlock: number|null}>} */
    this.inodeTable = [];
    this.nextNodeId = 1;

    this.formatFileSystem(this.formatType, this.blockSizeBytes);
    this.kernel.registerServer(SERVER_ENDPOINTS.FS_SERVER, (msg) => this.handleIPC(msg));
  }

  handleIPC(msg) {
    const { action, payload, authContext } = msg;

    switch (action) {
      case SYSCALL_ACTIONS.SYS_FORMAT_FS:
        return this.formatFileSystem(payload.formatType, payload.blockSizeBytes);

      case SYSCALL_ACTIONS.SYS_CREATE_NODE:
        return this.createNode({
          parentPath: payload.parentPath || '/',
          name: payload.name,
          type: payload.type || 'FILE',
          content: payload.content || '',
          permissions: payload.permissions || (payload.type === 'DIRECTORY' ? 'rwxr-xr-x' : 'rw-r--r--'),
          owner: (authContext && authContext.username) || 'root',
          role: (authContext && authContext.role) || 'ROOT'
        });

      case SYSCALL_ACTIONS.SYS_READ_FILE:
        return this.readFile(payload.path);

      case SYSCALL_ACTIONS.SYS_WRITE_FILE:
        return this.writeFile(payload.path, payload.content, payload.permissions);

      case SYSCALL_ACTIONS.SYS_RENAME_NODE:
        return this.renameNode(payload.path, payload.newName);

      case SYSCALL_ACTIONS.SYS_DELETE_NODE:
        return this.deleteNode(payload.path);

      default:
        throw new Error(`Acción desconocida en FS_SERVER: ${action}`);
    }
  }

  formatFileSystem(formatType = 'FAT', blockSizeBytes = 1024) {
    if (['FAT', 'INODES'].includes(formatType)) {
      this.formatType = formatType;
    }
    if ([512, 1024, 4096].includes(Number(blockSizeBytes))) {
      this.blockSizeBytes = Number(blockSizeBytes);
    }

    this.nodes.clear();
    this.inodeTable = [];
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
    this._insertDirectory('/pub', '/', 'guest', 'rwxr-xr-x');

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

  _allocateBlocksForFile(path, sizeBytes, permissions) {
    const blocksNeeded = Math.max(1, Math.ceil(Math.max(1, sizeBytes) / this.blockSizeBytes));
    const freeBlocks = this.fatTable.filter((b) => b.status === 'FREE').map((b) => b.blockIndex);

    if (freeBlocks.length < blocksNeeded) {
      throw new Error(`ENOSPC (Disco lleno): Se requieren ${blocksNeeded} bloques pero solo hay ${freeBlocks.length} libres.`);
    }

    const allocated = freeBlocks.slice(0, blocksNeeded);
    for (let i = 0; i < allocated.length; i++) {
      const blkIdx = allocated[i];
      const isLast = i === allocated.length - 1;
      this.fatTable[blkIdx].status = isLast ? 'EOF' : 'USED';
      this.fatTable[blkIdx].nextBlock = isLast ? -1 : allocated[i + 1];
      this.fatTable[blkIdx].ownerPath = path;
    }

    let inodeNum = null;
    if (this.formatType === 'INODES') {
      inodeNum = this.inodeTable.length + 1;
      this.inodeTable.push({
        inodeNumber: inodeNum,
        ownerPath: path,
        sizeBytes,
        permissions,
        directBlocks: allocated.slice(0, 4),
        indirectBlock: allocated.length > 4 ? allocated[4] : null
      });
    }

    return { firstBlock: allocated[0], inodeNumber: inodeNum, allocatedBlocks: allocated };
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
    const cleanName = String(name || '').trim().replace(/\//g, '');
    if (!cleanName) throw new Error('Nombre de archivo o directorio vacío.');
    if (!this.nodes.has(parentPath)) throw new Error(`Directorio padre no existe: ${parentPath}`);

    const fullPath = parentPath === '/' ? `/${cleanName}` : `${parentPath}/${cleanName}`;
    if (this.nodes.has(fullPath)) {
      throw new Error(`EEXIST: El nodo ${fullPath} ya existe.`);
    }

    let sizeBytes = 0;
    let firstBlock = null;
    let inodeNumber = null;

    if (type === 'FILE') {
      sizeBytes = new TextEncoder().encode(content).length || content.length || 64;
      const alloc = this._allocateBlocksForFile(fullPath, sizeBytes, permissions);
      firstBlock = alloc.firstBlock;
      inodeNumber = alloc.inodeNumber;

      if (!skipDiskIO && this.kernel.ipcBus.handlers.has(SERVER_ENDPOINTS.IO_SERVER)) {
        this.kernel.sendIPC({
          sender: SERVER_ENDPOINTS.FS_SERVER,
          receiver: SERVER_ENDPOINTS.IO_SERVER,
          action: SYSCALL_ACTIONS.SYS_IO_DISK_REQ,
          payload: {
            operation: 'WRITE',
            cylinder: (firstBlock * 7) % 200,
            path: fullPath,
            sizeBytes
          }
        });
      }
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
      permissions,
      content,
      firstBlock,
      inodeNumber
    });

    this.nodes.set(fullPath, node);
    return node;
  }

  readFile(path) {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`ENOENT: Archivo no encontrado: ${path}`);
    if (node.type === 'DIRECTORY') throw new Error(`EISDIR: ${path} es un directorio.`);

    if (this.kernel.ipcBus.handlers.has(SERVER_ENDPOINTS.IO_SERVER)) {
      this.kernel.sendIPC({
        sender: SERVER_ENDPOINTS.FS_SERVER,
        receiver: SERVER_ENDPOINTS.IO_SERVER,
        action: SYSCALL_ACTIONS.SYS_IO_DISK_REQ,
        payload: {
          operation: 'READ',
          cylinder: ((node.firstBlock || 3) * 11) % 200,
          path: node.path,
          sizeBytes: node.sizeBytes
        }
      });
    }

    return node;
  }

  writeFile(path, newContent, newPermissions = null) {
    const node = this.nodes.get(path);
    if (!node) throw new Error(`ENOENT: Archivo no encontrado: ${path}`);
    if (node.type === 'DIRECTORY') throw new Error(`EISDIR: No se puede escribir contenido plano en directorio ${path}.`);

    this._freeBlocksOfPath(path);
    const sizeBytes = new TextEncoder().encode(newContent).length || newContent.length || 32;
    const perms = newPermissions || node.permissions;
    const alloc = this._allocateBlocksForFile(path, sizeBytes, perms);

    node.content = newContent;
    node.sizeBytes = sizeBytes;
    node.permissions = perms;
    node.firstBlock = alloc.firstBlock;
    node.inodeNumber = alloc.inodeNumber;
    node.updatedAt = new Date().toISOString();

    if (this.kernel.ipcBus.handlers.has(SERVER_ENDPOINTS.IO_SERVER)) {
      this.kernel.sendIPC({
        sender: SERVER_ENDPOINTS.FS_SERVER,
        receiver: SERVER_ENDPOINTS.IO_SERVER,
        action: SYSCALL_ACTIONS.SYS_IO_DISK_REQ,
        payload: {
          operation: 'WRITE',
          cylinder: ((node.firstBlock || 5) * 13) % 200,
          path: node.path,
          sizeBytes: node.sizeBytes
        }
      });
    }

    return node;
  }

  renameNode(path, newName) {
    if (path === '/') throw new Error('No se puede renombrar el directorio raíz /.');
    const node = this.nodes.get(path);
    if (!node) throw new Error(`ENOENT: Nodo no existe: ${path}`);

    const cleanName = String(newName || '').trim().replace(/\//g, '');
    if (!cleanName) throw new Error('Nuevo nombre inválido.');

    const newPath = node.parentPath === '/' ? `/${cleanName}` : `${node.parentPath}/${cleanName}`;
    if (this.nodes.has(newPath)) throw new Error(`EEXIST: Ya existe un nodo en ${newPath}`);

    this.nodes.delete(path);
    node.name = cleanName;
    node.path = newPath;
    node.updatedAt = new Date().toISOString();
    this.nodes.set(newPath, node);

    for (const entry of this.fatTable) {
      if (entry.ownerPath === path) entry.ownerPath = newPath;
    }
    for (const ino of this.inodeTable) {
      if (ino.ownerPath === path) ino.ownerPath = newPath;
    }

    // Si es un directorio, actualizar hijos directos
    for (const child of [...this.nodes.values()]) {
      if (child.parentPath === path) {
        this.nodes.delete(child.path);
        child.parentPath = newPath;
        child.path = `${newPath}/${child.name}`;
        this.nodes.set(child.path, child);
      }
    }

    return node;
  }

  deleteNode(path) {
    if (['/', '/bin', '/etc', '/home', '/pub'].includes(path)) {
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
}
