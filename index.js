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

async function syncFuelPrices() {
  console.log('Syncing NSW fuel prices...');
  try {
    const response = await fetch(
      'https://api.fuelcheck.nsw.gov.au/ajax/fuel/GetCountryPrices/CTY1',
      {
        method: 'GET',
        headers: {
          'apikey': FUEL_API_KEY,
          'requesttimestamp': new Date().toUTCString(),
          'transactionid': '1'
        }
      }
    );

    console.log('API response status:', response.status);
    const text = await response.text();
    console.log('Raw response:', text.substring(0, 200));

    const data = JSON.parse(text);
    const stations = data.stations || [];
    const prices = data.prices || [];

    console.log(`Found ${stations.length} stations, ${prices.length} prices`);

    const priceMap = {};
    prices.forEach(p => {
      if (!priceMap[p.stationcode]) priceMap[p.stationcode] = {};
      priceMap[p.stationcode][p.fueltype] = p.price / 10;
    });

    const rows = stations.map(s => ({
      name: s.name,
      brand: s.brand,
      address: s.address,
      suburb: s.suburb,
      state: 'NSW',
      lat: parseFloat(s.location?.latitude || 0),
      lng: parseFloat(s.location?.longitude || 0),
      unleaded: priceMap[s.stationcode]?.['U91'] || null,
      e10: priceMap[s.stationcode]?.['E10'] || null,
      diesel: priceMap[s.stationcode]?.['DL'] || null,
      premium: priceMap[s.stationcode]?.['U95'] || null,
      lpg: priceMap[s.stationcode]?.['LPG'] || null,
      updated_at: new Date().toISOString()
    }));

    if (rows.length > 0) {
      const { error } = await supabase
        .from('fuel_stations')
        .upsert(rows, { onConflict: 'name,address' });
      if (error) throw error;
      console.log(`Synced ${rows.length} fuel stations`);
    } else {
      console.log('No stations to sync');
    }

  } catch (err) {
    console.error('Fuel sync error:', err.message);
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
