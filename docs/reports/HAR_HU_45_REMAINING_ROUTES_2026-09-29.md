# Rutas restantes y continuidad firmada

Tras autorización explícita se ejecutó base para Qwen qwen3.8-max, Meta muse-spark-1.3 y Gemini API gemini-3.6-flash sobre db853c7a960c419f24cbd8e881b83997252b832c120133b5e9616345f1a227ac. Qwen/Meta pasan aprobación, reinicio y efecto único. Gemini responde HTTP 402 antes de editar; el cuerpo clasificado indica rate_limit. No se atribuye a schema ni IAM y no se repite ni se ejecutan otros gates para esa ruta. Se conserva el fallo histórico de otro modelo sin equipararlo a esta combinación.

Qwen y Meta pasan delegación estructurada con aceptación/reapertura, ejecución OCI, continuidad seis turnos cada uno y routing Qwen a Meta. Junto a HAR_HU_45_VERIFIED_COHORT acredita los gates seleccionados para cinco rutas sobre el mismo artefacto; no acredita Gemini API ni una matriz exhaustiva de routing.

Nueva regresión reproducible: scripts/provider-compaction-installed-smoke.ts instala el tarball y ejecuta request/resume en procesos Node 22.13 distintos para Vertex, Anthropic y Gemini. Cada fase usa un único request a transporte simulado con endpoint verificado. Se fuerza compactación antes de la llamada y otra después de persistir la llamada firmada y reabrir. El payload de continuación debe conservar firma, ID y recibo; la aprobación produce un único efecto/journal. Seis fases pasan. Vertex recibe un callback de token fixture: no prueba ADC/IAM. Las firmas son sintéticas: no prueba aceptación de firmas por servidores live.

El primer montaje del fixture Anthropic omitía input_json_delta y fue corregido para representar el protocolo SSE real; no fue un fallo de proveedor ni se relajó el producto. También se corrigió el umbral del fixture al mínimo permitido de cuatro mensajes. Resultado final con hashes en HAR_HU_45_SIGNED_COMPACTION_INSTALLED_2026-09-29.json. Tooling typecheck aprobado.

Comando: bun run scripts/provider-compaction-installed-smoke.ts /ruta/candidato.tgz /ruta/node

Pendiente: acceso live Gemini API para HU42/HU45/HU57; completar cualquier combinación anunciada fuera de las verificadas y preparar continuidad live específica si la certificación exige firmas emitidas por servidor tras compactar. HU51 mantiene elección de herramientas/modo del piloto pendiente. No hay commit, push, PR ni publicación.
