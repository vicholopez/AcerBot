const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// -----------------------------------------------------------------------------
// 1. Cargar firebase-key.json desde ../bot
// -----------------------------------------------------------------------------
const keyPath = path.join(__dirname, '../bot/firebase-key.json');

let serviceAccount;
try {
  const raw = fs.readFileSync(keyPath, 'utf8');
  serviceAccount = JSON.parse(raw);
  console.log('✅ firebase-key.json leído correctamente desde ../bot');
} catch (err) {
  console.error('❌ No se pudo leer firebase-key.json desde ../bot');
  console.error(err);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// 2. Inicializar Firebase
// -----------------------------------------------------------------------------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// -----------------------------------------------------------------------------
// 3. Utilidades de geografía
// -----------------------------------------------------------------------------
const R_EARTH = 6371000; // metros

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function distanceMeters(p1, p2) {
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);
  const lat1 = toRad(p1.lat);
  const lat2 = toRad(p2.lat);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R_EARTH * c;
}

function interpolate(p1, p2, t) {
  return {
    lat: p1.lat + (p2.lat - p1.lat) * t,
    lng: p1.lng + (p2.lng - p1.lng) * t
  };
}

// Convierte cualquier objeto {lat, lng} o {latitud, longitud} a números
function normalizarPunto(raw) {
  if (!raw) return null;
  const lat = parseFloat(raw.lat ?? raw.latitud);
  const lng = parseFloat(raw.lng ?? raw.longitud);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return { lat, lng };
}

// -----------------------------------------------------------------------------
// 4. Cargar rutas desde Firestore
// -----------------------------------------------------------------------------
async function cargarRutas() {
  console.log('📍 Cargando rutas de buses desde Firestore...');

  const snapshot = await db
    .collection('buses')
    .where('origen_simulacion', '==', 'gps.js')
    .get();

  if (snapshot.empty) {
    console.log('⚠️ No hay buses con origen_simulacion = "gps.js"');
    return [];
  }

  const rutas = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const busId = data.bus_id || doc.id;

    const origenPoint = normalizarPunto(data.origen);
    const destinoPoint = normalizarPunto(data.destino);
    const rutaAsignada = data.ruta_asignada || [];

    if (!origenPoint || !destinoPoint) {
      console.log(
        `❌ Bus ${busId} no tiene origen/destino válidos; se omite.`
      );
      continue;
    }

    // 4.1. Intentar usar ruta_geo (rutas que siguen calles)
    let puntosRuta = [];
    if (Array.isArray(data.ruta_geo) && data.ruta_geo.length >= 2) {
      const norm = data.ruta_geo
        .map((p) => normalizarPunto(p))
        .filter(Boolean);

      if (norm.length >= 2) {
        // Asegurar que la ruta_geo empiece muy cerca del ORIGEN
        if (distanceMeters(origenPoint, norm[0]) > 50) {
          norm.unshift(origenPoint);
        } else {
          norm[0] = origenPoint;
        }

        // Asegurar que la ruta_geo termine muy cerca del DESTINO
        const lastIdx = norm.length - 1;
        if (distanceMeters(destinoPoint, norm[lastIdx]) > 50) {
          norm.push(destinoPoint);
        } else {
          norm[lastIdx] = destinoPoint;
        }

        puntosRuta = norm;
        console.log(
          `✅ Bus ${busId} usará ruta_geo (origen → calles → destino) con ${puntosRuta.length} puntos.`
        );
      }
    }

    // 4.2. Si NO hay ruta_geo válida, armar ORIGEN -> PÓRTICOS -> DESTINO
    if (puntosRuta.length < 2) {
      puntosRuta.push(origenPoint);

      for (const porticoId of rutaAsignada) {
        try {
          const portDoc = await db.collection('porticos').doc(porticoId).get();
          if (!portDoc.exists) {
            console.log(
              `❌ Pórtico ${porticoId} no existe (bus ${busId}), se omite.`
            );
            continue;
          }
          const portData = portDoc.data();
          const ubic = portData.ubicacion || {};
          const np = normalizarPunto(ubic);
          if (!np) {
            console.log(
              `❌ Pórtico ${porticoId} no tiene coordenadas válidas (bus ${busId}).`
            );
            continue;
          }
          puntosRuta.push(np);
        } catch (err) {
          console.log(
            `❌ Error obteniendo pórtico ${porticoId} (bus ${busId}):`,
            err.message
          );
        }
      }

      puntosRuta.push(destinoPoint);

      if (puntosRuta.length < 2) {
        console.log(
          `⚠️ Bus ${busId} tiene menos de 2 puntos en la ruta; se omite.`
        );
        continue;
      }

      console.log(
        `✅ Bus ${busId} usará ruta ORIGEN -> PÓRTICOS -> DESTINO con ${puntosRuta.length} puntos.`
      );
    }

    // Log de chequeo para ver que las coordenadas estén en Santiago (lat ~ -33, lng ~ -70)
    const first = puntosRuta[0];
    const last = puntosRuta[puntosRuta.length - 1];
    console.log(
      `   ↳ Bus ${busId} inicio: lat=${first.lat}, lng=${first.lng} / fin: lat=${last.lat}, lng=${last.lng}`
    );

    rutas.push({
      busId,
      docId: doc.id,
      chofer: data.chofer || 'Sin chofer',
      patente: data.patente || '',
      autorizado: !!data.autorizado,
      puntos: puntosRuta
    });
  }

  if (!rutas.length) {
    console.log('❌ No hay rutas cargadas; termina el simulador.');
  }

  return rutas;
}

// -----------------------------------------------------------------------------
// 5. Estado de cada bus en memoria
// -----------------------------------------------------------------------------
const STEP_METERS = 150; // avance por tick
const TICK_MS = 3000; // cada cuánto se actualiza Firestore

function crearEstadoInicial(ruta) {
  return {
    ...ruta,
    // Empieza EXACTO en el origen (primer punto de la ruta)
    posicionActual: { ...ruta.puntos[0] },
    indiceSegmento: 0
  };
}

// Avanza SIEMPRE desde la posición actual hacia el siguiente punto
function avanzarBus(estado) {
  const { puntos } = estado;
  let distanciaRestante = STEP_METERS;

  while (distanciaRestante > 0) {
    const ultimoIndice = puntos.length - 1;

    // Si ya llegamos al último punto, reiniciamos la vuelta
    if (estado.indiceSegmento >= ultimoIndice) {
      estado.indiceSegmento = 0;
      estado.posicionActual = { ...puntos[0] };
      console.log(`🔁 Bus ${estado.busId} vuelve al origen de su ruta.`);
      break;
    }

    const pIni = estado.posicionActual;              // SIEMPRE desde donde está ahora
    const pFin = puntos[estado.indiceSegmento + 1];  // siguiente punto de la ruta

    const distSegmento = distanceMeters(pIni, pFin);

    if (distSegmento === 0) {
      estado.indiceSegmento++;
      continue;
    }

    if (distSegmento > distanciaRestante) {
      // Nos quedamos dentro de este segmento
      const t = distanciaRestante / distSegmento;
      estado.posicionActual = interpolate(pIni, pFin, t);
      distanciaRestante = 0;
    } else {
      // Consumimos todo el segmento y pasamos al siguiente
      estado.posicionActual = { ...pFin };
      distanciaRestante -= distSegmento;
      estado.indiceSegmento++;
    }
  }
}

// -----------------------------------------------------------------------------
// 6. Actualizar Firestore
// -----------------------------------------------------------------------------
async function actualizarBusEnFirestore(estado) {
  const ahora = new Date().toISOString();

  await db
    .collection('buses')
    .doc(estado.docId)
    .update({
      ultima_posicion: {
        hora: ahora,
        lat: estado.posicionActual.lat,
        lng: estado.posicionActual.lng
      }
    });

  console.log(
    `🚌 Bus ${estado.busId} -> lat ${estado.posicionActual.lat.toFixed(
      6
    )}, lng ${estado.posicionActual.lng.toFixed(6)}`
  );
}

// -----------------------------------------------------------------------------
// 7. Main
// -----------------------------------------------------------------------------
(async () => {
  const rutas = await cargarRutas();
  if (!rutas.length) process.exit(0);

  const estados = rutas.map((r) => crearEstadoInicial(r));
  console.log(
    `🚀 Iniciando simulación GPS para ${estados.length} buses (tick: ${
      TICK_MS / 1000
    }s, paso: ${STEP_METERS}m)`
  );

  setInterval(async () => {
    for (const estado of estados) {
      avanzarBus(estado);
      try {
        await actualizarBusEnFirestore(estado);
      } catch (err) {
        console.error(
          `❌ Error actualizando posición del bus ${estado.busId}:`,
          err.message
        );
      }
    }
  }, TICK_MS);
})();