# HAR-HU-13–20 — implementation plan

Baseline: `94bd3ab` (includes HU-15). Branch: `feat/har-hu-13-20-daily-cli`.

Re-use existing 1.0 mechanisms; Node remains the runtime and Bun the development tool.

## HAR-HU-13 — Completar el primer uso desde un entorno limpio

Source: https://app.notion.com/p/3e1777b104f6813f907decef6f5ba3a2?pvs=204

- [x] Un entorno limpio permite elegir perfil/proveedor, validar credenciales sin mostrarlas y abrir un repositorio de ejemplo.
- [x] El recorrido completa una tarea con edición, aprobación, check y diff usando el paquete instalado.
- [x] Credencial ausente, proveedor no disponible y OCI ausente muestran una acción de recuperación; no se amplía soporte por inferencia.

## HAR-HU-14 — Establecer la baseline de calidad y fricción del producto

Source: https://app.notion.com/p/3e1777b104f681859487f45b5df8abc4?pvs=204

- [x] Se predeclaran al menos 10 tareas de lectura, reparación y cambio funcional, separando desarrollo y evaluación nueva.
- [ ] Cada intento registra versión, proveedor/modelo, límites, resultado independiente, latencia, uso y número de intervenciones.
- [ ] Se publican fallos y tareas incompletas; el costo desconocido se marca como tal y se conserva el dataset para comparar mejoras.

## HAR-HU-15 — Pulir la entrada y el streaming de la consola

Source: https://app.notion.com/p/3e1777b104f681c2b4f2dbe0f04a75e5?pvs=204

- [x] Entrada multilínea, pegado, historial y navegación por teclado funcionan sin enviar instrucciones accidentalmente.
- [x] El streaming distingue texto, actividad, espera de aprobación y finalización sin corromper la entrada.
- [x] Ctrl+C cancela con limpieza y vuelve al prompt; resize y errores del proveedor conservan el texto recuperable y sanitizan controles de terminal.

## HAR-HU-16 — Navegar y recuperar sesiones por proyecto

Source: https://app.notion.com/p/3e1777b104f6818d8b92eb0d1406be4e?pvs=204

- [x] La CLI permite listar, buscar, renombrar y continuar sesiones filtradas por proyecto.
- [x] Tras reinicio muestra el estado durable real y las aprobaciones pendientes antes de continuar.
- [x] Sesiones de proyectos distintos no mezclan contexto; cancelar o continuar repetidamente no repite efectos.

## HAR-HU-17 — Inspeccionar y controlar el contexto de una tarea

Source: https://app.notion.com/p/3e1777b104f68166b072ce858d286b0e?pvs=204

- [x] Se muestran archivos adjuntos, reglas/skills activas, límites y razones de exclusión.
- [x] Agregar o quitar contexto tiene efecto explícito sobre la siguiente solicitud; se detectan adjuntos modificados.
- [x] Rutas fuera del workspace y archivos secretos siguen excluidos; truncamiento y compacción quedan visibles.

## HAR-HU-18 — Revisar y aprobar cambios desde la terminal

Source: https://app.notion.com/p/3e1777b104f681aeaf1eec13b86d1c11?pvs=204

- [x] La revisión muestra archivos añadidos, modificados y eliminados, comandos relevantes y resultado de verificaciones.
- [x] Aprobar o rechazar identifica exactamente el parche/acción y su alcance; workspace o parche obsoletos invalidan la aprobación.
- [x] Un rechazo o error conserva un resultado inspeccionable; ningún resumen declara éxito cuando faltan checks requeridos.

## HAR-HU-19 — Mostrar uso y aplicar presupuestos multi-provider

Source: https://app.notion.com/p/3e1777b104f6817581d9f607b72a94a8?pvs=204

- [x] Uso y costos se contabilizan por proveedor/modelo y se agregan sin doble conteo de subagentes o reanudaciones.
- [x] Precios ausentes o desactualizados y estimaciones se distinguen de consumo confirmado; se define y prueba la política de bloqueo para límites monetarios no calculables.
- [x] El presupuesto sobrevive a reinicios y se comprueba antes de nuevas llamadas; hay regresiones para rutas heterogéneas, fallo parcial y cierre de tarea.

## HAR-HU-20 — Validar la CLI en un piloto de trabajo diario

Source: https://app.notion.com/p/3e1777b104f68184b268e16bbba2b879?pvs=204

- [ ] Se ejecuta la cohorte predeclarada con el artefacto instalado y al menos dos repositorios representativos.
- [ ] El informe compara corrección, tiempo, consumo e intervenciones con la baseline, conservando fallos y límites.
- [ ] Se registran fricciones priorizadas y una decisión explícita de salida; no se declara paridad competitiva a partir de smoke tests.

## Execution order and evidence

1. Close session discovery/context/review gaps (16–18); preserve existing HU-15.
2. Add durable per-route usage accounting and fail-closed monetary budgets (19).
3. Package-install clean onboarding demo including failure recovery (13).
4. Freeze a cohort of at least 10 tasks, independent correctness criteria and development/evaluation split before model execution (14).
5. Run baseline and candidate installed artifacts against isolated copies of two real repositories; retain failures, unknown costs and an explicit release decision (20).
6. Run relevant regressions, full suite, types, contracts, docs, installed-package/PTY checks; record commit and update Notion from actual evidence.

No release or live certification is inferred from offline fixtures. The prepared cohort uses isolated Harness and TypeScript SDK snapshots. Live baseline and candidate evaluation remain pending explicit authorization following automatic approval review rejection. Monetary prices must have source/date/expiry; missing or stale prices cannot satisfy a monetary cap.

