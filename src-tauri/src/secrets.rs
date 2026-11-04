//! Tessie and Teslascope API tokens.
//!
//! Electron kept each token in `<userData>/<kind>-token.bin`, encrypted with
//! `safeStorage` (Chromium's os_crypt; a `plain:` prefix when encryption was
//! unavailable). The Tauri build keeps tokens in the OS credential store
//! instead: the macOS login Keychain, Windows Credential Manager, or the
//! Secret Service on Linux. The item's service is the app identifier and its
//! account is `<kind>-api-token`.
//!
//! On first read, a token Electron saved is decrypted, moved into the
//! credential store, and the old file is deleted. When no credential store is
//! usable (a Linux desktop without a Secret Service), the token falls back to
//! Electron's `plain:` file, exactly as Electron did.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::logger;
use crate::AppPaths;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Tessie,
    Teslascope,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Tessie => "tessie",
            Kind::Teslascope => "teslascope",
        }
    }
}

fn legacy_file(user_data: &Path, kind: Kind) -> PathBuf {
    user_data.join(format!("{}-token.bin", kind.name()))
}

fn entry(app: &AppHandle, kind: Kind) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(&app.config().identifier, &format!("{}-api-token", kind.name()))
}

pub fn load_token(app: &AppHandle, kind: Kind) -> String {
    let user_data = app.state::<AppPaths>().user_data.clone();
    let legacy = legacy_file(&user_data, kind);
    let stored = entry(app, kind).and_then(|e| e.get_password());
    match stored {
        Ok(token) => return token,
        Err(keyring::Error::NoEntry) => {}
        Err(e) => logger::warn("main", format!("{} token: credential store unavailable ({e}); using the token file", kind.name())),
    }
    if !legacy.exists() {
        return String::new();
    }
    match decode_legacy(&user_data, &std::fs::read(&legacy).unwrap_or_default()) {
        Ok(token) => {
            // Move it into the credential store; keep the file if that fails.
            if !token.is_empty() && entry(app, kind).and_then(|e| e.set_password(&token)).is_ok() {
                let _ = std::fs::remove_file(&legacy);
                logger::info("main", format!("{} token moved from Electron's token file to the credential store", kind.name()));
            }
            token
        }
        Err(e) => {
            logger::warn("main", format!("{} token from the Electron build could not be read: {e:#}", kind.name()));
            String::new()
        }
    }
}

pub fn save_token(app: &AppHandle, kind: Kind, token: &str) -> Result<()> {
    let user_data = app.state::<AppPaths>().user_data.clone();
    let legacy = legacy_file(&user_data, kind);
    if token.is_empty() {
        match entry(app, kind).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => logger::warn("main", format!("{} token: could not clear the credential store: {e}", kind.name())),
        }
        let _ = std::fs::remove_file(&legacy);
        return Ok(());
    }
    match entry(app, kind).and_then(|e| e.set_password(token)) {
        Ok(()) => {
            let _ = std::fs::remove_file(&legacy);
            Ok(())
        }
        Err(e) => {
            // Electron's fallback when safeStorage encryption is unavailable.
            logger::warn("main", format!("{} token: credential store unavailable ({e}); saving it unencrypted", kind.name()));
            std::fs::write(&legacy, [b"plain:".as_slice(), token.as_bytes()].concat()).context("write token file")
        }
    }
}

// ── Electron safeStorage (Chromium os_crypt) ────────────────────────────────

use crate::migrate::ELECTRON_APP_NAME;

pub fn decode_legacy(user_data: &Path, buf: &[u8]) -> Result<String> {
    if let Some(rest) = buf.strip_prefix(b"plain:") {
        return Ok(String::from_utf8(rest.to_vec())?);
    }
    let plain = os_crypt_decrypt(user_data, buf)?;
    Ok(String::from_utf8(plain)?)
}

#[allow(dead_code)]
fn cbc_decrypt(password: &[u8], iterations: u32, data: &[u8]) -> Result<Vec<u8>> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", iterations, &mut key);
    let iv = [b' '; 16];
    cbc::Decryptor::<aes::Aes128>::new(&key.into(), &iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(data)
        .map_err(|_| anyhow!("wrong key or corrupt data"))
}

#[cfg(target_os = "macos")]
fn os_crypt_decrypt(_user_data: &Path, buf: &[u8]) -> Result<Vec<u8>> {
    let data = buf.strip_prefix(b"v10").ok_or_else(|| anyhow!("unknown safeStorage format"))?;
    let password = safe_storage_password(ELECTRON_APP_NAME)?;
    cbc_decrypt(password.as_bytes(), 1003, data)
}

/// The safeStorage key Electron keeps in the login keychain.
#[cfg(target_os = "macos")]
pub fn safe_storage_password(app_name: &str) -> Result<String> {
    let service = format!("{app_name} Safe Storage");
    for account in [format!("{app_name} Key"), app_name.to_string()] {
        if let Ok(p) = keyring::Entry::new(&service, &account).and_then(|e| e.get_password()) {
            return Ok(p);
        }
    }
    bail!("no \"{service}\" keychain item")
}

#[cfg(target_os = "linux")]
fn os_crypt_decrypt(_user_data: &Path, buf: &[u8]) -> Result<Vec<u8>> {
    match buf.get(..3) {
        // The fixed key Chromium uses without a keyring.
        Some(b"v10") => cbc_decrypt(b"peanuts", 1, &buf[3..]),
        Some(b"v11") => bail!("token was encrypted with the desktop keyring; enter it again"),
        _ => bail!("unknown safeStorage format"),
    }
}

#[cfg(windows)]
fn os_crypt_decrypt(user_data: &Path, buf: &[u8]) -> Result<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    use base64::Engine;
    let data = buf.strip_prefix(b"v10").ok_or_else(|| anyhow!("unknown safeStorage format"))?;
    if data.len() < 12 + 16 {
        bail!("token data too short");
    }
    #[derive(Deserialize)]
    struct LocalState {
        os_crypt: OsCrypt,
    }
    #[derive(Deserialize)]
    struct OsCrypt {
        encrypted_key: String,
    }
    let state: LocalState = serde_json::from_slice(&std::fs::read(user_data.join("Local State"))?)?;
    let wrapped = base64::engine::general_purpose::STANDARD.decode(state.os_crypt.encrypted_key)?;
    let key = dpapi_unprotect(wrapped.strip_prefix(b"DPAPI").ok_or_else(|| anyhow!("unexpected key format"))?)?;
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow!("bad key length"))?;
    let (nonce, ct) = data.split_at(12);
    cipher.decrypt(nonce.into(), ct).map_err(|_| anyhow!("wrong key or corrupt data"))
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let mut input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: input points at `data` for the call; output is allocated by the
    // system and released with LocalFree after copying.
    unsafe {
        if CryptUnprotectData(&mut input, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), 0, &mut output) == 0 {
            bail!("DPAPI could not unwrap the key");
        }
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as _);
        Ok(out)
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct TokenArgs {
    #[serde(default)]
    token: String,
}

fn save_result(r: Result<()>) -> Value {
    match r {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "success": false, "error": format!("{e:#}") }),
    }
}

#[tauri::command]
pub async fn tessie_api_get_token(app: AppHandle) -> Value {
    tauri::async_runtime::spawn_blocking(move || json!({ "token": load_token(&app, Kind::Tessie) })).await.unwrap_or(json!({ "token": "" }))
}

#[tauri::command]
pub async fn tessie_api_save_token(app: AppHandle, args: TokenArgs) -> Value {
    tauri::async_runtime::spawn_blocking(move || save_result(save_token(&app, Kind::Tessie, &args.token)))
        .await
        .unwrap_or_else(|e| json!({ "success": false, "error": e.to_string() }))
}

#[tauri::command]
pub async fn teslascope_api_get_token(app: AppHandle) -> Value {
    tauri::async_runtime::spawn_blocking(move || json!({ "token": load_token(&app, Kind::Teslascope) })).await.unwrap_or(json!({ "token": "" }))
}

#[tauri::command]
pub async fn teslascope_api_save_token(app: AppHandle, args: TokenArgs) -> Value {
    tauri::async_runtime::spawn_blocking(move || save_result(save_token(&app, Kind::Teslascope, &args.token)))
        .await
        .unwrap_or_else(|e| json!({ "success": false, "error": e.to_string() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_tokens_decode() {
        assert_eq!(decode_legacy(Path::new("."), b"plain:abc123").unwrap(), "abc123");
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// Vectors made with Node's crypto: PBKDF2-SHA1(password, "saltysalt",
    /// iterations, 16 bytes), AES-128-CBC with an IV of 16 spaces, which is
    /// Chromium's os_crypt "v10" on macOS (keychain password, 1003
    /// iterations) and Linux without a keyring ("peanuts", 1 iteration).
    #[test]
    fn os_crypt_cbc_matches_chromium() {
        let mac = cbc_decrypt(b"test-password", 1003, &unhex("ed5629833b75bf415234f95d8ed79b05")).unwrap();
        assert_eq!(String::from_utf8(mac).unwrap(), "tok-123\u{e9}");
        let linux = cbc_decrypt(b"peanuts", 1, &unhex("2dacb4fea394581493628d52544026b9")).unwrap();
        assert_eq!(String::from_utf8(linux).unwrap(), "linux-tok");
        assert!(cbc_decrypt(b"wrong", 1003, &unhex("ed5629833b75bf415234f95d8ed79b05")).is_err());
    }
}
