'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  OVERPASS_QUERIES,
  fetchOverpassElements,
  normalizeOverpassCatalog,
} = require('../src/main/supercharger-catalog.cjs');

async function main() {
  const queries = process.argv.includes('--wikidata-only')
    ? [OVERPASS_QUERIES[1]]
    : OVERPASS_QUERIES;
  const elements = [];
  for (let index = 0; index < queries.length; index++) {
    console.log(`Fetching indexed OSM selector ${index + 1}/${queries.length}…`);
    elements.push(...await fetchOverpassElements(queries[index], {
      userAgent: 'Sentry Drive Supercharger Catalog Maintainer/1.0',
      onRetry: ({ attempt, delayMs, status }) => {
        console.log(
          `  Overpass returned ${status ?? 'no response'} — retry ${attempt} in ${Math.round(delayMs / 1000)}s…`,
        );
      },
    }));
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
