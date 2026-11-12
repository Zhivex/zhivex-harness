#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct Host(Mutex<Option<Child>>);
impl Host {
    fn stop(&self) {
        if let Some(mut child) = self.0.lock().unwrap().take() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(b"stop\n");
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn local_url(value: &str) -> Option<tauri::Url> {
    let url = tauri::Url::parse(value).ok()?;
    (url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url
            .fragment()
            .is_some_and(|s| s.starts_with("token=") && s.len() > 20))
    .then_some(url)
}
fn external(url: &tauri::Url) {
    // OAuth, citations and Telegram go to the system browser, never a privileged webview.
    if url.scheme() == "https" && url.username().is_empty() && url.password().is_none() {
        let _ = open::that(url.as_str());
    }
}
fn main() {
    let app = tauri::Builder::default()
        .manage(Host(Mutex::new(None)))
        .setup(|app| {
            let runtime = if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("runtime")
            } else {
                app.path().resource_dir()?.join("runtime")
            };
            let node = runtime.join(if cfg!(windows) { "node.exe" } else { "node" });
            let result = (|| -> Option<tauri::Url> {
                let mut command = Command::new(node);
                command
                    .arg(runtime.join("dist/desktop.js"))
                    .current_dir(&runtime)
                    .env_remove("NODE_OPTIONS")
                    .env_remove("NODE_PATH")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null());
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x08000000);
                }
                let mut child = command.spawn().ok()?;
                let stdout = child.stdout.take()?;
                *app.state::<Host>().0.lock().unwrap() = Some(child);
                let (tx, rx) = mpsc::channel();
                std::thread::spawn(move || {
                    let mut line = String::new();
                    let mut reader = BufReader::new(stdout);
                    let _ = reader.by_ref().take(8192).read_line(&mut line);
                    let _ = tx.send(line);
                    let _ = std::io::copy(&mut reader, &mut std::io::sink());
                });
                let line = rx.recv_timeout(Duration::from_secs(90)).ok()?;
                let ready: serde_json::Value = serde_json::from_str(&line).ok()?;
                local_url(ready.get("url")?.as_str()?)
            })();
            if let Some(url) = result {
                let origin = url.origin();
                WebviewWindowBuilder::new(app, "assistant", WebviewUrl::External(url))
                    .title("Zhivex Assistant")
                    .inner_size(1280.0, 850.0)
                    .min_inner_size(700.0, 520.0)
                    .on_navigation(move |next| {
                        if next.origin() == origin {
                            true
                        } else {
                            external(next);
                            false
                        }
                    })
                    .on_new_window(|url, _| {
                        external(&url);
                        tauri::webview::NewWindowResponse::Deny
                    })
                    .build()?;
            } else {
                app.state::<Host>().stop();
                WebviewWindowBuilder::new(
                    app,
                    "startup-error",
                    WebviewUrl::App("index.html".into()),
                )
                .title("Zhivex Assistant")
                .inner_size(760.0, 520.0)
                .build()?;
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(500));
                let state = handle.state::<Host>();
                let mut guard = state.0.lock().unwrap();
                let Some(child) = guard.as_mut() else {
                    break;
                };
                if let Ok(Some(status)) = child.try_wait() {
                    guard.take();
                    drop(guard);
                    if status.success() {
                        handle.exit(0);
                    } else {
                        let _ = WebviewWindowBuilder::new(
                            &handle,
                            "host-error",
                            WebviewUrl::App("index.html".into()),
                        )
                        .title("Zhivex Assistant")
                        .inner_size(760.0, 520.0)
                        .build();
                        if let Some(window) = handle.get_webview_window("assistant") {
                            let _ = window.close();
                        }
                    }
                    break;
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not initialize Assistant window");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            app.state::<Host>().stop();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_private_loopback_ready_urls() {
        assert!(local_url("http://127.0.0.1:1234/#token=012345678901234567890123456789").is_some());
        for value in [
            "https://example.com/#token=012345678901234567890",
            "http://localhost:1234/#token=012345678901234567890",
            "http://user@127.0.0.1:1234/#token=012345678901234567890",
            "http://127.0.0.1:1234/",
            "http://127.0.0.1:1234/api/#token=012345678901234567890",
        ] {
            assert!(local_url(value).is_none());
        }
    }
}
