'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  OVERPASS_ENDPOINT,
  OVERPASS_QUERIES,
  normalizeOverpassCatalog,
} = require('../src/main/supercharger-catalog.cjs');

async function main() {
  const queries = process.argv.includes('--wikidata-only')
    ? [OVERPASS_QUERIES[1]]
    : OVERPASS_QUERIES;
  const elements = [];
  for (let index = 0; index < queries.length; index++) {
    console.log(`Fetching indexed OSM selector ${index + 1}/${queries.length}…`);
    const response = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'user-agent': 'Sentry Drive Supercharger Catalog Maintainer/1.0',
      },
      body: `data=${encodeURIComponent(queries[index])}`,
    });
    if (!response.ok) throw new Error(`Overpass returned HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.elements)) {
      throw new Error(`Overpass selector ${index + 1} returned invalid data`);
    }
    elements.push(...payload.elements);
  }
  const catalog = normalizeOverpassCatalog({ elements });
  if (catalog.stations.length === 0) throw new Error('Overpass returned no Superchargers');

  const outputPath = path.resolve(__dirname, '..', 'assets', 'tesla-superchargers.json');
  fs.writeFileSync(outputPath, `${JSON.stringify(catalog)}\n`);
  console.log(`Wrote ${catalog.stations.length} Supercharger locations to ${outputPath}`);
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
