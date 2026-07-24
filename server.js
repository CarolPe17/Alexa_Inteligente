/**
 * Jarvis — servidor de la skill de Alexa.
 *
 * Alexa manda cada petición aquí (por HTTPS). El servidor la resuelve con
 * Azure OpenAI y responde por voz. Para exponerlo a internet uso un túnel
 * (cloudflared) apuntando al puerto local.
 */

const express = require('express');
const Alexa = require('ask-sdk-core');
const { ExpressAdapter } = require('ask-sdk-express-adapter');
const { AzureOpenAI } = require('openai');

let cfg = {};
try { cfg = require('./config'); } catch (_) { /* en prod uso variables de entorno */ }

const AZURE = {
  apiKey: process.env.AZURE_OPENAI_API_KEY || cfg.AZURE_OPENAI_API_KEY,
  endpoint: process.env.AZURE_OPENAI_ENDPOINT || cfg.AZURE_OPENAI_ENDPOINT,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || cfg.AZURE_OPENAI_API_VERSION || '2024-10-21',
  deployment: process.env.AZURE_OPENAI_DEPLOYMENT || cfg.AZURE_OPENAI_DEPLOYMENT,
};
const azure = new AzureOpenAI(AZURE);

const SYSTEM_PROMPT = `Eres Jarvis, un asistente de voz conversacional y con estilo, a través de un altavoz Alexa.
Reglas:
- Responde SIEMPRE en español de México, cálido, natural y con personalidad.
- Breve: 1 a 3 frases (te escuchan en voz alta).
- Nada de markdown, listas, asteriscos, emojis ni URLs: solo texto que suene bien hablado.
- Sé conversacional: recuerda lo que se dijo antes en esta charla y dale continuidad. Cuando venga al caso, haz una pregunta de seguimiento para seguir platicando.
- Si no sabes algo, dilo con honestidad en una frase.
- Despedida: si la persona se está despidiendo o quiere terminar la charla (dice adiós, gracias, hasta luego, ya, nos vemos, bye, o algo así), despídete cálido en UNA frase corta y agrega al final la etiqueta [FIN]. Usa [FIN] SOLO en ese caso; nunca lo pongas si la conversación sigue.`;

// Historial por sesión de Alexa, para que la charla tenga contexto.
const sesiones = new Map(); // sessionId -> [{ role, content }, ...]

async function responder(texto, sessionId) {
  const historial = sesiones.get(sessionId) || [];
  const resp = await azure.chat.completions.create({
    model: AZURE.deployment,
    max_tokens: 200,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...historial,
      { role: 'user', content: texto },
    ],
  });

  let salida = (resp.choices?.[0]?.message?.content || '').trim() || 'Perdón, no se me ocurrió nada que decir.';
  const despedida = /\[FIN\]/i.test(salida);      // el modelo marca cuando la persona se despide
  salida = salida.replace(/\[FIN\]/gi, '').trim();

  historial.push({ role: 'user', content: texto }, { role: 'assistant', content: salida });
  while (historial.length > 16) historial.shift(); // guardo los últimos ~8 turnos
  sesiones.set(sessionId, historial);

  return { salida, despedida };
}

// Muletilla instantánea mientras el modelo piensa (Alexa corta a los ~8s si no oye nada).
const MULETILLAS = ['Claro.', 'Va.', 'A ver.', 'Sale.', 'Mmm.'];
const muletilla = () => MULETILLAS[Math.floor(Math.random() * MULETILLAS.length)];

async function decirAlInstante(handlerInput, texto) {
  try {
    const ds = handlerInput.serviceClientFactory.getDirectiveServiceClient();
    await ds.enqueue({
      header: { requestId: handlerInput.requestEnvelope.request.requestId },
      directive: { type: 'VoicePlayer.Speak', speech: texto },
    });
  } catch (e) { console.log('   progresiva falló:', e.message); }
}

// Con este directivo Alexa toma lo próximo que diga la persona como el slot completo,
// sin necesidad de frases tipo "pregunta..." o "dime...". Es lo que hace fluida la charla.
const ELICIT_INTENT = {
  name: 'AskIntent',
  confirmationStatus: 'NONE',
  slots: { query: { name: 'query', confirmationStatus: 'NONE' } },
};

const sessionId = (h) => h.requestEnvelope.session && h.requestEnvelope.session.sessionId;

const LaunchRequestHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'LaunchRequest'; },
  handle(h) {
    return h.responseBuilder
      .speak('¡Hola! Soy Jarvis. ¿De qué platicamos?')
      .reprompt('Aquí sigo, dime lo que sea.')
      .addElicitSlotDirective('query', ELICIT_INTENT)
      .getResponse();
  },
};

const AskIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) === 'AskIntent';
  },
  async handle(h) {
    const pregunta = (Alexa.getSlotValue(h.requestEnvelope, 'query') || '').trim();
    if (!pregunta) {
      return h.responseBuilder
        .speak('No te entendí. ¿Me lo repites?')
        .reprompt('¿Qué quieres preguntarme?')
        .getResponse();
    }

    await decirAlInstante(h, muletilla());

    let salida = 'Uy, tuve un problema para pensar la respuesta. ¿Me lo repites?';
    let despedida = false;
    const t0 = Date.now();
    try {
      const r = await responder(pregunta, sessionId(h));
      salida = r.salida; despedida = r.despedida;
    } catch (err) { console.error('Azure error:', err.message); }
    console.log(`   ${Date.now() - t0}ms ${despedida ? '(despedida) ' : ''}→`, salida.slice(0, 60));

    if (despedida) {
      // se despidió: cerramos la sesión de verdad (sin reprompt ni elicit)
      return h.responseBuilder.speak(salida).withShouldEndSession(true).getResponse();
    }
    return h.responseBuilder
      .speak(salida)
      .reprompt('Aquí sigo.')
      .addElicitSlotDirective('query', ELICIT_INTENT)
      .getResponse();
  },
};

const HelpIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.HelpIntent'; },
  handle(h) { return h.responseBuilder.speak('Pregúntame lo que quieras. ¿Qué quieres saber?').reprompt('¿Qué quieres saber?').getResponse(); },
};

const CancelAndStopIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && ['AMAZON.CancelIntent', 'AMAZON.StopIntent'].includes(Alexa.getIntentName(h.requestEnvelope)); },
  handle(h) { return h.responseBuilder.speak('¡Hasta luego!').getResponse(); },
};

const FallbackIntentHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.FallbackIntent'; },
  handle(h) { return h.responseBuilder.speak('Perdón, no te agarré bien. ¿Me lo repites?').reprompt('Aquí sigo.').addElicitSlotDirective('query', ELICIT_INTENT).getResponse(); },
};

const SessionEndedRequestHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'SessionEndedRequest'; },
  handle(h) { sesiones.delete(sessionId(h)); return h.responseBuilder.getResponse(); },
};

const ErrorHandler = {
  canHandle() { return true; },
  handle(h, error) {
    console.error('Error:', error);
    return h.responseBuilder.speak('Algo salió mal. Inténtalo otra vez.').reprompt('¿Qué quieres preguntarme?').getResponse();
  },
};

const skill = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    AskIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler,
  )
  .addErrorHandlers(ErrorHandler)
  .addRequestInterceptors({
    process(h) {
      const t = Alexa.getRequestType(h.requestEnvelope);
      console.log('   REQ:', t, t === 'IntentRequest' ? Alexa.getIntentName(h.requestEnvelope) : '');
    },
  })
  .withApiClient(new Alexa.DefaultApiClient())
  .create();

// Alexa firma cada petición. Verificamos firma y timestamp por defecto;
// se puede desactivar (VERIFY_SIGNATURE=false) para depurar en local.
const verify = process.env.VERIFY_SIGNATURE !== 'false';
const adapter = new ExpressAdapter(skill, verify, verify);

const app = express();
app.use((req, res, next) => {
  if (req.method === 'POST') console.log('POST de Alexa', new Date().toISOString());
  next();
});
app.get('/', (req, res) => res.send('Jarvis OK'));
app.post('/', adapter.getRequestHandlers());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Jarvis escuchando en :${PORT}`));
