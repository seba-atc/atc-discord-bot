#!/usr/bin/env node
/**
 * ─── ATC Discord Requirements Bot ─────────────────────────────────────────
 *
 * INSTALACIÓN:
 *   npm install discord.js @anthropic-ai/sdk dotenv
 *
 * VARIABLES DE ENTORNO (.env.pipeline):
 *   DISCORD_TOKEN                → Token del bot
 *   DISCORD_TRIGGER_CHANNEL_ID   → Canal donde se escucha !req
 *   DISCORD_NOTIFY_CHANNEL_ID    → Canal donde se anuncia cada ticket creado
 *   CLICKUP_API_TOKEN            → Token de ClickUp
 *   CLICKUP_LIST_ID_TORNEOS      → ID de la lista de Torneos
 *   CLICKUP_LIST_ID_LISTA        → ID de la lista de Lista de Espera
 *   ANTHROPIC_API_KEY            → API key de Anthropic
 *
 * USO:
 *   !req torneos <descripción>   → requerimiento para Torneos
 *   !req lista <descripción>     → requerimiento para Lista de Espera
 *   !req <descripción>           → el bot pregunta el proyecto
 *
 * COMANDOS EN EL HILO:
 *   !req cancelar  → cancela la conversación
 *   !req forzar    → fuerza la creación del ticket con lo que hay
 */

const {
  Client,
  GatewayIntentBits,
  Events,
  ThreadAutoArchiveDuration,
} = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const fs   = require('fs');
const path = require('path');

// ─── Cargar .env ───────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env.pipeline');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

// ─── Proyectos disponibles ─────────────────────────────────────────────────
// Para agregar un proyecto nuevo: agregar acá + CLICKUP_LIST_ID_XXX en .env.pipeline
const PROJECTS = {
  torneos: {
    name:   'Torneos',
    listId: process.env.CLICKUP_LIST_ID_TORNEOS,
    emoji:  '🏆',
  },
  lista: {
    name:   'Lista de Espera',
    listId: process.env.CLICKUP_LIST_ID_LISTA,
    emoji:  '📋',
  },
};

const PROJECT_KEYS    = Object.keys(PROJECTS);
const PROJECT_CHOICES = PROJECT_KEYS.map(k => `\`${k}\``).join(' · ');

// ─── Config ────────────────────────────────────────────────────────────────
const DISCORD_TOKEN              = process.env.DISCORD_TOKEN;
const DISCORD_TRIGGER_CHANNEL_ID = process.env.DISCORD_TRIGGER_CHANNEL_ID || null;
const DISCORD_NOTIFY_CHANNEL_ID  = process.env.DISCORD_NOTIFY_CHANNEL_ID  || null;
const CLICKUP_API_TOKEN          = process.env.CLICKUP_API_TOKEN;
const ANTHROPIC_API_KEY          = process.env.ANTHROPIC_API_KEY;

const MODEL_REQUIREMENTS = process.env.CLAUDE_MODEL_REQUIREMENTS || 'claude-haiku-4-5-20251001';
const MODEL_DOCUMENTADOR = process.env.CLAUDE_MODEL_DOCUMENTADOR || 'claude-haiku-4-5-20251001';

const MAX_TURNS          = 10;
const INACTIVITY_TIMEOUT = 30 * 60 * 1000;
const STATE_FILE         = path.join(__dirname, '.requirements-state.json');

// ─── Logger ────────────────────────────────────────────────────────────────
const ts       = () => new Date().toISOString();
const log      = (...a) => console.log( `[${ts()}]`, ...a);
const logError = (...a) => console.error(`[${ts()}]`, ...a);

// ─── Validar env ───────────────────────────────────────────────────────────
const missing = ['DISCORD_TOKEN', 'CLICKUP_API_TOKEN', 'ANTHROPIC_API_KEY',
                 'CLICKUP_LIST_ID_TORNEOS', 'CLICKUP_LIST_ID_LISTA']
  .filter(k => !process.env[k]);
if (missing.length) {
  logError(`❌ Variables de entorno faltantes: ${missing.join(', ')}`);
  process.exit(1);
}

// ─── Anthropic ─────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── ClickUp API ───────────────────────────────────────────────────────────
async function clickupFetch(endpoint, options = {}) {
  const res = await fetch(`https://api.clickup.com/api/v2${endpoint}`, {
    ...options,
    headers: {
      Authorization: CLICKUP_API_TOKEN,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${await res.text()}`);
  return res.json();
}

async function createClickUpTask(name, description, priority = 3, listId) {
  return clickupFetch(`/list/${listId}/task`, {
    method: 'POST',
    body: JSON.stringify({ name, description, status: 'to do', priority }),
  });
}

// ─── Estado de conversaciones ──────────────────────────────────────────────
const conversations = new Map();

function saveState() {
  try {
    const obj = {};
    for (const [k, v] of conversations) obj[k] = v;
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2));
  } catch { /* ignorar */ }
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    let restored = 0;
    for (const [k, v] of Object.entries(data)) {
      if (new Date(v.lastActivity).getTime() > cutoff) {
        conversations.set(k, v);
        restored++;
      }
    }
    if (restored) log(`📋 Restauradas ${restored} conversación(es) activas`);
  } catch { /* sin state file */ }
}

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [threadId, conv] of conversations) {
    if (now - new Date(conv.lastActivity).getTime() > INACTIVITY_TIMEOUT) {
      conversations.delete(threadId);
      cleaned++;
    }
  }
  if (cleaned) log(`🧹 ${cleaned} conversación(es) inactivas limpiadas`);
  saveState();
}, 5 * 60 * 1000);

// ─── Prioridades ClickUp ───────────────────────────────────────────────────
const PRIORITY_MAP = { urgente: 1, alta: 2, normal: 3, baja: 4 };

// ─── Contexto por proyecto ─────────────────────────────────────────────────
const PROJECT_CONTEXT = {
  lista: `
PROYECTO: Lista de Espera (Backoffice ATC)
Sistema que permite al admin del club registrar jugadores que quieren un turno fijo de pádel u otro deporte. Cuando se libera un turno, el admin filtra por día y contacta al jugador por WhatsApp.

STACK: Next.js + TypeScript + React 18 + MUI 5 + React Query + Prisma + Node.js. Monorepo Nx con yarn.

MODELO DE DATOS CENTRAL (ListaEspera):
- nombre, apellido, telefono (obligatorio), email (opcional)
- deporte: "Pádel" | "Fútbol 5" | "Tenis" | "Squash" | "Otro"
- diasDisponibles: string[] → ["lunes","martes","miercoles","jueves","viernes","sabado","domingo"]
- horariosDisponibles: string[] → slots de 90min: "09:00","10:30","12:00","13:30","15:00","16:30","18:00","19:30","21:00","22:30","00:00"
- canchaPreferida: string (opcional)
- estado: "pendiente" | "notificado" | "confirmado" | "cancelado"
- notas: texto libre

USUARIOS:
- Admin del club: gestiona la lista, filtra, cambia estados, abre WhatsApp
- No hay login de jugadores — el sistema es 100% para el admin

FLUJO:
1. Jugador llama/escribe → admin lo agrega con días y horarios disponibles → estado: pendiente
2. Se libera un turno → admin filtra por día → ve quién está disponible
3. Admin clickea WhatsApp → se abre WhatsApp Web con mensaje pre-completado
4. Si acepta → admin cambia estado a "confirmado"

COMPONENTE PRINCIPAL: ListaEsperaPanel (tabla + modal de agregar)
UBICACIÓN: libs/backoffice-integration/src/lib/features/lista-de-espera/

LO QUE NO EXISTE (no pedir ni sugerir):
- No hay TurnoFijo como entidad
- No hay PlantillaWhatsApp configurable
- No hay formulario público para jugadores
- No hay integración WAHA
- No hay endpoint /notificar (WhatsApp es 100% frontend)
`,
  torneos: `
PROYECTO: Torneos ATC
App full-stack para gestión de torneos de pádel. Permite a clubes crear torneos, gestionar inscripciones y fixtures, y a jugadores inscribirse y seguir resultados en tiempo real.

STACK: Next.js 16 App Router + JavaScript (NO TypeScript) + React 19 + Tailwind CSS v4 + shadcn/ui + PostgreSQL + Prisma ORM + NextAuth v4 + Socket.io + SWR + Zod.

MODELOS DE DATOS:
- User: jugador o club_admin (role, clubId, birthDate)
- Club: club de pádel con canchas y torneos
- Court: cancha del club, se asigna a partidos
- Tournament: estados draft → open → closed → in_progress → finished
- TournamentCategory: categoría dentro del torneo (formato, tipo inscripción, cupo)
- TournamentRegistration: inscripción de pareja (player1Id, player2Id, status: pending/confirmed/rejected)
- TournamentMatch: partido con score JSON y nextMatchId para bracket
- TournamentStanding: posiciones calculadas por categoría

USUARIOS:
- club_admin: crea y gestiona torneos, genera fixtures, carga resultados
- player: se inscribe (con pareja), ve fixture, sigue resultados en real-time

LO QUE YA ESTÁ CONSTRUIDO:
- CRUD completo de torneos y categorías
- Generación y publicación de fixture (eliminación directa)
- Inscripciones y sistema de invitaciones de pareja
- Dashboard del jugador (mis torneos, invitaciones)
- Algoritmo de fixture con BYEs

LO QUE FALTA (prioridad de construcción):
1. Página pública de listado de torneos
2. Página pública de detalle del torneo
3. Página pública del fixture (Socket.io real-time)
4. Flujo de inscripción (modal/stepper)
5. Panel admin de torneos (crear, editar, gestionar)
6. Panel admin del fixture (generar, publicar, cargar resultados)
7. Standings/Ranking (API + página pública)
8. Notificaciones por email (Nodemailer)
`,
};

// ─── Prompt: Agente Requerimientos ─────────────────────────────────────────
function buildRequirementsSystemPrompt(projectKey) {
  const projectName = PROJECTS[projectKey]?.name || projectKey;
  const context = PROJECT_CONTEXT[projectKey] || `PROYECTO: ${projectName}`;

  return `Sos el Agente de Requerimientos de ATC (AlquilaTuCancha), plataforma de sports tech para alquiler de canchas deportivas.

${context}

TU MISIÓN:
Conversar con un empleado para entender completamente un requerimiento y crear un ticket técnico preciso y accionable para el equipo de desarrollo.

COMPORTAMIENTO:
- Hacé UNA sola pregunta a la vez. Nunca dos seguidas.
- Sé directo y conciso. Sin vueltas.
- Usá el contexto del proyecto para hacer preguntas específicas y relevantes — no genéricas.
- Si algo no queda claro, pedí un ejemplo concreto con datos reales del sistema.
- Cuando tenés suficiente info para armar un ticket completo, terminá.

INFO QUE NECESITÁS:
1. Título corto y descriptivo
2. Problema o necesidad específica (qué pasa ahora vs. qué debería pasar, con ejemplos concretos)
3. Tipo: feature / bug / mejora / diseño
4. Prioridad: urgente / alta / normal / baja
5. Criterios de aceptación concretos y verificables (2-4 puntos)
6. Contexto: qué usuarios se ven afectados, con qué frecuencia, ejemplos específicos

REGLAS:
- Entre 4 y 7 intercambios es suficiente.
- Usá tu conocimiento del proyecto para hacer preguntas inteligentes — si mencionan "estado" sabés que puede ser pendiente/notificado/confirmado/cancelado (lista) o draft/open/closed/in_progress/finished (torneos).
- No preguntes sobre implementación técnica — eso es del Arquitecto.
- No preguntes cosas que ya sabés por el contexto anterior.
- Si el requerimiento es vago, pedí primero un ejemplo concreto con datos reales.

CUÁNDO TERMINAR:
Cuando tengas título, descripción clara con ejemplos específicos, tipo, prioridad y al menos 2 criterios de aceptación verificables por QA.

SEÑAL DE CIERRE — terminá con EXACTAMENTE este bloque y nada más después:

REQUIREMENTS_COMPLETE
{
  "title": "Título conciso del requerimiento",
  "type": "feature|bug|mejora|diseño",
  "priority": "urgente|alta|normal|baja",
  "description": "Descripción clara: qué pasa ahora, qué debería pasar, por qué importa. Con ejemplos específicos del sistema.",
  "acceptance_criteria": [
    "Criterio verificable 1",
    "Criterio verificable 2",
    "Criterio verificable 3"
  ],
  "context": "Usuarios afectados, frecuencia, ejemplos concretos, notas."
}
REQUIREMENTS_END`;
}

// ─── Prompt: Agente Documentador ───────────────────────────────────────────
function buildDocumentadorPrompt(structuredData, transcript, projectKey) {
  const projectName = PROJECTS[projectKey]?.name || projectKey;
  const context = PROJECT_CONTEXT[projectKey] || '';

  return `Sos el Agente Documentador de ATC. Proyecto: ${projectName}.
Tomá los datos estructurados y el transcript y escribí la descripción de un ticket ClickUp clara, precisa y útil para el equipo técnico.

CONTEXTO DEL PROYECTO:
${context}

DATOS ESTRUCTURADOS:
${JSON.stringify(structuredData, null, 2)}

TRANSCRIPT DE LA CONVERSACIÓN:
${transcript}

ESTRUCTURA DEL TICKET (Markdown):

## Contexto y problema
Qué está pasando exactamente, qué usuarios se ven afectados, por qué importa. Mencioná entidades concretas del sistema (estados, modelos, pantallas) cuando sea relevante.

## Solución esperada
Qué debe hacer el sistema cuando esté implementado. Específico pero sin diseñar la solución técnica.

## Criterios de aceptación
Lista numerada. Cada criterio debe ser verificable por QA con datos concretos.

## Notas técnicas
Componentes, endpoints, modelos o flujos del sistema que el desarrollador debe tener en cuenta. Extraé del transcript cualquier detalle técnico relevante. Omitir si no hay nada.

REGLAS:
- Español, específico, sin paja
- Usá el contexto del proyecto para ser preciso con nombres reales (ej: "estado notificado", "TournamentCategory", "ListaEsperaPanel")
- No diseñés la solución técnica — eso es del Arquitecto
- Capturá detalles del transcript que no estén en los datos estructurados

Respondé SOLO con el Markdown del cuerpo del ticket.`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function extractRequirementsData(text) {
  // Intentar con REQUIREMENTS_END (formato completo)
  let match = text.match(/REQUIREMENTS_COMPLETE\s*(\{[\s\S]*?\})\s*REQUIREMENTS_END/);
  // Fallback: sin REQUIREMENTS_END (el AI a veces lo omite)
  if (!match) match = text.match(/REQUIREMENTS_COMPLETE\s*(\{[\s\S]*?\})\s*$/);
  if (!match) match = text.match(/REQUIREMENTS_COMPLETE\s*(\{[\s\S]*\})/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    logError('❌ Error parseando JSON:', e.message);
    return null;
  }
}

async function safeThreadSend(thread, text) {
  const MAX = 1900;
  if (text.length <= MAX) return thread.send(text);
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));
  for (const chunk of chunks) await thread.send(chunk);
}

// Extrae el proyecto del inicio del comando: "torneos algo" → { project: 'torneos', text: 'algo' }
function parseProjectFromText(text) {
  const words = text.trim().split(/\s+/);
  const first = words[0]?.toLowerCase();
  if (PROJECT_KEYS.includes(first)) {
    return { project: first, text: words.slice(1).join(' ').trim() };
  }
  return { project: null, text: text.trim() };
}

// ─── Turno del Agente Requerimientos ──────────────────────────────────────
async function runRequirementsAgentTurn(conv, userMessage) {
  conv.messages.push({ role: 'user', content: userMessage });
  conv.turns++;
  conv.lastActivity = new Date().toISOString();

  const response = await anthropic.messages.create({
    model: MODEL_REQUIREMENTS,
    max_tokens: 600,
    system: buildRequirementsSystemPrompt(conv.project),
    messages: conv.messages,
  });

  const text = response.content[0].text;
  conv.messages.push({ role: 'assistant', content: text });
  saveState();
  return text;
}

// ─── Documentador → ClickUp → Notificar ───────────────────────────────────
async function handleRequirementsComplete(thread, conv, structuredData) {
  conv.status = 'documenting';
  saveState();

  const project    = PROJECTS[conv.project];
  const projectName = project.name;

  await safeThreadSend(thread, '📝 Perfecto, tengo todo. Generando el ticket...');

  const transcript = conv.messages
    .map(m => `${m.role === 'user' ? conv.username : 'Agente'}: ${m.content}`)
    .join('\n\n');

  log(`  📄 Documentador procesando: "${structuredData.title}" [${projectName}]`);

  let description;
  try {
    const response = await anthropic.messages.create({
      model: MODEL_DOCUMENTADOR,
      max_tokens: 1500,
      messages: [{ role: 'user', content: buildDocumentadorPrompt(structuredData, transcript, conv.project) }],
    });
    description = response.content[0].text.trim();
  } catch (e) {
    logError('  ⚠️ Documentador falló, usando descripción básica:', e.message);
    description = `## Descripción\n${structuredData.description}\n\n## Criterios de aceptación\n${structuredData.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n## Contexto\n${structuredData.context}`;
  }

  const priority = PRIORITY_MAP[structuredData.priority] || 3;
  let task;
  try {
    task = await createClickUpTask(structuredData.title, description, priority, project.listId);
  } catch (e) {
    logError('  ❌ Error creando tarea ClickUp:', e.message);
    await safeThreadSend(thread,
      `❌ Error creando el ticket en ClickUp: ${e.message}\n\n` +
      `**Título:** ${structuredData.title}\n**Proyecto:** ${projectName}`
    );
    conversations.delete(thread.id);
    saveState();
    return;
  }

  const taskUrl = task.url || `https://app.clickup.com/t/${task.id}`;
  log(`  ✅ Tarea creada: ${task.id} — "${structuredData.title}" [${projectName}]`);

  await safeThreadSend(thread,
    `${project.emoji} **Ticket creado en ${projectName}**\n\n` +
    `**${structuredData.title}**\n` +
    `Tipo: \`${structuredData.type}\` · Prioridad: \`${structuredData.priority}\`\n\n` +
    `🔗 ${taskUrl}\n\n` +
    `El ticket está en **to do**. El Arquitecto lo toma desde ahí.`
  );

  if (DISCORD_NOTIFY_CHANNEL_ID) {
    try {
      const notifyChannel = await client.channels.fetch(DISCORD_NOTIFY_CHANNEL_ID);
      if (notifyChannel?.isTextBased()) {
        await notifyChannel.send(
          `${project.emoji} **Nuevo requerimiento** — <@${conv.userId}> · ${projectName}\n` +
          `**${structuredData.title}** · \`${structuredData.type}\` · \`${structuredData.priority}\`\n` +
          `🔗 ${taskUrl}`
        );
      }
    } catch (e) {
      logError('⚠️ No se pudo notificar en canal general:', e.message);
    }
  }

  conversations.delete(thread.id);
  saveState();
}

// ─── Iniciar conversación (después de saber el proyecto) ───────────────────
async function startGathering(thread, conv, initialText) {
  try {
    await thread.sendTyping();
    const agentResponse = await runRequirementsAgentTurn(conv, initialText);
    const structuredData = extractRequirementsData(agentResponse);
    if (structuredData) {
      await handleRequirementsComplete(thread, conv, structuredData);
      return;
    }
    await safeThreadSend(thread, agentResponse);
  } catch (e) {
    logError('Error en primer turno:', e.message);
    conversations.delete(thread.id);
    await safeThreadSend(thread, `❌ Error iniciando el agente: ${e.message}`);
  }
}

// ─── Discord Client ────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, (c) => {
  log(`✅ Bot conectado como ${c.user.tag}`);
  log(`   Proyectos: ${PROJECT_KEYS.map(k => `${PROJECTS[k].emoji} ${k} (${PROJECTS[k].listId})`).join(' · ')}`);
  log(`   Trigger channel: ${DISCORD_TRIGGER_CHANNEL_ID || 'cualquier canal'}`);
  log(`   Notify channel:  ${DISCORD_NOTIFY_CHANNEL_ID  || 'desactivado'}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const isThread = message.channel.isThread?.() ?? false;

  // ── CASO 1: Respuesta en hilo activo ──────────────────────────────────────
  if (isThread && conversations.has(message.channelId)) {
    const conv = conversations.get(message.channelId);
    if (conv.userId !== message.author.id) return;

    const content = message.content.trim();

    // Cancelar
    if (/^!req\s+cancelar$/i.test(content)) {
      conversations.delete(message.channelId);
      saveState();
      await message.reply('❌ Requerimiento cancelado.');
      return;
    }

    // Forzar cierre
    if (/^!req\s+forzar$/i.test(content)) {
      try {
        await message.channel.sendTyping();
        conv.messages.push({ role: 'user', content: 'Terminá ahora con el bloque REQUIREMENTS_COMPLETE.' });
        const response = await anthropic.messages.create({
          model: MODEL_REQUIREMENTS,
          max_tokens: 800,
          system: buildRequirementsSystemPrompt(conv.project),
          messages: conv.messages,
        });
        const data = extractRequirementsData(response.content[0].text);
        if (data) {
          await handleRequirementsComplete(message.channel, conv, data);
        } else {
          await message.reply('⚠️ No pude generar el ticket. Respondé una pregunta más.');
        }
      } catch (e) {
        await message.reply('❌ Error: ' + e.message);
      }
      return;
    }

    // ── Esperando que elija el proyecto ──────────────────────────────────────
    if (conv.waitingForProject) {
      const choice = content.toLowerCase().trim();
      if (!PROJECT_KEYS.includes(choice)) {
        await message.reply(
          `❌ Proyecto no reconocido. Hablá con un administrador para agregar nuevos proyectos.\n\n` +
          `Proyectos disponibles: ${PROJECT_CHOICES}`
        );
        conversations.delete(message.channelId);
        saveState();
        return;
      }
      conv.project = choice;
      conv.waitingForProject = false;
      saveState();
      const project = PROJECTS[choice];
      await message.channel.send(`${project.emoji} Proyecto: **${project.name}**. Arrancamos.`);
      await startGathering(message.channel, conv, conv.pendingInitialText);
      return;
    }

    // ── Respuesta normal al agente ────────────────────────────────────────────
    try {
      await message.channel.sendTyping();
      let userContent = content;
      if (conv.turns >= MAX_TURNS) {
        userContent += '\n\n[Sistema: terminá ahora con REQUIREMENTS_COMPLETE.]';
      }
      const agentResponse = await runRequirementsAgentTurn(conv, userContent);
      const structuredData = extractRequirementsData(agentResponse);
      if (structuredData) {
        await handleRequirementsComplete(message.channel, conv, structuredData);
        return;
      }
      await safeThreadSend(message.channel, agentResponse);
    } catch (e) {
      logError('Error en turno:', e.message);
      await message.reply(`❌ Error: ${e.message}`);
    }
    return;
  }

  // ── CASO 2: Comando !req en canal ─────────────────────────────────────────
  if (!message.content.startsWith('!req')) return;
  if (DISCORD_TRIGGER_CHANNEL_ID && message.channelId !== DISCORD_TRIGGER_CHANNEL_ID) return;

  const rawText = message.content.replace(/^!req\s*/i, '').trim();

  if (!rawText) {
    await message.reply(
      `**Uso:** \`!req [proyecto] <descripción>\`\n\n` +
      `Proyectos: ${PROJECT_CHOICES}\n\n` +
      `Ejemplos:\n` +
      `\`!req torneos Los clubes no pueden ver el historial de cancelaciones\`\n` +
      `\`!req lista Los jugadores no reciben confirmación por email\``
    );
    return;
  }

  const { project, text: initialText } = parseProjectFromText(rawText);

  if (!initialText) {
    await message.reply(`Falta la descripción. Ejemplo: \`!req ${project} <descripción del problema>\``);
    return;
  }

  // Crear hilo
  let thread;
  try {
    thread = await message.startThread({
      name: `${project ? PROJECTS[project].emoji : '📋'} ${initialText.slice(0, 55)}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      reason: `Requerimiento de ${message.author.displayName}`,
    });
  } catch (e) {
    logError('Error creando hilo:', e.message);
    await message.reply('❌ No pude crear el hilo. Verificá que el bot tenga permisos de **Manage Threads**.');
    return;
  }

  // Inicializar conversación
  const conv = {
    messages: [],
    userId: message.author.id,
    username: message.author.displayName || message.author.username,
    project: project,
    waitingForProject: !project,
    pendingInitialText: initialText,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    turns: 0,
    status: 'gathering',
  };
  conversations.set(thread.id, conv);
  saveState();

  log(`📋 Nueva conversación — ${conv.username} — proyecto: ${project || '(por definir)'} — "${initialText}"`);

  // Si no se especificó proyecto, preguntar
  if (!project) {
    await thread.send(
      `¿Para qué proyecto es este requerimiento?\n\n` +
      PROJECT_KEYS.map(k => `${PROJECTS[k].emoji} \`${k}\` — ${PROJECTS[k].name}`).join('\n')
    );
    return;
  }

  // Proyecto definido → arrancar directamente
  await startGathering(thread, conv, initialText);
});

// ─── Arranque ──────────────────────────────────────────────────────────────
loadState();
log('🚀 ATC Requirements Bot iniciando...');
client.login(DISCORD_TOKEN).catch(e => {
  logError('❌ Error conectando a Discord:', e.message);
  process.exit(1);
});
