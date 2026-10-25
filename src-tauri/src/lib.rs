// Native core: session store, transcript upsert, snapshot/send pipeline.
// Mirrors the TypeScript portable domain (src/domain/*) and the contracts in
// docs/CONTRACTS.md. Audio capture (WASAPI) and provider adapters land in
// P02 lanes; this scaffold owns storage, commands, and the generation registry.

pub mod audio;
pub mod commands;
pub mod providers;
pub mod store;

use store::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::list_sources,
            commands::ingest_transcript_event,
            commands::start_session,
            commands::pause_session,
            commands::resume_session,
            commands::stop_session,
            commands::select_transcript_range,
            commands::send_answer,
            commands::cancel_answer,
            commands::seek_reader,
            commands::save_correction,
            commands::import_document,
            commands::select_model_profile,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = store::init_db(&handle).await {
                    eprintln!("database init failed: {e:#}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running conversation-assistant");
}
