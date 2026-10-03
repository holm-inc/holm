fn main() -> Result<(), Box<dyn std::error::Error>> {
    let spec = holm_server::routes::openapi().to_pretty_json()?;
    let out = concat!(env!("CARGO_MANIFEST_DIR"), "/../../clients/openapi.json");
    std::fs::write(out, spec + "\n")?;
    Ok(())
}
