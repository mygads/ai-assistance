# Mulai dari sini
Paket implementasi untuk Claude Code dan Codex • revisi 0.3 • 24 Oktober 2026.

Paket ini berisi spesifikasi dan instruksi eksekusi. Aplikasi Windows belum dibuat di dalam paket ini. Status awal semua pekerjaan aplikasi adalah pending; pemeriksaan paket tidak membuktikan aplikasi sudah bekerja.

1. Ekstrak seluruh paket ke folder proyek. Untuk proyek baru, gunakan folder kosong. Untuk repo yang sudah ada, minta agent menggabungkan instruksi dengan aturan yang ada; jangan menimpa pekerjaan pengguna.
2. Buka folder tersebut di Claude Code atau Codex.
3. Tempel isi prompts/START.md. Agent akan melakukan pemeriksaan lingkungan, menyiapkan proyek, mengimplementasikan fase, menguji, memperbaiki kegagalan, dan membuat artefak sesuai kesiapan lingkungan.
4. Idealnya jalankan pada Windows 11 x64 dengan desktop interaktif untuk pengujian aplikasi dan audio asli. Linux/cloud tetap dapat mengerjakan modul lintas platform dan tes replay, tetapi gate native Windows/audio tetap belum terbukti.
5. API key dimasukkan lewat penyimpanan kredensial aplikasi atau konfigurasi lokal yang tidak di-commit. Tanpa key, agent tetap mengerjakan semua pekerjaan yang tidak bergantung pada provider dan menandai gate live sebagai blocked.
6. Jika sesi berganti, tempel prompts/RESUME.md. Jika berpindah Claude Code ↔ Codex, gunakan checkout dan state yang sama melalui prosedur handoff, bukan dua penulis pada checkout sama.

Berkas utama:
- AGENTS.md: aturan bersama.
- CLAUDE.md: mengimpor aturan bersama untuk Claude Code.
- docs/ARCHITECTURE.md: perilaku produk dan rancangan sistem.
- docs/EXECUTION.md: sesi, paralel, worktree, checkpoint, pemulihan.
- docs/IMPLEMENTATION_PLAN.md: fase dan syarat kelulusan.
- docs/TESTING.md: tes, E2E, audio, provider, bukti, dan kualitas rilis.
- docs/CONTRACTS.md: event, command, snapshot, dan data.
- .agent/tasks.json: dependensi pekerjaan.
- .agent/state.json: status resmi antar sesi.
- .agent/acceptance.json: hubungan kebutuhan dengan pengujian.
- .agent/schemas/: skema kontrak awal.
- roles/: batas kerja tiap peran.
- .claude/agents/: wrapper subagent opsional, diverifikasi terhadap Claude Code terpasang.
- tools/check_pack.py: memeriksa konsistensi paket ini, bukan menjalankan tes aplikasi.

Pola eksekusi: satu coordinator; maksimal tiga worker independen sesudah kontrak dibekukan. Tersedia fallback satu agent secara berurutan. Fondasi, perubahan kontrak, integrasi, migrasi, dan keputusan rilis punya satu penanggung jawab.

Automation berjalan sejauh alat, kredensial, Windows, dan perangkat tersedia. Agent tidak boleh mengubah tes mock menjadi bukti hardware atau mengklaim screen-sharing aman untuk semua aplikasi. Kebutuhan input yang benar-benar tak tersedia dicatat satu kali, sementara pekerjaan lain tetap diteruskan.

Untuk memeriksa paket: jalankan python tools/check_pack.py dari root. Perintah aplikasi yang disebut dokumen harus dibuat dan benar-benar dijalankan agent pada P00 dan fase berikutnya.

