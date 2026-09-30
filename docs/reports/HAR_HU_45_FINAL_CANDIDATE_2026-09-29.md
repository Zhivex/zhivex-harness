# HU45: candidato actual verificado

Tarball `1dc3375ab8c4a70a4c100fec45087ee9569d3522970e04be8b4ce65e5a5ea7ec`; 242 archivos dist instalados idénticos. Cada trabajo se declaró antes de ejecutarlo y se conservan planes y observaciones.

| Ruta | Modelo | Base | Compactación | Delegación estructurada | OCI | Continuidad |
| --- | --- | --- | --- | --- | --- | --- |
| anthropic | claude-sonnet-5-5 | pasa | pasa | pasa | pasa | 6/6 |
| vertex | gemini-3.7-flash | pasa | pasa | pasa | pasa | 6/6 |
| gemini | gemini-3.6-flash | pasa | pasa | pasa | pasa | 6/6 |
| openai | gpt-6-luna | pasa | pasa | pasa | pasa | 6/6 |
| qwen | qwen3.8-max | pasa | pasa | pasa | pasa | 6/6 |
| meta | muse-spark-1.3 | pasa | pasa | pasa | pasa | 6/6 |

Routing seleccionado: OpenAI→Vertex, OpenAI→Anthropic, OpenAI→Gemini y Qwen→Meta; 4/4 pasan. No representa toda la matriz dirigida. Base comprueba aprobación durable, reinicio real y un único efecto. La continuidad comprende seis procesos/turnos por modelo (36/36). Delegación exige contrato estructurado aceptado y persistencia al reabrir.

Las regresiones instaladas adicionales de este hash pasan en Node 22.13: nueve escenarios de entrega OCI y 18 fases/nueve escenarios de delegación, con modelos determinísticos. Evidencia separada en HAR_HU_51_FINAL_TASK_ACCEPTANCE_OCI_INSTALLED y HAR_HU_51_FINAL_DELEGATION_RESULT_INSTALLED.

Suite local actual: 1878 pass, 1 skip, 0 fail. Build, tipos, arquitectura, contratos y docs pasan. El posterior ajuste del inventario del piloto fue validado con tipos y preparación de un plan que exige igualdad de versiones y bytes SDK; no modifica el runtime del tarball.

Son gates sintéticos seleccionados, no certificación protegida de release ni fiabilidad general de producción. No hay publicación, commit, push o PR nuevo. Se conserva por separado la evidencia de todos los candidatos anteriores, incluidos sus fallos. El piloto de calidad de HU51 usa este mismo hash y tiene sus propios resultados y límites.

Datos completos: HAR_HU_45_FINAL_CANDIDATE_2026-09-29.json.
