require('dotenv').config();
const path = require('path');
const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');

// 1. Firebase Admin
const serviceAccount = require(path.join(__dirname, 'firebase-key.json'));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// Mapa de choferes por si el campo "chofer" está vacío en Firestore
const MAPA_CHOFERES = {
  '12': 'Carlos Rojas',
  '27': 'María Perez',
  '33': 'Juan Soto',
};

// 2. Bot de Telegram
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ ERROR: Falta BOT_TOKEN en el archivo .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// -------- Helpers --------
async function obtenerEstadoBus(busId) {
  const ref = db.collection('buses').doc(busId);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const data = snap.data();

  // Forzamos nombre de chofer si no viene bien desde Firestore
  const chofer =
    (typeof data.chofer === 'string' && data.chofer.trim() !== ''
      ? data.chofer.trim()
      : MAPA_CHOFERES[busId]) || 'Sin chofer';

  return {
    id: busId,
    chofer,
    autorizado: data.autorizado === true,
    patente: data.patente || '—',
    ultima_posicion: data.ultima_posicion || null,
    ultimo_tag: data.ultimo_tag || null,
  };
}

async function obtenerAlertasRecientes(limit = 5) {
  const snap = await db
    .collection('alertas')
    .orderBy('fecha', 'desc')
    .limit(limit)
    .get();

  const alertas = [];
  snap.forEach((doc) => alertas.push({ id: doc.id, ...doc.data() }));
  return alertas;
}

// Intents muy simples: saludo, estado bus, alertas
function detectarIntent(texto) {
  const t = texto.toLowerCase();

  if (/hola|buenas|wenas|saludo/.test(t)) return { tipo: 'saludo' };

  // "estado del bus 12", "como está el 27", etc.
  const matchBus = t.match(/bus\s*(\d{1,3})/);
  if (matchBus) {
    return { tipo: 'estado_bus', busId: matchBus[1] };
  }

  if (/alertas|alarmas|notificaciones/.test(t)) {
    return { tipo: 'alertas' };
  }

  return { tipo: 'desconocido' };
}

// -------- Handlers --------
bot.start((ctx) => {
  ctx.reply(
    '👋 Hola, soy AcerBot.\n' +
      'Puedes preguntarme cosas como:\n' +
      '• "estado del bus 12"\n' +
      '• "qué alertas hay"\n'
  );
});

bot.on('text', async (ctx) => {
  try {
    const msg = ctx.message.text || '';
    const intent = detectarIntent(msg);

    if (intent.tipo === 'saludo') {
      return ctx.reply('👋 Hola, ¿en qué puedo ayudarte?');
    }

    if (intent.tipo === 'estado_bus' && intent.busId) {
      const info = await obtenerEstadoBus(intent.busId);
      if (!info) {
        return ctx.reply(`No encuentro información del bus ${intent.busId}.`);
      }

      let texto = `🚌 Estado del bus ${info.id}\n`;
      texto += `• Chofer: ${info.chofer}\n`;
      texto += `• Patente: ${info.patente}\n`;
      texto += `• Autorizado: ${info.autorizado ? 'Sí' : 'No'}\n`;

      if (info.ultimo_tag) {
        texto += `• Último TAG: ${info.ultimo_tag.portico_id || '—'} (${
          info.ultimo_tag.portico_nombre || '—'
        })\n`;
        texto += `• Hora TAG: ${
          info.ultimo_tag.hora || info.ultimo_tag.updated_at || '—'
        }\n`;
      }

      if (info.ultima_posicion) {
        const lat = Number(info.ultima_posicion.lat);
        const lng = Number(info.ultima_posicion.lng);
        if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
          texto += `• Última posición: lat ${lat.toFixed(
            5
          )}, lng ${lng.toFixed(5)}\n`;
        }
      }

      return ctx.reply(texto);
    }

    if (intent.tipo === 'alertas') {
      const alertas = await obtenerAlertasRecientes(5);
      if (!alertas.length) {
        return ctx.reply('✅ No hay alertas recientes.');
      }

      let texto = '⚠️ Alertas recientes:\n';
      alertas.forEach((a) => {
        texto += `• Bus ${a.bus_id || a.bus || '—'} – ${
          a.tipo || 'Alerta'
        }\n`;
        texto += `  ${a.descripcion || ''}\n`;
      });
      return ctx.reply(texto);
    }

    // Intent desconocido
    return ctx.reply(
      '🤖 No entendí muy bien.\n' +
        'Prueba con:\n' +
        '• "estado del bus 12"\n' +
        '• "qué alertas hay"\n'
    );
  } catch (err) {
    console.error('Error procesando mensaje:', err);
    return ctx.reply('❌ Ocurrió un error al procesar tu solicitud.');
  }
});

console.log('🤖 AcerBot iniciado correctamente.');
bot.launch();