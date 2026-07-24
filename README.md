# Jarvis

Una skill de Alexa que convierte el Echo en un asistente con el que se puede **platicar de verdad**, en vez de solo pedirle cosas sueltas. Abres la skill, le hablas normal, te contesta con voz, recuerda el hilo de la charla y le puedes cambiar de tema sin repetir "Alexa" cada vez. Cuando te despides, cierra la sesión sola.

El cerebro es Azure OpenAI (`gpt-4.1-mini`). El servidor corre en Node y Alexa le pega por HTTPS.

```
tu voz → Alexa → este servidor (Express) → Azure OpenAI → respuesta hablada
```

## Cómo funciona

Alexa manda cada interacción como una petición HTTP a un endpoint. Este servidor la recibe, la resuelve contra Azure OpenAI y responde. Dos detalles hacen que se sienta como una conversación y no como una skill normal:

- **Slot libre.** Después de cada respuesta se emite un directivo `Dialog.ElicitSlot`, así Alexa toma lo *siguiente* que digas como la pregunta completa, sin necesitar frases tipo "pregunta..." o "dime...". Requiere un `dialog model` definido en el modelo de interacción (ver `skill-package/`).
- **Memoria por sesión.** Se guarda el historial de la charla en memoria, indexado por `sessionId`, para darle contexto a cada respuesta.
- **Cierre natural.** El modelo marca cuando la persona se está despidiendo y ahí sí se cierra la sesión.

## Correr en local

Requisitos: Node 18+, una skill de Alexa tipo *Custom* (endpoint propio) y un recurso de Azure OpenAI con un deployment.

```bash
npm install
cp config.example.js config.js   # y pon tus credenciales de Azure
npm start                         # levanta el servidor en el puerto 3000
```

Como Alexa necesita un endpoint HTTPS público, expón el puerto local con un túnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Copia la URL `https://...` que te da y ponla como endpoint de la skill (Build → Endpoint) con certificado *Wildcard*.

## El modelo de interacción

En `skill-package/interactionModels/` está el modelo para `es-MX` y `es-US`. Lo importante:

- `invocationName`: `jarvis`
- Un intent `AskIntent` con un slot `query` de tipo `AMAZON.SearchQuery`.
- Un `dialog` model con `delegationStrategy: SKILL_RESPONSE` — sin esto, el directivo `ElicitSlot` no es válido y Alexa cierra la sesión.

Para desplegar el modelo con el ASK CLI:

```bash
ask smapi set-interaction-model -s <skill-id> -g development -l es-MX \
  --interaction-model file:skill-package/interactionModels/custom/es-MX.json
```

## Configuración

`config.js` (ignorado por git) o variables de entorno:

| Variable | Descripción |
|---|---|
| `AZURE_OPENAI_API_KEY` | Llave del recurso de Azure OpenAI |
| `AZURE_OPENAI_ENDPOINT` | `https://TU-RECURSO.openai.azure.com/` |
| `AZURE_OPENAI_API_VERSION` | Por defecto `2024-10-21` |
| `AZURE_OPENAI_DEPLOYMENT` | Nombre del deployment, ej. `gpt-4.1-mini` |
| `PORT` | Puerto del servidor (default `3000`) |
| `VERIFY_SIGNATURE` | `false` para saltar la verificación de firma en local |

## Pendientes

- Hosting 24/7 (ahorita depende de tener el servidor y el túnel corriendo).
- Memoria persistente entre sesiones, no solo dentro de una charla.
- Control de casa inteligente y recordatorios.
