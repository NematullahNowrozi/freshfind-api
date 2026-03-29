import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const FUEL_API_KEY = process.env.FUEL_API_KEY;
const FUEL_AUTH_HEADER = process.env.FUEL_AUTH_HEADER;

let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }
  console.log('Fetching new OAuth token...');
  const response = await fetch(
    'https://api.onegov.nsw.gov.au/oauth/client_credential/accesstoken?grant_type=client_credentials',
    {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${FUEL_AUTH_HEADER}`,
        'Content-Type': 'application/json'
      }
    }
  );
  const text = await response.text();
  console.log('Token status:', response.status);
  const data = JSON.parse(text);
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (11 * 60 * 60 * 1000);
  console.log('✅ Got access token');
  return accessToken;
}

async function syncFuelPrices() {
  console.log('Syncing NSW fuel prices...');
  try {
    const token = await getAccessToken();

    const response = await fetch(
      'https://api.onegov.nsw.gov.au/FuelPriceCheck/v2/fuel/prices',
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'apikey': FUEL_API_KEY,
          'Content-Type': 'application/json',
          'requesttimestamp': new Date().toISOString(),
          'transactionid': `freshfind-${Date.now()}`
        }
      }
    );

    console.log('Prices response status:', response.status);
    const text = await response.text();
    const data = JSON.parse(text);
    const stations = data.stations || [];
    const prices = data.prices || [];

    console.log(`Found ${stations.length} stations, ${prices.length} prices`);

    const priceMap = {};
   prices.forEach(p => {
  const code = p.stationcode || p.stationCode || p.station_code || p.code;
  if (!code) return;
  if (!priceMap[code]) priceMap[code] = {};
  priceMap[code][p.fueltype] = p.price / 10;
});

    const seen = new Set();
    const rows = [];
    for (const s of stations) {
      const key = `${s.name}||${s.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
    const code = s.stationcode || s.stationCode || s.station_code || s.code;
const sp = priceMap[code] || {};
console.log(`Station ${code} prices:`, JSON.stringify(sp));
      rows.push({
        name: s.name,
        brand: s.brand,
        address: s.address,
        suburb: s.suburb,
        state: 'NSW',
        lat: parseFloat(s.location?.latitude || 0),
        lng: parseFloat(s.location?.longitude || 0),
        unleaded: sp['U91'] || sp['ULP'] || sp['PULP'] || null,
        e10: sp['E10'] || null,
        diesel: sp['DL'] || sp['DSL'] || sp['DIESEL'] || null,
        premium: sp['U95'] || sp['P95'] || sp['U98'] || sp['P98'] || null,
        lpg: sp['LPG'] || null,
        updated_at: new Date().toISOString()
      });
    }

    console.log(`Inserting ${rows.length} deduplicated stations...`);

    const batchSize = 100;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { error } = await supabase
        .from('fuel_stations')
        .upsert(batch, { onConflict: 'name,address' });
      if (error) {
        console.error(`Batch ${i / batchSize + 1} error:`, error.message);
      } else {
        console.log(`✅ Batch ${i / batchSize + 1} inserted`);
      }
    }

    console.log(`✅ Sync complete — ${rows.length} stations`);

  } catch (err) {
    console.error('Fuel sync error:', err.message);
    accessToken = null;
  }
}

app.get('/', (req, res) => {
  res.json({
    status: '✅ FreshFind API running',
    time: new Date(),
    endpoints: [
      'GET /api/fuel',
      'GET /api/fuel/cheapest?type=unleaded',
      'GET /api/fuel/nearby?lat=X&lng=Y&radius=5',
      'POST /api/sync/fuel'
    ]
  });
});

app.get('/api/fuel', async (req, res) => {
  const { suburb, brand } = req.query;
  let query = supabase
    .from('fuel_stations')
    .select('*')
    .order('unleaded', { ascending: true });
  if (suburb) query = query.ilike('suburb', `%${suburb}%`);
  if (brand) query = query.ilike('brand', `%${brand}%`);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: data.length, stations: data });
});

app.get('/api/fuel/cheapest', async (req, res) => {
  const type = req.query.type || 'unleaded';
  const limit = parseInt(req.query.limit) || 10;
  const validTypes = ['unleaded', 'e10', 'diesel', 'premium', 'lpg'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid fuel type' });
  }
  const { data, error } = await supabase
    .from('fuel_stations')
    .select('*')
    .not(type, 'is', null)
    .order(type, { ascending: true })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ type, count: data.length, stations: data });
});

app.get('/api/fuel/nearby', async (req, res) => {
  const { lat, lng, radius = 5 } = req.query;
  if (!lat || !lng) {
    return res.status(400).json({ error: 'lat and lng required' });
  }
  const latRange = parseFloat(radius) / 111;
  const lngRange = parseFloat(radius) / 85;
  const { data, error } = await supabase
    .from('fuel_stations')
    .select('*')
    .gte('lat', parseFloat(lat) - latRange)
    .lte('lat', parseFloat(lat) + latRange)
    .gte('lng', parseFloat(lng) - lngRange)
    .lte('lng', parseFloat(lng) + lngRange)
    .order('unleaded', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: data.length, stations: data });
});

app.post('/api/sync/fuel', async (req, res) => {
  await syncFuelPrices();
  res.json({ message: 'Fuel sync complete' });
});

cron.schedule('*/30 * * * *', () => {
  syncFuelPrices();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FreshFind API running on port ${PORT}`);
  syncFuelPrices();
});
