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
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY;

let accessToken = null;
let tokenExpiry = null;

// ── SYNC WINDOW CHECK (6am–10pm AEST) ────────────────────────
function isSyncWindow() {
  const aest = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
  const hour = aest.getHours();
  return hour >= 6 && hour < 22;
}

function aestTime() {
  return new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
}

// ── OAUTH TOKEN ───────────────────────────────────────────────
async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) return accessToken;
  console.log(`[${aestTime()}] Fetching new OAuth token...`);
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
  const data = JSON.parse(await response.text());
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (11 * 60 * 60 * 1000);
  console.log(`[${aestTime()}] OAuth token obtained`);
  return accessToken;
}

// ── FUEL SYNC ─────────────────────────────────────────────────
async function syncFuelPrices() {
  if (!isSyncWindow()) {
    console.log(`[${aestTime()}] Outside sync window — skipping`);
    return;
  }
  console.log(`[${aestTime()}] Starting fuel sync...`);
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

    const data = JSON.parse(await response.text());
    const stations = data.stations || [];
    const prices = data.prices || [];
    console.log(`[${aestTime()}] API returned ${stations.length} stations, ${prices.length} prices`);

    const priceMap = {};
    prices.forEach(p => {
      const code = p.stationcode || p.stationCode || p.code;
      if (!code) return;
      if (!priceMap[code]) priceMap[code] = {};
      priceMap[code][p.fueltype] = p.price;
    });

    const seen = new Set();
    const rows = [];
    for (const s of stations) {
      const key = `${s.name}||${s.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const c
