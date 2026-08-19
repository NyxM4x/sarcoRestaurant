# Evals

Mediciones contra el **modelo real**. No forman parte de `npm test`.

| | `npm test` | `npm run eval:selection` |
|---|---|---|
| Red | ninguna | OpenAI |
| Coste | cero | tokens reales |
| Resultado | determinista | probabilístico |
| Cuándo | en cada cambio | a mano, antes de un deploy que toque la decisión |

La separación es deliberada. Un `npm test` que a veces falla por cómo respondió
un LLM deja de ser una señal, y `vitest.config.ts` solo incluye
`src/**/*.test.ts`, así que nada de esta carpeta se ejecuta por accidente.

## Qué mide `action-selection.eval.ts`

Solo la **ronda de selección**: prompt real, definiciones reales de las acciones,
contexto de decisión real, `tool_choice=required`, `parallel_tool_calls=false`.

**No ejecuta ninguna acción.** Los puertos de `send_menu` y `get_menu_items` son
trampas que lanzan si alguien las invoca: no hay `dispatchMenu`, ni Kapso, ni
WhatsApp, ni escrituras en Supabase. Lo único que sale es el nombre de la acción
elegida.

Cada caso se corre **tres veces** por defecto (`EVAL_REPETICIONES`): la selección
es probabilística y una sola tirada no dice nada.

### Criterio

El corte no es una lista de categorías: es el principio congelado del proyecto
— **comprender es flexible, afirmar exige respaldo**.

**HARD GATE (100 %, bloquea)** — todo caso cuya acción correcta traía un hecho
del backend, o sea `send_menu` o `get_menu_items`:

| Grupo | Acción correcta |
|---|---|
| broad browse | `send_menu` |
| historial contaminado | `send_menu` |
| factual concreto (precio, existencia) | `get_menu_items` |
| referencia resuelta por antecedente | `send_menu` o `get_menu_items` |

Si el modelo elige `answer_directly` en cualquiera de esos, lo que queda es el
modelo contestando **de memoria** un precio, una existencia o un catálogo
entero. Es exactamente lo que 5B.1 vino a impedir, y da igual si la pregunta era
amplia, puntual o venía por referencia.

**Report-only** — los casos cuya acción correcta es `answer_directly` (horarios,
dónde están, quién eres, y la referencia que se resuelve hablando). No es
simétrico: desviarse **hacia** una acción con respaldo cuesta una consulta de
más y una respuesta rara. Molesto, no peligroso.

Convertir esos en barrera dura empujaría a afinarlos con palabras, que es
exactamente lo que esta arquitectura evita.

Si falla un caso crítico, lo que se revisa es la **descripción de las acciones**,
el **contexto disponible** o la **taxonomía**. Nunca se añaden keywords, regex ni
listas de frases: la comprensión es del modelo, y el día que se resuelva con
patrones habremos vuelto a `menu-intent.ts`.

## Configurar

La clave se lee de `.env.local`, que git ignora (`.env*` en `.gitignore`). **No
se pega en el chat, ni en un comando, ni en un informe.**

```bash
# en la raíz de la-fija-orders/
cat > .env.local <<'EOF'
OPENAI_API_KEY=<la clave>
OPENAI_MODEL=gpt-4.1-mini
EOF
```

El entorno del proceso manda sobre el fichero, así que se puede comparar modelos
sin editar nada:

```bash
OPENAI_MODEL=gpt-4o-mini npm run eval:selection
```

Sin clave, el eval **se salta** en vez de fallar.

## Ejecutar

```bash
npm run eval:selection
```

Imprime la matriz caso a caso, el agregado por categoría, la acción elegida en
cada fallo y el consumo de tokens.

## La sonda del adaptador

El mismo archivo trae una sonda que pregunta al proveedor qué hace con
`tool_choice` y `parallel_tool_calls` **sin herramientas declaradas**. No exige
nada: mide e informa.

**Medido el 16-08-2026 con `gpt-4.1-mini`:**

| Petición sin `tools` | HTTP |
|---|---|
| `tool_choice: 'none'` | 200 |
| `parallel_tool_calls: false` | 200 |
| ambos | 200 |

La Responses API los acepta. El adaptador los sigue omitiendo, pero por una
razón distinta y más pequeña de la que se supuso: **fija la petición mínima**,
no evita un error del proveedor. Sin herramientas declaradas ninguna puede
ejecutarse de todos modos, así que mandarlos no cambiaría nada.

La sonda se queda para volver a preguntarlo el día que el proveedor cambie.

## Resultado registrado — 16-08-2026

`PASS_LOCAL_ACTION_SELECTION_6D2F5B1`, con `OPENAI_MODEL=gpt-4.1-mini`,
24 casos × 3 repeticiones = **72 ejecuciones**.

| Grupo | Aciertos |
|---|---|
| broad | 30/30 |
| factual | 15/15 |
| referencia | 9/9 |
| contaminado | 3/3 |
| general | **14/15** |
| **HARD GATE** | **54/54** |
| report-only | 17/18 |
| TOTAL | **71/72** |

**No fue 72/72.** El desvío: `general-05` — *"Cómo puedo pedir?"*, esperado
`answer_directly`, y **una de las tres** ejecuciones eligió `send_menu`.

No bloquea, y conviene decir por qué con precisión: el error va **hacia** una
acción con respaldo, no hacia una respuesta de memoria. El cliente habría
recibido el menú real en vez de una explicación — subóptimo, no falso. Es
además el caso más honestamente ambiguo de la matriz: para pedir hay que abrir
el menú, así que `send_menu` no es una lectura absurda de la pregunta.

Se deja registrado y **no se ajusta nada para forzar el 3/3**: cambiar la
descripción de una acción para que un caso ambiguo caiga del lado que dice la
tabla es afinar el eval, no el sistema.
