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
        'Authorization': `Basic ${process.env.FUEL_AUTH_HEADER}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const text = await response.text();
  console.log('Token status:', response.status);
  console.log('Token response:', text.substring(0, 300));

  const data = JSON.parse(text);
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (11 * 60 * 60 * 1000);
  console.log('✅ Got access token');
  return accessToken;
}
