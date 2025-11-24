const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

const serviceAccount = require(path.join(__dirname, '../bot/firebase-key.json'));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.static(__dirname));

// ---------- API BUSES ----------
app.get('/api/buses', async (req, res) => {
  try {
    const snap = await db.collection('buses').get();
    const buses = [];

    snap.forEach((doc) => {
      const data = doc.data();

      let chofer = data.chofer || '';

      // Fallback explícito para el bus 12
      if ((data.bus_id || doc.id) === '12' && !chofer.trim()) {
        chofer = 'Carlos Rojas';
      }

      buses.push({
        id: doc.id,
        bus_id: data.bus_id || doc.id,
        chofer: chofer || '—',
        autorizado: data.autorizado === true,
        patente: data.patente || '—',
        ruta_asignada: data.ruta_asignada || [],
        ultimo_tag: data.ultimo_tag || null,
        ultima_posicion: data.ultima_posicion || null,
      });
    });

    res.json(buses);
  } catch (err) {
    console.error('Error obteniendo buses:', err);
    res.status(500).json({ error: 'Error obteniendo buses' });
  }
});

// ---------- API ALERTAS ----------
app.get('/api/alertas', async (req, res) => {
  try {
    const snap = await db
      .collection('alertas')
      .orderBy('fecha', 'desc')
      .limit(50)
      .get();

    const alertas = [];
    snap.forEach((doc) => alertas.push({ id: doc.id, ...doc.data() }));
    res.json(alertas);
  } catch (err) {
    console.error('Error obteniendo alertas:', err);
    res.status(500).json({ error: 'Error obteniendo alertas' });
  }
});

// ---------- INDEX ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`📊 Panel ejecutándose en http://localhost:${PORT}`);
});