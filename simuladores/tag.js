const path = require('path');
const admin = require('firebase-admin');

const serviceAccount = require(path.join(__dirname, '../bot/firebase-key.json'));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

console.log('🔥 Firebase conectado correctamente (simulador TAG)');
console.log('📡 Escuchando y generando nuevos TAGs...');

async function cargarBusesYPorticos() {
  const busesSnap = await db.collection('buses').get();
  const porticosSnap = await db.collection('porticos').get();

  const buses = {};
  const porticos = {};

  porticosSnap.forEach((doc) => {
    const d = doc.data();
    if (!d.ubicacion) return;
    porticos[doc.id] = {
      id: doc.id,
      nombre: d.nombre || doc.id,
      lat: parseFloat(d.ubicacion.latitud),
      lng: parseFloat(d.ubicacion.longitud),
    };
  });

  busesSnap.forEach((doc) => {
    const d = doc.data();
    buses[doc.id] = {
      id: doc.id,
      bus_id: d.bus_id || doc.id,
      patente: d.patente || '',
      autorizado: d.autorizado === true,
      ruta_asignada: Array.isArray(d.ruta_asignada) ? d.ruta_asignada : [],
    };
  });

  return { buses, porticos };
}

async function simularTags() {
  const { buses, porticos } = await cargarBusesYPorticos();

  const indicesRuta = {};
  Object.keys(buses).forEach((id) => (indicesRuta[id] = 0));

  setInterval(async () => {
    for (const busId of Object.keys(buses)) {
      const bus = buses[busId];

      if (!bus.ruta_asignada.length) continue;

      // Ciclar por la ruta
      const idx = indicesRuta[busId] % bus.ruta_asignada.length;
      indicesRuta[busId] = idx + 1;

      const porticoId = bus.ruta_asignada[idx];
      const portico = porticos[porticoId];
      if (!portico) continue;

      const ahora = new Date().toISOString();

      // 1. Registrar TAG
      const tagDoc = {
        bus_id: bus.bus_id,
        patente: bus.patente,
        portico_id: portico.id,
        portico_nombre: portico.nombre,
        created_at: ahora,
        source: 'tag',
      };

      await db.collection('tags').add(tagDoc);

      // 2. Actualizar último TAG y posición del bus
      await db.collection('buses').doc(busId).update({
        ultimo_tag: {
          portico_id: portico.id,
          portico_nombre: portico.nombre,
          hora: ahora,
          updated_at: ahora,
        },
        ultima_posicion: {
          lat: portico.lat,
          lng: portico.lng,
          hora: ahora,
        },
        updated_at: ahora,
      });

      // 3. Generar alerta si el bus NO está autorizado
      if (!bus.autorizado) {
        const alerta = {
          bus_id: bus.bus_id,
          patente: bus.patente,
          tipo: 'Ruta no autorizada',
          descripcion: `El bus ${bus.bus_id} pasó por el pórtico ${portico.id} que no está en su ruta asignada.`,
          portico_id: portico.id,
          fecha: ahora,
          leido: false,
        };
        await db.collection('alertas').add(alerta);
      }
    }
  }, 8000); // cada 8 segundos
}

simularTags().catch((err) => {
  console.error('Error procesando TAG:', err);
  process.exit(1);
});