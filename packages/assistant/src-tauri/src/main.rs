#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod terminal;
mod notifications;
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex, atomic::{AtomicBool, Ordering}},
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
fn selection_request(line: &str) -> Option<String> {
    let message: serde_json::Value = serde_json::from_str(line).ok()?;
    let id = message.get("requestId")?.as_str()?;
    (message.get("kind")?.as_str()? == "choose-project"
        && id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
        .then(|| id.to_owned())
}
fn choose_project(handle: tauri::AppHandle, request_id: String) {
    let ui = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        let selected = {
            use objc2_app_kit::{NSOpenPanel, NSModalResponseOK};
            let panel = NSOpenPanel::openPanel(objc2::MainThreadMarker::new().unwrap());
            panel.setCanChooseFiles(false);
            panel.setCanChooseDirectories(true);
            panel.setAllowsMultipleSelection(false);
            if panel.runModal() == NSModalResponseOK {
                panel.URL().and_then(|url| url.path()).map(|path| path.to_string())
            } else { None }
        };
        #[cfg(not(target_os = "macos"))]
        let selected: Option<String> = None;
        let message = serde_json::json!({"kind": "project-selected", "requestId": request_id, "path": selected});
        if let Some(child) = ui.state::<Host>().0.lock().unwrap().as_mut() {
            if let Some(stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all(format!("{}\n", message).as_bytes());
            }
        }
    });
}

struct ExitApproved(AtomicBool);
fn send_host(handle: &tauri::AppHandle, value: serde_json::Value) {
    if let Some(child) = handle.state::<Host>().0.lock().unwrap().as_mut() { if let Some(stdin) = child.stdin.as_mut() { let _ = writeln!(stdin, "{}", value); } }
}
fn native_request(handle: tauri::AppHandle, message: serde_json::Value) {
    use tauri_plugin_notification::NotificationExt;
    let Some(request_id) = message["requestId"].as_str().filter(|s| s.len() == 36).map(str::to_owned) else { return; };
    std::thread::spawn(move || {
        let method = message["method"].as_str().unwrap_or("");
        let result = match method {
            value if value.starts_with("terminal-") => handle.state::<terminal::Terminals>().request(value, &message["input"]),
            "notification-permission" => notifications::permission(true),
            "notification-status" => notifications::permission(false),
            "notification-show" => {
                if notifications::permission(false).ok().is_some_and(|v| v["permission"] == "granted") {
                    handle.notification().builder().title("Zhivex Assistant").body("Una tarea terminó o necesita tu atención. Abrí la app para revisar su estado.").show().map(|_| serde_json::json!({})).map_err(|_| "notification failed".into())
                } else { Err("notification permission".into()) }
            },
            _ => Err("unsupported native request".into())
        };
        send_host(&handle, match result { Ok(data) => serde_json::json!({"kind":"native-result","requestId":request_id,"ok":true,"data":data}), Err(_) => serde_json::json!({"kind":"native-result","requestId":request_id,"ok":false}) });
    });
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Host(Mutex::new(None)))
        .manage(ExitApproved(AtomicBool::new(false)))
        .manage(terminal::Terminals::default())
        .plugin(tauri_plugin_notification::init())
        .menu(|app| {
            let menu = tauri::menu::Menu::default(app)?;
            #[cfg(target_os = "macos")]
            if let Some(application) = menu.items()?.first().and_then(|item| item.as_submenu()).cloned() {
                // The platform predefined Quit invokes Cocoa terminate directly. Route the
                // standard accelerator through our host policy before asking Tauri to exit.
                let items = application.items()?;
                if !items.is_empty() { application.remove_at(items.len() - 1)?; }
                application.append(&tauri::menu::MenuItem::with_id(app, "controlled-quit", "Quit Zhivex Assistant", true, Some("CmdOrCtrl+Q"))?)?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| { if event.id().as_ref() == "controlled-quit" { app.exit(0); } })
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
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut line = String::new();
                    let mut reader = BufReader::new(stdout);
                    let _ = reader.by_ref().take(8192).read_line(&mut line);
                    let _ = tx.send(line);
                    loop {
                        let mut message = String::new();
                        match reader.by_ref().take(65536).read_line(&mut message) {
                            Ok(0) | Err(_) => break,
                            _ if !message.ends_with('\n') => break,
                            _ => { if let Some(id) = selection_request(&message) { choose_project(handle.clone(), id); }
                                else if let Ok(value) = serde_json::from_str::<serde_json::Value>(&message) { if value["kind"] == "native-request" { native_request(handle.clone(), value); } }
                            },
                        }
                    }
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
                    handle.state::<terminal::Terminals>().close_all();
                    if status.success() {
                        handle.state::<ExitApproved>().0.store(true, Ordering::SeqCst);
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
        match event {
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { api, .. }, .. } if label == "assistant" => {
                api.prevent_close(); if let Some(window) = app.get_webview_window("assistant") { let _ = window.hide(); }
            },
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => { if let Some(window) = app.get_webview_window("assistant") { let _ = window.show(); let _ = window.set_focus(); } },
            tauri::RunEvent::ExitRequested { api, .. } => {
                if app.state::<ExitApproved>().0.load(Ordering::SeqCst) || app.state::<Host>().0.lock().unwrap().is_none() {
                    app.state::<terminal::Terminals>().close_all(); app.state::<Host>().stop();
                } else {
                    api.prevent_exit();
                    if let Some(window) = app.get_webview_window("assistant") { let _ = window.show(); let _ = window.set_focus(); }
                    send_host(app, serde_json::json!({"kind":"quit-request"}));
                }
            },
            _ => {}
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
    #[test]
    fn folder_requests_have_only_a_correlated_identifier() {
        assert!(selection_request(r#"{"kind":"choose-project","requestId":"12345678-1234-1234-1234-123456789abc"}"#).is_some());
        assert!(selection_request(r#"{"kind":"shell","requestId":"12345678-1234-1234-1234-123456789abc"}"#).is_none());
        assert!(selection_request(r#"{"kind":"choose-project","requestId":"../../path"}"#).is_none());
    }
}
