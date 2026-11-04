//! The one network seam the provider clients use, so everything above it can
//! run against fixture responses.

use std::time::Duration;

/// `https.get({ host, path, headers, timeout: 15000 })`: returns the status
/// and the body text, or the transport error message ("timeout" on timeout).
pub trait Http: Send + Sync {
    fn get(&self, host: &str, path: &str, headers: &[(&str, String)]) -> Result<(u16, String), String>;
}

pub struct UreqHttp;

impl Http for UreqHttp {
    fn get(&self, host: &str, path: &str, headers: &[(&str, String)]) -> Result<(u16, String), String> {
        let url = format!("https://{host}{path}");
        let agent = crate::app_commands::http_agent(Duration::from_secs(15));
        let mut req = agent.get(&url);
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        let err = |e: ureq::Error| match e {
            ureq::Error::Timeout(_) => "timeout".to_string(),
            e => e.to_string(),
        };
        let mut res = req.call().map_err(err)?;
        let status = res.status().as_u16();
        let bytes = res.body_mut().with_config().limit(512 * 1024 * 1024).read_to_vec().map_err(err)?;
        Ok((status, String::from_utf8_lossy(&bytes).into_owned()))
    }
}
