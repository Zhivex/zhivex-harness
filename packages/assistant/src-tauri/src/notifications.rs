use serde_json::{json, Value};
#[cfg(target_os="macos")]
pub fn permission(request: bool) -> Result<Value, String> {
    use objc2_user_notifications::{UNUserNotificationCenter, UNNotificationSettings, UNAuthorizationOptions};
    use std::{ptr::NonNull, sync::mpsc, time::Duration};
    let center = UNUserNotificationCenter::currentNotificationCenter();
    if request {
        let (tx, rx) = mpsc::channel();
        let callback = block2::RcBlock::new(move |granted: objc2::runtime::Bool, _: *mut objc2_foundation::NSError| { let _ = tx.send(granted.as_bool()); });
        center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &callback);
        rx.recv_timeout(Duration::from_secs(110)).map_err(|_| "permission timeout")?;
    }
    let (tx, rx) = mpsc::channel();
    let callback = block2::RcBlock::new(move |settings: NonNull<UNNotificationSettings>| { let _ = tx.send(unsafe { settings.as_ref() }.authorizationStatus().0); });
    center.getNotificationSettingsWithCompletionHandler(&callback);
    let status = rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "permission unavailable")?;
    Ok(json!({ "permission": match status { 2 | 3 | 4 => "granted", 1 => "denied", _ => "not-determined" } }))
}
#[cfg(not(target_os="macos"))]
pub fn permission(_: bool) -> Result<Value, String> { Ok(json!({"permission":"unavailable"})) }
