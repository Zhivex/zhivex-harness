//! Native PTYs are owned by the shell, never by an agent tool or the webview.
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{collections::{HashMap, VecDeque}, io::{Read, Write}, sync::{Arc, Mutex}, time::Duration};
const CAPACITY: usize = 256 * 1024;
#[derive(Default)]
struct Output { bytes: VecDeque<u8>, end: u64, exit: Option<u32> }
struct Session { master: Box<dyn MasterPty + Send>, writer: Arc<Mutex<Box<dyn Write + Send>>>, output: Arc<Mutex<Output>>, pid: u32 }
#[derive(Default)]
pub struct Terminals(Mutex<HashMap<String, Session>>);
fn size(v: &Value) -> Result<PtySize, String> {
    let cols = v["cols"].as_u64().filter(|v| (20..=400).contains(v)).ok_or("columns")?;
    let rows = v["rows"].as_u64().filter(|v| (5..=200).contains(v)).ok_or("rows")?;
    Ok(PtySize { cols: cols as u16, rows: rows as u16, pixel_width: 0, pixel_height: 0 })
}
/// Kill every ordinary job in the PTY's POSIX session, including background job groups.
/// A deliberately detached daemon with a new session is outside terminal ownership.
#[cfg(unix)]
fn stop_session(leader: u32) {
    let processes = std::process::Command::new("/bin/ps").args(["-axo", "pid="]).output();
    let pids: Vec<i32> = processes.ok().map(|p| String::from_utf8_lossy(&p.stdout).split_whitespace().filter_map(|s| s.parse::<i32>().ok()).filter(|pid| *pid > 1 && unsafe { libc::getsid(*pid) } == leader as i32).collect()).unwrap_or_default();
    for pid in &pids { unsafe { libc::kill(*pid, libc::SIGTERM); } }
    std::thread::sleep(Duration::from_millis(100));
    for pid in pids { if unsafe { libc::getsid(pid) } == leader as i32 { unsafe { libc::kill(pid, libc::SIGKILL); } } }
}
#[cfg(not(unix))]
fn stop_session(_: u32) {}
impl Terminals {
    pub fn close_all(&self) { let sessions = std::mem::take(&mut *self.0.lock().unwrap()); for (_, session) in sessions { stop_session(session.pid); } }
    pub fn request(&self, method: &str, input: &Value) -> Result<Value, String> {
        if method == "terminal-close-all" { self.close_all(); return Ok(json!({})); }
        let id = input["id"].as_str().filter(|s| s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')).ok_or("id")?;
        let mut sessions = self.0.lock().unwrap();
        if method == "terminal-open" {
            if !cfg!(target_os = "macos") { return Err("platform unavailable".into()); }
            if sessions.len() >= 8 || sessions.contains_key(id) { return Err("capacity".into()); }
            let cwd = input["cwd"].as_str().ok_or("cwd")?;
            let canonical = std::fs::canonicalize(cwd).map_err(|_| "cwd")?;
            if !canonical.is_dir() || canonical.to_str() != Some(cwd) { return Err("cwd".into()); }
            let pair = native_pty_system().openpty(size(input)?).map_err(|_| "pty")?;
            // Fixed platform shell and explicit environment allowlist. Provider credentials,
            // bearer tokens and Node injection options are never inherited from the host.
            let mut command = CommandBuilder::new("/bin/zsh"); command.arg("-l"); command.env_clear(); command.cwd(canonical);
            for name in ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "TMPDIR"] { if let Ok(value) = std::env::var(name) { command.env(name, value); } }
            command.env("TERM", "xterm-256color"); command.env("COLORTERM", "truecolor");
            let mut child = pair.slave.spawn_command(command).map_err(|_| "spawn")?;
            let pid = child.process_id().ok_or("pid")?;
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().map_err(|_| "reader")?;
            let writer = pair.master.take_writer().map_err(|_| "writer")?;
            let output = Arc::new(Mutex::new(Output::default())); let stream = output.clone();
            std::thread::spawn(move || { let mut bytes = [0u8; 8192]; while let Ok(n) = reader.read(&mut bytes) { if n == 0 { break; } let mut state = stream.lock().unwrap(); state.bytes.extend(&bytes[..n]); state.end += n as u64; while state.bytes.len() > CAPACITY { state.bytes.pop_front(); } } });
            let ended = output.clone(); std::thread::spawn(move || { let code = child.wait().map(|s| s.exit_code()).unwrap_or(1); stop_session(pid); ended.lock().unwrap().exit = Some(code); });
            sessions.insert(id.into(), Session { master: pair.master, writer: Arc::new(Mutex::new(writer)), output, pid });
            return Ok(json!({ "id": id }));
        }
        if method == "terminal-close" { let session = sessions.remove(id).ok_or("missing")?; drop(sessions); stop_session(session.pid); return Ok(json!({})); }
        let session = sessions.get_mut(id).ok_or("missing")?;
        match method {
            "terminal-read" => { let state = session.output.lock().unwrap(); let after = input["after"].as_u64().ok_or("cursor")?; if after > state.end { return Err("cursor".into()); } let start = state.end - state.bytes.len() as u64; let from = after.max(start); let bytes: Vec<u8> = state.bytes.iter().skip((from-start) as usize).take(16384).copied().collect(); let mut result = json!({ "start": from, "end": from + bytes.len() as u64, "data": bytes, "truncated": after < start }); if let Some(code) = state.exit { result["exitCode"] = json!(code); } Ok(result) }
            "terminal-write" => { let data = input["data"].as_str().filter(|s| s.len() <= 32768).ok_or("data")?; if session.output.lock().unwrap().exit.is_some() { return Err("exited".into()); } let writer = session.writer.clone(); drop(sessions); writer.lock().unwrap().write_all(data.as_bytes()).map_err(|_| "write")?; Ok(json!({})) }
            "terminal-resize" => { session.master.resize(size(input)?).map_err(|_| "resize")?; Ok(json!({})) }
            _ => Err("method".into())
        }
    }
}
impl Drop for Terminals { fn drop(&mut self) { self.close_all(); } }
#[cfg(test)]
mod tests {
 use super::*;
 #[test] fn rejects_untrusted_terminal_dimensions_and_identifiers() { let terminals=Terminals::default(); assert!(size(&json!({"cols":0,"rows":24})).is_err()); assert!(terminals.request("terminal-write", &json!({"id":"../path","data":"x"})).is_err()); }
 #[test] #[cfg(target_os="macos")] fn native_pty_has_tty_resize_input_and_exit() {
  let terminals=Terminals::default(); let id="12345678-1234-1234-1234-123456789abc"; let cwd=std::fs::canonicalize(std::env::temp_dir()).unwrap();
  terminals.request("terminal-open",&json!({"id":id,"cwd":cwd,"cols":90,"rows":30})).unwrap();
  terminals.request("terminal-resize",&json!({"id":id,"cols":100,"rows":40})).unwrap();
  terminals.request("terminal-write",&json!({"id":id,"data":"stty size; test -t 0 && echo PTY_OK; exit\r"})).unwrap();
  let deadline=std::time::Instant::now()+Duration::from_secs(10); let mut text=String::new();let mut after=0;
  loop { let page=terminals.request("terminal-read",&json!({"id":id,"after":after})).unwrap();after=page["end"].as_u64().unwrap();let bytes:Vec<u8>=page["data"].as_array().unwrap().iter().map(|v|v.as_u64().unwrap() as u8).collect();text.push_str(&String::from_utf8_lossy(&bytes));if page.get("exitCode").is_some(){break;}assert!(std::time::Instant::now()<deadline,"{text}");std::thread::sleep(Duration::from_millis(50)); }
  assert!(text.contains("40 100"),"{text}");assert!(text.contains("PTY_OK"));terminals.close_all();
 }
 #[test] #[cfg(target_os="macos")] fn interrupt_and_close_clean_up_foreground_and_background_jobs() {
  let terminals=Terminals::default();let id="22345678-1234-1234-1234-123456789abc";
  let root=std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("pty-jobs-{}",std::process::id()));std::fs::create_dir_all(&root).unwrap();
  terminals.request("terminal-open",&json!({"id":id,"cwd":root,"cols":80,"rows":24})).unwrap();
  terminals.request("terminal-write",&json!({"id":id,"data":"sleep 60 & echo $! > background.pid; sleep 60\r"})).unwrap();
  let deadline=std::time::Instant::now()+Duration::from_secs(10);
  while !root.join("background.pid").exists(){assert!(std::time::Instant::now()<deadline);std::thread::sleep(Duration::from_millis(30));}
  let pid:i32=std::fs::read_to_string(root.join("background.pid")).unwrap().trim().parse().unwrap();
  std::thread::sleep(Duration::from_millis(100));
  terminals.request("terminal-write",&json!({"id":id,"data":"\u{3}"})).unwrap();
  terminals.request("terminal-write",&json!({"id":id,"data":"echo alive > interrupted.ok\r"})).unwrap();
  while !root.join("interrupted.ok").exists(){assert!(std::time::Instant::now()<deadline,"shell did not survive Ctrl+C");std::thread::sleep(Duration::from_millis(30));}
  terminals.request("terminal-close",&json!({"id":id})).unwrap();
  while unsafe{libc::kill(pid,0)}==0{assert!(std::time::Instant::now()<deadline,"background process survived terminal close");std::thread::sleep(Duration::from_millis(30));}
  std::fs::remove_dir_all(root).unwrap();
 }

}
