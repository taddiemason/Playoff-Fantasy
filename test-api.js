#!/usr/bin/env node
// Run with: node test-api.js

const SEASON = '20252026';
const HEADERS = { 'User-Agent': 'PlayoffFantasy/1.0' };

async function test(label, url) {
  process.stdout.write(`${label}... `);
  try {
    const res = await fetch(url, { headers: HEADERS });
    const body = await res.json().catch(() => null);
    const count = body?.data?.length ?? body?.length ?? (Array.isArray(body) ? body.length : '?');
    if (res.ok) {
      console.log(`OK (${res.status}) — ${count} records`);
      if (Array.isArray(body?.data) && body.data[0]) {
        const sample = body.data[0];
        console.log(`   Sample: ${sample.skaterFullName || sample.goalieFullName || JSON.stringify(sample).slice(0, 80)}`);
      }
    } else {
      console.log(`FAIL (${res.status}) — ${JSON.stringify(body).slice(0, 100)}`);
    }
  } catch (e) {
    console.log(`ERROR — ${e.message}`);
  }
}

const exp = encodeURIComponent(`gameTypeId=3 and seasonId=${SEASON}`);

(async () => {
  console.log(`\nTesting NHL APIs for season ${SEASON} (2026 playoffs)\n`);

  await test(
    '1. Skater stats (api.nhle.com)',
    `https://api.nhle.com/stats/rest/en/skater/summary?cayenneExp=${exp}&sort=points&start=0&limit=10`
  );

  await test(
    '2. Goalie stats (api.nhle.com)',
    `https://api.nhle.com/stats/rest/en/goalie/summary?cayenneExp=${exp}&sort=wins&start=0&limit=10`
  );

  await test(
    '3. Player search (search.d3.nhle.com)',
    `https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=5&q=McDavid&active=true`
  );

  console.log('\nDone.\n');
})();
