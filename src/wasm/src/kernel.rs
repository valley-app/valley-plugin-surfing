//! The ad-block engines behind `filter.request` and `filter.cosmetics`. The backend numbers its engines (slots); a
//! slot is filled either by parsing lists (`add` per chunk, then `build`) or from a saved engine (`load`), and keeps
//! answering until it is dropped or replaced. Answers are the RPC replies themselves, encoded as JSON here.

use std::collections::HashMap;

use adblock::Engine;
use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::resources::{MimeType, PermissionMask, Resource, ResourceType};
use base64::Engine as _;
use base64::prelude::BASE64_STANDARD;
use serde::Deserialize;
use serde_json::{Value, json};

/// Saved-engine bytes behind one `save` piece: a multiple of 3, so every piece is complete base64 of its own, and its
/// 3 MiB of base64 fit one plugin data file (at most 4 MiB of text) with the backend's generation line.
pub const SAVE_CHUNK: usize = 3 * 768 * 1024;
/// Scriptlets that need a trusted list; the backend's lists never carry that permission.
const TRUSTED: PermissionMask = PermissionMask::from_bits(1);
const HIDE: &str = " { display: none !important; }";

#[derive(Default)]
pub struct Kernel {
    engines: HashMap<u32, Engine>,
    pending: HashMap<u32, FilterSet>,
    loading: HashMap<u32, Vec<u8>>,
    saving: HashMap<u32, Vec<u8>>,
}

#[derive(Deserialize)]
struct Script {
    name: String,
    #[serde(default)]
    aliases: Vec<String>,
    body: String,
    #[serde(default)]
    dependencies: Vec<String>,
    #[serde(default, rename = "requiresTrust")]
    requires_trust: bool,
}

#[derive(Deserialize)]
struct Redirect {
    name: String,
    #[serde(default)]
    aliases: Vec<String>,
    body: String,
    #[serde(default, rename = "contentType")]
    content_type: String,
}

#[derive(Deserialize)]
struct Resources {
    #[serde(default)]
    scriptlets: Vec<Script>,
    #[serde(default)]
    redirects: Vec<Redirect>,
}

#[derive(Deserialize)]
struct Cosmetics {
    url: String,
    #[serde(default)]
    classes: Vec<String>,
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default = "yes")]
    initial: bool,
}

fn yes() -> bool {
    true
}

/// UTF-8 text from base64 (the network and the list cache hold bodies as base64), without a byte-order mark.
pub fn decode_text(base64: &[u8]) -> Result<String, String> {
    let bytes = BASE64_STANDARD.decode(base64).map_err(|error| format!("base64: {error}"))?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned())
}

/// uBlock Origin's resources.json (scriptlets as named functions, redirects with a content type) as engine resources.
pub fn parse_resources(text: &str) -> Result<Vec<Resource>, String> {
    let input: Resources = serde_json::from_str(text).map_err(|error| format!("resources: {error}"))?;
    let mut resources = Vec::with_capacity(input.scriptlets.len() + input.redirects.len());
    for script in input.scriptlets {
        let kind = if script.name.ends_with(".js") { MimeType::ApplicationJavascript } else { MimeType::FnJavascript };
        resources.push(Resource {
            name: script.name,
            aliases: script.aliases,
            kind: ResourceType::Mime(kind),
            content: BASE64_STANDARD.encode(script.body),
            dependencies: script.dependencies,
            permission: if script.requires_trust { TRUSTED } else { PermissionMask::default() },
        });
    }
    for redirect in input.redirects {
        let mut parts = redirect.content_type.split(';');
        let mime = MimeType::from(parts.next().unwrap_or("").trim());
        let encoded = parts.any(|part| part.trim() == "base64");
        let content = if encoded { redirect.body } else { BASE64_STANDARD.encode(redirect.body) };
        resources.push(Resource { name: redirect.name, aliases: redirect.aliases, kind: ResourceType::Mime(mime), content, dependencies: Vec::new(), permission: PermissionMask::default() });
    }
    Ok(resources)
}

/// Electron's `webRequest` resource types in the engine's names; the rest are already the same words.
fn request_type(kind: &str) -> &str {
    match kind {
        "mainFrame" => "main_frame",
        "subFrame" => "sub_frame",
        "cspReport" => "csp_report",
        "webSocket" => "websocket",
        other => other,
    }
}

fn stylesheet(selectors: impl IntoIterator<Item = String>) -> String {
    // One rule per selector: a selector the page's CSS engine rejects then drops only its own rule.
    let mut css = String::new();
    for selector in selectors {
        if !css.is_empty() {
            css.push('\n');
        }
        css.push_str(&selector);
        css.push_str(HIDE);
    }
    css
}

impl Kernel {
    fn engine(&self, slot: u32) -> Result<&Engine, String> {
        self.engines.get(&slot).ok_or_else(|| format!("no engine in slot {slot}"))
    }

    /// Parses one whole filter list (so `!#if` blocks stay complete) into the slot's pending set.
    pub fn add(&mut self, slot: u32, text: String) {
        self.pending.entry(slot).or_insert_with(|| FilterSet::new(false)).add_filter_list(text, ParseOptions::default());
    }

    /// Indexes the slot's pending set; the new engine replaces the slot's previous one.
    pub fn build(&mut self, slot: u32) {
        let set = self.pending.remove(&slot).unwrap_or_else(|| FilterSet::new(false));
        self.engines.insert(slot, Engine::new_with_filter_set(set));
    }

    /// Resources are not part of a saved engine, so they are applied after every build and load.
    pub fn resources(&mut self, slot: u32, text: &str) -> Result<usize, String> {
        let resources = parse_resources(text)?;
        let count = resources.len();
        self.engines.get_mut(&slot).ok_or_else(|| format!("no engine in slot {slot}"))?.use_resources(resources);
        Ok(count)
    }

    /// Base64 of the saved engine's bytes from `offset` on, at most `SAVE_CHUNK` of them; a shorter piece is the last.
    pub fn save(&mut self, slot: u32, offset: usize) -> Result<String, String> {
        if offset == 0 {
            let bytes = self.engine(slot)?.serialize();
            self.saving.insert(slot, bytes);
        }
        let bytes = self.saving.get(&slot).ok_or_else(|| format!("no save in progress for slot {slot}"))?;
        let start = offset.min(bytes.len());
        let end = (start + SAVE_CHUNK).min(bytes.len());
        let piece = BASE64_STANDARD.encode(&bytes[start..end]);
        if end - start < SAVE_CHUNK {
            self.saving.remove(&slot);
        }
        Ok(piece)
    }

    /// Appends a base64 piece of a saved engine; the last piece loads it into the slot.
    pub fn load(&mut self, slot: u32, last: bool, piece: &[u8]) -> Result<(), String> {
        let bytes = BASE64_STANDARD.decode(piece).map_err(|error| { self.loading.remove(&slot); format!("saved engine: {error}") })?;
        self.loading.entry(slot).or_default().extend_from_slice(&bytes);
        if !last {
            return Ok(());
        }
        let bytes = self.loading.remove(&slot).unwrap_or_default();
        let mut engine = Engine::default();
        engine.deserialize(&bytes).map_err(|error| format!("saved engine: {error:?}"))?;
        self.engines.insert(slot, engine);
        Ok(())
    }

    pub fn drop_slot(&mut self, slot: u32) {
        self.engines.remove(&slot);
        self.pending.remove(&slot);
        self.loading.remove(&slot);
        self.saving.remove(&slot);
    }

    /// The `filter.request` reply: redirects and rewrites first, then whether to cancel; `response` adds the CSP of
    /// frame documents. Main-frame requests are answered by the backend without asking.
    pub fn request(&self, slot: u32, response: bool, url: &str, source: &str, kind: &str, method: &str) -> Result<Value, String> {
        let engine = self.engine(slot)?;
        let Ok(request) = Request::new(url, source, request_type(kind), &method.to_ascii_lowercase()) else { return Ok(json!({})) };
        if response {
            let frame = kind == "mainFrame" || kind == "subFrame";
            return Ok(match engine.get_csp_directives(&request).filter(|_| frame) {
                Some(csp) => json!({ "appendResponseHeaders": { "Content-Security-Policy": [csp] } }),
                None => json!({}),
            });
        }
        let result = engine.check_network_request(&request);
        Ok(if let Some(redirect) = result.redirect {
            json!({ "redirectURL": redirect })
        } else if let Some(rewritten) = result.rewritten_url {
            json!({ "redirectURL": rewritten })
        } else {
            json!({ "cancel": result.should_block() })
        })
    }

    /// The `filter.cosmetics` reply. The first call for a page adds the hostname's rules and scriptlets; every call
    /// adds the generic rules for the page's classes and ids unless the page is excepted from them.
    pub fn cosmetics(&self, slot: u32, input: &str) -> Result<Value, String> {
        let input: Cosmetics = serde_json::from_str(input).map_err(|error| format!("cosmetics: {error}"))?;
        let engine = self.engine(slot)?;
        let resources = engine.url_cosmetic_resources(&input.url);
        let mut selectors: Vec<String> = Vec::new();
        let mut scripts: Vec<String> = Vec::new();
        if input.initial {
            selectors.extend(resources.hide_selectors.iter().cloned());
            if !resources.injected_script.is_empty() {
                scripts.push(format!("(function () {{\n{}\n}})();", resources.injected_script));
            }
        }
        if !resources.generichide {
            selectors.extend(engine.hidden_class_id_selectors(&input.classes, &input.ids, &resources.exceptions));
        }
        selectors.sort_unstable();
        selectors.dedup();
        Ok(json!({ "styles": stylesheet(selectors), "scripts": scripts }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RULES: &str = "||ads.example.test^\n@@||ads.example.test/allowed.js\nexample.test##.advert\n##.sponsor-box\n||example.test^$csp=script-src 'none'\n||cdn.example.test/ad.gif$image,redirect=1x1.gif\nexample.test##+js(set-constant, adsEnabled, false)";
    const RESOURCES: &str = r#"{"scriptlets":[{"name":"set-constant.js","aliases":["set.js"],"body":"function setConstant(a,b){window[a]=b}","dependencies":[]},{"name":"trusted-set.js","aliases":[],"body":"function trustedSet(){}","requiresTrust":true}],"redirects":[{"name":"1x1.gif","aliases":[],"body":"R0lGODlhAQABAIAAAP///////yH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==","contentType":"image/gif;base64"},{"name":"noop.txt","aliases":[],"body":"","contentType":"text/plain"}]}"#;

    fn kernel() -> Kernel {
        let mut kernel = Kernel::default();
        kernel.add(1, RULES.to_owned());
        kernel.build(1);
        kernel.resources(1, RESOURCES).unwrap();
        kernel
    }

    #[test]
    fn blocks_honors_exceptions_and_adds_frame_csp() {
        let kernel = kernel();
        let ask = |url: &str, kind: &str, response: bool| kernel.request(1, response, url, "https://example.test/", kind, "GET").unwrap();
        assert_eq!(ask("https://ads.example.test/track.js", "script", false), json!({ "cancel": true }));
        assert_eq!(ask("https://ads.example.test/allowed.js", "script", false), json!({ "cancel": false }));
        assert_eq!(ask("https://example.test/", "mainFrame", true), json!({ "appendResponseHeaders": { "Content-Security-Policy": ["script-src 'none'"] } }));
        assert_eq!(ask("https://example.test/app.js", "script", true), json!({}));
        let redirect = ask("https://cdn.example.test/ad.gif", "image", false);
        assert!(redirect["redirectURL"].as_str().unwrap().starts_with("data:image/gif;base64,R0lGOD"));
        assert_eq!(ask("not a url", "script", false), json!({}));
    }

    #[test]
    fn cosmetics_split_hostname_rules_from_dom_updates() {
        let kernel = kernel();
        let first = kernel.cosmetics(1, r#"{"url":"https://example.test/","classes":["sponsor-box"],"ids":[],"initial":true}"#).unwrap();
        let styles = first["styles"].as_str().unwrap();
        assert!(styles.contains(".advert { display: none !important; }"));
        assert!(styles.contains(".sponsor-box { display: none !important; }"));
        let script = first["scripts"][0].as_str().unwrap();
        assert!(script.contains("function setConstant") && script.contains("setConstant(\"adsEnabled\", \"false\")"));
        let update = kernel.cosmetics(1, r#"{"url":"https://example.test/","classes":["sponsor-box"],"initial":false}"#).unwrap();
        assert_eq!(update, json!({ "styles": ".sponsor-box { display: none !important; }", "scripts": [] }));
        let other = kernel.cosmetics(1, r#"{"url":"https://other.test/","initial":true}"#).unwrap();
        assert_eq!(other["scripts"], json!([]));
        assert!(!other["styles"].as_str().unwrap().contains(".advert"));
    }

    #[test]
    fn trusted_scriptlets_need_a_trusted_list() {
        let mut kernel = Kernel::default();
        kernel.add(1, "example.test##+js(trusted-set)".to_owned());
        kernel.build(1);
        kernel.resources(1, RESOURCES).unwrap();
        let reply = kernel.cosmetics(1, r#"{"url":"https://example.test/"}"#).unwrap();
        assert_eq!(reply["scripts"], json!([]));
    }

    #[test]
    fn saved_engines_load_in_pieces() {
        let mut kernel = kernel();
        let saved = kernel.save(1, 0).unwrap();
        let bytes = BASE64_STANDARD.decode(&saved).unwrap();
        assert!(bytes.len() < SAVE_CHUNK);
        let mut fresh = Kernel::default();
        let (head, tail) = bytes.split_at(bytes.len() / 3 * 3 / 2 / 3 * 3);
        fresh.load(7, false, BASE64_STANDARD.encode(head).as_bytes()).unwrap();
        fresh.load(7, true, BASE64_STANDARD.encode(tail).as_bytes()).unwrap();
        fresh.resources(7, RESOURCES).unwrap();
        assert_eq!(fresh.request(7, false, "https://ads.example.test/x.js", "https://example.test/", "script", "get").unwrap(), json!({ "cancel": true }));
        assert!(fresh.load(8, true, b"not base64!").is_err());
        assert!(fresh.load(8, true, BASE64_STANDARD.encode("not an engine").as_bytes()).is_err());
        fresh.drop_slot(7);
        assert!(fresh.request(7, false, "https://ads.example.test/x.js", "", "script", "get").is_err());
    }

    #[test]
    fn a_saved_piece_fits_one_data_file() {
        assert_eq!(SAVE_CHUNK % 3, 0);
        assert!(SAVE_CHUNK / 3 * 4 + 64 <= 4 * 1024 * 1024);
    }

    #[test]
    fn list_text_decodes_from_base64_without_a_byte_order_mark() {
        assert_eq!(decode_text(BASE64_STANDARD.encode("\u{feff}||ads.test^\n").as_bytes()).unwrap(), "||ads.test^\n");
        assert_eq!(decode_text(BASE64_STANDARD.encode([0x7c, 0xff]).as_bytes()).unwrap(), "|\u{fffd}");
        assert!(decode_text(b"*").is_err());
    }

    #[test]
    fn electron_resource_types_map_to_engine_types() {
        let mut kernel = Kernel::default();
        kernel.add(1, "||frames.example.test^$subdocument\n||sockets.example.test^$websocket\n||api.example.test^$xmlhttprequest".to_owned());
        kernel.build(1);
        let blocked = |url: &str, kind: &str| kernel.request(1, false, url, "https://example.test/", kind, "GET").unwrap()["cancel"] == json!(true);
        assert!(blocked("https://frames.example.test/a", "subFrame"));
        assert!(!blocked("https://frames.example.test/a", "script"));
        assert!(blocked("wss://sockets.example.test/a", "webSocket"));
        assert!(blocked("https://api.example.test/a", "xhr"));
    }
}
