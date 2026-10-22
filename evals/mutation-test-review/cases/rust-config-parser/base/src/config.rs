use std::collections::BTreeMap;

/// Parses `key = value` lines into a map.
pub fn parse(input: &str) -> Option<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for raw in input.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let (k, v) = line.split_once('=')?;
        out.insert(k.trim().to_string(), v.trim().to_string());
    }
    Some(out)
}
