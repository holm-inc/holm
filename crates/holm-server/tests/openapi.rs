#[test]
fn committed_spec_is_what_the_routes_describe() {
    let built = holm_server::routes::openapi().to_pretty_json().unwrap() + "\n";
    let committed = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../clients/openapi.json"
    ))
    .unwrap_or_default();
    assert!(
        built == committed,
        "clients/openapi.json is stale; run `cargo run -p holm-server --example openapi`"
    );
}
