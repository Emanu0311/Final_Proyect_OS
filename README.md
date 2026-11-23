# Minikernel OS 2026-2 — Simulador Web de Sistema Operativo Modular

Diseño, modelado formal y simulación web interactiva de un **Sistema Operativo modular bajo arquitectura Microkernel / Minikernel**, desarrollado para la asignatura **Sistemas Operativos** de la **Universidad Distrital Francisco José de Caldas** (Facultad de Ingeniería — Proyecto Curricular de Ingeniería de Sistemas).

---

## Descripción del Proyecto

El proyecto implementa un núcleo mínimo privilegiado (**Minikernel**) que aísla las primitivas esenciales del sistema y delega la gestión de recursos a **cinco servidores independientes en espacio de usuario**, los cuales operan sin acoplamiento directo y se comunican exclusivamente mediante transacciones inmutables `IPCMessage` a través del bus central (`IPCBus`).

### Arquitectura General

- **Núcleo Privilegiado (`src/core/`)**:
  - `Kernel.js`: Reloj maestro (`SystemClock` con ejecución continua, paso a paso y frecuencia configurable), conmutación de contexto con penalización explícita ($T_{cs}$), despachador de llamadas al sistema (`SyscallDispatcher`) y controlador vectorizado de interrupciones (`InterruptController` / IVT).
  - `IPCMessage.js`: Estructura transaccional `IPCMessage` y bus `IPCBus` con mediación pre-despacho de seguridad (ACL) y trazabilidad en vivo.
- **Servidores en Espacio de Usuario (`src/servers/`)**:
  1. **Módulo 2.1 — Administración de Procesos (`ProcessManager.js`)**: Creación y gestión de `PCB` con registros simulados (`PC`, `SP`, `Acc`), colas de estado (`Ready`, `Running`, `Blocked`, `Terminated`), planificación parametrizable (**Round Robin**, **Prioridades Apropiativas**, **SJF/SRTF**), sincronización con semáforos/mutex (`WAIT`/`SIGNAL`) y prevención de interbloqueos mediante el **Algoritmo del Banquero**.
  2. **Módulo 2.2 — Administración de Memoria (`MemoryManager.js`)**: Espacio físico simulado de `1024 KB` (`128 KB` reservados para el Kernel y `896 KB` para procesos de usuario), asignación en **Particiones Fijas (`STATIC_FIXED`)** y **Particiones Dinámicas (`DYNAMIC_VARIABLE`: `First-Fit`, `Best-Fit`, `Worst-Fit`)** con *splitting*, *coalescing* y análisis en tiempo real de fragmentación interna y externa.
  3. **Módulo 2.3 — Administración de Archivos (`FileManager.js`)**: Árbol jerárquico de directorios (`/`, `/bin`, `/etc`, `/home`, `/pub`), formateo intercambiable entre tablas **FAT** e **Inodos**, y operaciones CRUD (`SYS_CREATE_NODE`, `SYS_READ_FILE`, `SYS_WRITE_FILE`, `SYS_RENAME_NODE`, `SYS_DELETE_NODE`) acopladas por IPC al controlador de disco.
  4. **Módulo 2.4 — Entrada/Salida y Red (`DeviceDriver.js`)**: Geometría configurable de disco (`DiskGeometry`), algoritmos de planificación de brazo (**FCFS**, **SSTF**, **SCAN**, **C-SCAN**), canal **DMA (`DMAController`)** concurrente con interrupción `IRQ_DMA_DONE` y sockets de red simulados (`TX`/`RX`).
  5. **Módulo 2.5 — Seguridad y Auditoría (`SecurityController.js`)**: Autenticación y perfiles (`root` / `ROOT`, `std_user` / `STANDARD`, `guest` / `GUEST`), validación de matriz **ACL** y permisos `rwx`, protección de fronteras de memoria (`TRAP_SIGSEGV`), detección de escalamiento de privilegios y bitácora forense inmutable (`SecurityAuditLog` sellada con `Object.freeze` y hash encadenado).
- **Persistencia (`src/persistence/PersistenceStore.js`)**: Guardado automático en `LocalStorage` e `IndexedDB`, además de exportación de instantáneas en formato JSON.
- **Interfaz Web (`index.html`, `styles/main.css`, `src/ui/AppController.js`)**: Consola interactiva en tiempo real con control del reloj maestro, selector de sesión, monitor del bus IPC, auditoría anti-fallas y paneles dedicados para cada uno de los cinco módulos.

---

## Estructura del Repositorio

```text
.
├── index.html                          # Interfaz web principal del simulador
├── package.json                        # Metadatos y scripts de ejecución/pruebas
├── Guia_Proyecto_Minikernel_SO2026_2.pdf
├── src/
│   ├── core/
│   │   ├── Kernel.js                   # Reloj maestro, T_cs, IVT y syscalls
│   │   └── IPCMessage.js               # Bus IPC y mensajes transaccionales
│   ├── servers/
│   │   ├── ProcessManager.js           # Procesos, PCB, planificación y Banquero
│   │   ├── MemoryManager.js            # Memoria estática/dinámica y fragmentación
│   │   ├── FileManager.js              # Sistema de archivos FAT / Inodos
│   │   ├── DeviceDriver.js             # Disco, brazo, DMA y sockets de red
│   │   └── SecurityController.js       # Perfiles, ACL y logs inmutables
│   ├── persistence/
│   │   └── PersistenceStore.js         # Persistencia LocalStorage / IndexedDB
│   └── ui/
│       └── AppController.js            # Controlador reactivo de la interfaz web
├── styles/
│   └── main.css                        # Estilos de la consola de simulación
├── tests/
│   └── verify_minikernel.js            # Suite automatizada de verificación
└── docs/
    ├── Informe_Tecnico_IEEE_Minikernel_SO2026_2.md
    ├── Informe_Tecnico_IEEE_Minikernel_SO2026_2.tex
    ├── Informe_Tecnico_IEEE_Minikernel_SO2026_2.pdf
    └── especialidades/                 # Especificaciones técnicas por módulo
```

---

## Requisitos Previos

- **Python 3** (para servir la aplicación web estática con módulos ES6).
- **Node.js** (para ejecutar la suite de pruebas automatizadas).
- Navegador web moderno con soporte para ES Modules.

---

## Ejecución y Pruebas

### 1. Iniciar el simulador web

```bash
npm start
```

Esto levanta un servidor HTTP local (`python3 -m http.server 8080`). Luego abre en tu navegador:

```text
http://localhost:8080
```

### 2. Ejecutar las pruebas automatizadas

```bash
npm test
```

Ejecuta `node ./tests/verify_minikernel.js`, verificando los cinco módulos del Minikernel, el bus IPC, los algoritmos de planificación/Banquero/memoria/disco, el control de acceso ACL, la inmutabilidad de los logs de auditoría y la correspondencia de los identificadores del DOM entre `index.html` y `src/ui/AppController.js`.

---

## Documentación Técnica

En la carpeta [`docs/`](./docs/) se encuentra la documentación formal del proyecto bajo estándar IEEE:

- [Informe Técnico IEEE (`Markdown`)](./docs/Informe_Tecnico_IEEE_Minikernel_SO2026_2.md) y su versión compilada en [PDF](./docs/Informe_Tecnico_IEEE_Minikernel_SO2026_2.pdf).
- Especificaciones detalladas por especialidad en [`docs/especialidades/`](./docs/especialidades/):
  - `01_Core_IPC_Especificacion.md`
  - `02_Procesos_Memoria_Especificacion.md`
  - `03_Archivos_ES_Persistencia_Especificacion.md`
  - `04_Seguridad_ACL_Auditoria_Especificacion.md`
  - `05_Frontend_UX_QA_Trazabilidad.md`
