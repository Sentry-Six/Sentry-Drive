//! Regenerate the bundled Supercharger catalog from OpenStreetMap:
//!   npm run update:superchargers [-- --wikidata-only]
//! (cargo run --manifest-path src-tauri/Cargo.toml --example update_superchargers)
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let wikidata_only = std::env::args().any(|a| a == "--wikidata-only");
    let catalog = sentry_drive_lib::supercharger::fetch_catalog(wikidata_only, &|m| println!("{m}"))?;
    let out = Path::new(env!("CARGO_MANIFEST_DIR")).join("../assets/tesla-superchargers.json");
    std::fs::write(&out, format!("{catalog}\n"))?;
    let n = catalog["stations"].as_array().map_or(0, Vec::len);
    println!("Wrote {n} Supercharger locations to {}", out.display());
    Ok(())
}
