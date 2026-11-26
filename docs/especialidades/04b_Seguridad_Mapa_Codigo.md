# Mapa de Código — Módulo 2.5: Seguridad, ACL, Auditoría y Terminal Web

**Proyecto:** Minikernel OS 2026-2 (Universidad Distrital Francisco José de Caldas)  
**Complemento de:** `04_Seguridad_ACL_Auditoria_Especificacion.md`  
**Rama de trabajo:** `brayan/seguridad` (local; sin publicación en `origin`)

Este documento inventaría todos los archivos de código que participan en la sección de seguridad y explica el flujo de autenticación que compuerta la Terminal Web, el comando `whoami` y la trazabilidad de auditoría asociada.

---

## 1. Inventario de archivos

| Archivo | Responsabilidad en el módulo 2.5 | Símbolos / puntos clave | Acciones IPC relacionadas |
| :--- | :--- | :--- | :--- |
| `src/servers/SecurityController.js` | Servidor de seguridad en espacio de usuario. Catálogo de cuentas, matriz ACL, guard IPC, bitácora forense y compuerta de la terminal. | `UserAccount`, `SecurityAuditLog`, `SecurityController.authenticate()`, `hasActiveSession()`, `validateIPCMessage()`, `recordAudit()`, `_recordTerminalAccessDenied()`, `simulateSecurityAttack()` | `SYS_AUTH_LOGIN`, `GET_ACTIVE_SESSION`, `SEC_TERMINAL_ACCESS_DENIED`, `SIMULATE_SECURITY_ATTACK`, `SEC_REPORT_DMA_FAULT` |
| `src/ui/AppController.js` | Capa de presentación del panel 2.5: formulario de autenticación, pruebas de intrusión, matriz ACL, bitácora y Terminal Web. | `_bindDOMEvents()`, `executeTerminalCommand()`, `_renderSecurityPanel()`, `terminalHistory` | Envía todas las acciones anteriores mediante `Kernel.sendIPC()` |
| `src/core/Kernel.js` | Mediación del bus: inyecta el `authContext` activo en cada mensaje y registra el hook del Reference Monitor. | `setSecurityGuard()`, `sendIPC()`, `_getCurrentAuthContext()` | Todas; el guard se aplica salvo en mensajes dirigidos al propio `SECURITY_SERVER` |
| `src/core/IPCMessage.js` | Define el sobre transaccional con `authContext`, el `IPCBus` y el despacho con veredicto ACL pre-entrega. | `IPCMessage`, `IPCBus.dispatch()` | `ACCEPTED` / `REJECTED` / `SUCCESS` |
| `src/servers/FileManager.js` | Aplica la ACL `rwx` sobre el árbol de archivos antes de mutar bloques FAT/Inodo. | `_canAccess()`, `_assertAccess()`, `_assertDirEntryChange()` | `SYS_READ_FILE`, `SYS_WRITE_FILE`, `SYS_CREATE_NODE`, `SYS_RENAME_NODE`, `SYS_DELETE_NODE` |
| `src/persistence/PersistenceStore.js` | Persiste `activeUserRole` y los eventos de auditoría, segregados del FS simulado. | `saveSnapshot()` (`activeUserRole`, `securityLogs`) | — |
| `index.html` | Marcado del panel 2.5: formulario `form-security-login`, botones de intrusión, tabla ACL, `web-terminal-output` y `form-web-terminal`. | IDs: `sec-login-user`, `sec-login-pass`, `acl-matrix-tbody`, `security-audit-tbody`, `terminal-cmd-input`, `btn-web-terminal-exec` | — |
| `styles/main.css` | Presentación de la consola y estado deshabilitado de la CLI. | `.terminal-output`, `#form-web-terminal :disabled` | — |
| `tests/verify_minikernel.js` | Verificación de ACL, inmutabilidad de logs, compuerta de sesión y correspondencia de IDs DOM. | Bloque 5 y comprobaciones de `hasActiveSession()` | `SYS_AUTH_LOGIN`, `SEC_TERMINAL_ACCESS_DENIED` |
| `docs/especialidades/04_Seguridad_ACL_Auditoria_Especificacion.md` | Especificación formal de RF-25 a RF-30 y RNF-10 a RNF-12. | Matriz de requerimientos, CU-09, CU-10 | — |

---

## 2. Compuerta de autenticación de la Terminal Web

El simulador arranca con `activeUser = root` para que los otros cuatro módulos sigan operando, pero `SecurityController.sessionAuthenticated = false`. La terminal consulta **el estado de sesión, no el rol**, por lo que el perfil root inicial no basta para usarla.

```text
[BOOT] sessionAuthenticated = false  →  input y botón "Ejecutar" deshabilitados
       ↓ (botón "Autenticar (SYS_AUTH_LOGIN)" del panel 2.5)
SYS_AUTH_LOGIN { source: 'SECURITY_PANEL_LOGIN' }  →  sessionAuthenticated = true
       ↓
executeTerminalCommand() ejecuta comandos normalmente
```

### Orígenes de login (`payload.source`)

| Origen | Efecto sobre la compuerta | Quién lo envía |
| :--- | :--- | :--- |
| `SECURITY_PANEL_LOGIN` | Fuerza `true` (único medio de desbloqueo) | Botón del formulario del panel 2.5 |
| `TOP_BAR_SESSION` | Fuerza `false` (evita atajo desde la barra superior) | Selector `select-active-user` |
| `TERMINAL_SU` | Conserva el estado (la CLI ya estaba desbloqueada) | Comando `su <usuario>` |
| `INTERNAL` (por defecto) | Conserva el estado | Llamadas directas y pruebas automatizadas |

Si se intenta un comando sin sesión autenticada, `AppController.executeTerminalCommand()` envía `SEC_TERMINAL_ACCESS_DENIED`, imprime `[DENEGADO] ...` en la consola y no ejecuta la operación. El servidor registra el evento `TERMINAL_ACCESS_DENIED` (severidad `WARNING`, veredicto `DENY`) en la bitácora inmutable.

El estado **no se persiste**: al recargar la página la terminal vuelve a quedar bloqueada, incluso si el snapshot guarda `activeUserRole`.

---

## 3. Comandos de la Terminal Web

| Comando | Descripción | Requiere sesión |
| :--- | :--- | :--- |
| `whoami` | Muestra usuario, rol, UID y `userId` consultando `GET_ACTIVE_SESSION` vía IPC. | Sí |
| `help` | Lista los comandos disponibles. | Sí |
| `ps` / `mem` / `disk` | Estado de procesos, fragmentación de memoria y controlador de disco. | Sí |
| `ls [ruta]` / `cat <ruta>` | Navegación y lectura del FS simulado (sujeta a ACL). | Sí |
| `fork <nombre> <kb>` / `kill <pid>` | Syscalls de procesos mediadas por el guard ACL. | Sí |
| `su <root\|std_user\|guest>` | Cambia de perfil conservando el estado de la compuerta. | Sí |
| `audit` | Últimos cuatro eventos de `SecurityAuditLog` con su hash encadenado. | Sí |
| `clear` | Limpia el historial local de la terminal. | Sí |

---

## 4. Verificación local

```bash
npm test
```

La suite comprueba, entre otros aspectos, que la terminal nace bloqueada, que un login con `source: 'SECURITY_PANEL_LOGIN'` la habilita, que `TOP_BAR_SESSION` la vuelve a bloquear y que el intento denegado genera un evento de auditoría. También valida que todo `getElementById` usado por `AppController.js` —incluido `btn-web-terminal-exec`— exista en `index.html`.

Para probar la interfaz: `npm start`, abrir `http://localhost:8080`, ir a la pestaña **2.5 Seguridad**, verificar que el input está deshabilitado, autenticar con `root` / `root` y ejecutar `whoami`.
