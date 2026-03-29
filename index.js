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
const FUEL_API_BASE = 'https://api.fuelcheck.nsw.gov.au/ajax/fuel';

// ── FETCH & STORE FUEL PRICES ────────────────────────────────
async function syncFuelPrices() {
  console.log('Syncing NSW fuel prices...');
  try {
    // Step 1 — get all station details
    const stationsRes = await fetch(`${FUEL_API_BASE}/stations`, {
      headers: {
        'apikey': FUEL_API_KEY,
        'Content-Type': 'application/json',
        'requesttimestamp': new Date().toISOString(),
        'transactionid': `freshfind-${Date.now()}`
      }
    });
    const stationsData = await stationsRes.json();
    const stations = stationsData.stations || [];

    // Step 2 — get all current prices
    const pricesRes = await fetch(`${FUEL_API_BASE}/prices`, {
      headers: {
        'apikey': FUEL_API_KEY,
        'Content-Type': 'application/json',
        'requesttimestamp': new Date().toISOString(),
        'transactionid': `freshfind-prices-${Date.now()}`
      }
    });
    const pricesData = await pricesRes.json();
    const prices = pricesData.prices || [];

    // Step 3 — merge stations + prices into rows
    const priceMap = {};
    prices.forEach(p => {
      if (!priceMap[p.stationcode]) priceMap[p.stationcode] = {};
      priceMap[p.stationcode][p.fueltype] = p.price / 10; // convert to cents
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

    // Step 4 — upsert into Supabase
    const { error } = await supabase
      .from('fuel_stations')
      .upsert(rows, { onConflict: 'name,address' });

    if (error) throw error;
    console.log(`Synced ${rows.length} fuel stations`);
  } catch (err) {
    console.error('Fuel sync error:', err.message);
  }
}

// ── API ROUTES ───────────────────────────────────────────────

// Health check
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

// All stations (with optional filters)
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

// Cheapest by fuel type
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

// Nearby stations
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

// Manual sync trigger
app.post('/api/sync/fuel', async (req, res) => {
  await syncFuelPrices();
  res.json({ message: 'Fuel sync complete' });
});

// ── SCHEDULER — runs every 30 mins (matches FuelCheck update frequency)
cron.schedule('*/30 * * * *', () => {
  syncFuelPrices();
});

// ── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FreshFind API running on port ${PORT}`);
  syncFuelPrices(); // sync immediately on startup
});
```

---

## STEP 3 — Deploy & Test

Once you save both files Railway will deploy automatically (about 2 minutes). Then test these URLs in your browser — replace `your-app` with your actual Railway URL:
```
# Is it running?
https://your-app.railway.app/

# All stations
https://your-app.railway.app/api/fuel

# Cheapest unleaded
https://your-app.railway.app/api/fuel/cheapest?type=unleaded

# Cheapest diesel
https://your-app.railway.app/api/fuel/cheapest?type=diesel

# Near Sydney CBD (to test)
https://your-app.railway.app/api/fuel/nearby?lat=-33.8688&lng=151.2093&radius=3
