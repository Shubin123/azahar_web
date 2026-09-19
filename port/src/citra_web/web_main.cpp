// SPDX-License-Identifier: GPL-2.0-or-later
//
// Emscripten entry points for the web build.
//
// Reconstruction of the C API that web/azahar_ui.js and tests/ already target.
// The original lived in the fork's src/citra_sdl/emscripten_main.cpp; the
// surface is pinned by tests/web_artifact_smoke.cjs and by PROJECT.md's
// "Interface Contracts", and the frame-budget policy below is recovered from
// patches/emscripten-main-web.patch. See FORK_HANDOFF.md.

#include <algorithm>
#include <cstdio>
#include <exception>
#include <memory>
#include <string>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <emscripten/console.h>
#endif

#include "audio_core/sink_details.h"
#include "citra_web/emu_window_web.h"
#include "common/settings.h"
#include "core/core.h"
#include "core/frontend/applets/default_applets.h"
#include "core/hle/service/service.h"
#include "input_common/main.h"

namespace {

Core::System* g_system = nullptr;
std::unique_ptr<EmuWindow_Web> g_emu_window;
bool g_initialized = false;
bool g_rom_loaded = false;
int g_fast_forward_multiplier = 1;

#ifdef __EMSCRIPTEN__
double g_speed_last_wall_ms = 0.0;
double g_speed_target_us = 0.0;
double g_speed_last_guest_us = 0.0;
#endif

} // anonymous namespace

/// Initialize the core and the presentation window. Returns 0 on success.
namespace {

/// Report an escaping C++ exception instead of letting it reach JS, where it
/// surfaces as an opaque "Exception" with no message attached.
int ReportException(const char* where, const std::exception* e) {
    const char* what = e != nullptr ? e->what() : "unknown";
#ifdef __EMSCRIPTEN__
    // Go straight to the browser console: under pthreads, stderr through stdio
    // does not reliably reach it, which hides the only useful detail.
    emscripten_console_errorf("[azahar] %s threw: %s", where, what);
    // console.trace prints the wasm frames leading here, which is the only way
    // to locate a std::out_of_range raised deep inside the core.
    EM_ASM({ console.trace('[azahar] exception site'); });
#else
    std::fprintf(stderr, "[azahar] %s threw: %s\n", where, what);
#endif
    return -20;
}

} // anonymous namespace

extern "C" int azahar_init() {
    if (g_initialized) {
        return 0;
    }
  try {

    Settings::values.graphics_api.SetValue(Settings::GraphicsAPI::Software);
    // Browser WebAssembly cannot execute generated machine code.
    Settings::values.use_cpu_jit.SetValue(false);
    // requestAnimationFrame is the presentation clock. Leaving the native
    // limiter on makes RunLoop sleep on the browser main thread and waste the
    // frame budget it was just given.
    Settings::values.frame_limit.SetValue(0);
    // SDL's Emscripten backend opens a deprecated ScriptProcessor device whose
    // callbacks then fail asynchronously. patches/emscripten-main-web.patch
    // shows the port silenced audio for exactly this reason; an AudioWorklet
    // sink is the outstanding integration task.
    Settings::values.output_type.SetValue(AudioCore::SinkType::Null);

    // Registers the input device factories. Without it the HID service's
    // device lookup throws "unordered_map::at: key not found" during Load,
    // because the factory map is empty. The Qt frontend does this too.
    InputCommon::Init();

    g_system = &Core::System::GetInstance();
    Frontend::RegisterDefaultApplets(*g_system);
    g_emu_window = std::make_unique<EmuWindow_Web>();
    g_initialized = true;
    return 0;
  } catch (const std::exception& e) {
    return ReportException("azahar_init", &e);
  } catch (...) {
    return ReportException("azahar_init", nullptr);
  }
}

/// Load a title already written into MEMFS. Loader failures use distinct codes
/// so the browser does not report a missing file as encrypted.
extern "C" int azahar_load_rom(const char* path) {
    if (!g_initialized || g_system == nullptr) {
        return -1;
    }
  try {
    const auto result = g_system->Load(*g_emu_window, std::string{path});
    if (result != Core::System::ResultStatus::Success) {
        switch (result) {
        case Core::System::ResultStatus::ErrorLoader_ErrorEncrypted:
            return -8;
        case Core::System::ResultStatus::ErrorLoader_ErrorInvalidFormat:
            return -9;
        case Core::System::ResultStatus::ErrorGetLoader:
            return -10;
        default:
            return -2;
        }
    }
    g_rom_loaded = true;
#ifdef __EMSCRIPTEN__
    g_speed_last_wall_ms = 0.0;
    g_speed_target_us = 0.0;
    g_speed_last_guest_us = 0.0;
#endif
    return 0;
  } catch (const std::exception& e) {
    return ReportException("azahar_load_rom", &e);
  } catch (...) {
    return ReportException("azahar_load_rom", nullptr);
  }
}

/// Advance emulation within one browser frame, then present.
///
/// Returns 0 to continue, 1 when emulation has ended, negative on error.
extern "C" int azahar_step_frame() {
    if (!g_initialized || !g_rom_loaded || g_system == nullptr) {
        return -2;
    }
  try {
    g_emu_window->PollEvents();
    if (!g_emu_window->IsOpen()) {
        return 1;
    }

    auto result = Core::System::ResultStatus::Success;

#ifdef __EMSCRIPTEN__
    // Run many short core slices inside one callback rather than a single
    // long one: the interpreter makes real progress while the deadline keeps
    // the tab responsive for input and painting.
    //
    // The cap is a wall-clock deadline, not a slice count. A fixed count
    // silently becomes the binding limit whenever the display path is slow —
    // measured at ~4 ms of a 14 ms budget on a stalling backend, i.e. the
    // emulator idling ~70% of every frame it was given.
    const double now_ms = emscripten_get_now();
    const double guest_us = static_cast<double>(g_system->CoreTiming().GetGlobalTimeUs().count());
    const double wall_delta = now_ms - g_speed_last_wall_ms;

    if (g_speed_last_wall_ms == 0.0 || wall_delta > 250.0 || guest_us < g_speed_last_guest_us ||
        guest_us > g_speed_target_us + 250'000.0) {
        g_speed_target_us = guest_us;
    }
    // Non-blocking guest-time limiter: 1x targets real time, 4x targets four
    // guest seconds per wall second. Never underclock the guest.
    const double target_increment_us =
        std::clamp(wall_delta, 0.0, 100.0) * 1000.0 * g_fast_forward_multiplier;
    // Never accumulate missed guest time as debt: a slow scene must not make a
    // later light scene run fast to "catch up".
    const double max_target_lead_us = 100'000.0 * g_fast_forward_multiplier;
    g_speed_target_us = std::min(std::max(g_speed_target_us, guest_us) + target_increment_us,
                                 guest_us + max_target_lead_us);
    g_speed_last_wall_ms = now_ms;

    const double deadline_ms = now_ms + 14.0;
    while (emscripten_get_now() < deadline_ms) {
        result = g_system->RunLoop();
        if (result != Core::System::ResultStatus::Success) {
            break;
        }
        g_speed_last_guest_us = static_cast<double>(g_system->CoreTiming().GetGlobalTimeUs().count());
        if (g_speed_last_guest_us >= g_speed_target_us) {
            break;
        }
    }
#else
    result = g_system->RunLoop();
#endif

    if (result != Core::System::ResultStatus::Success) {
        return -3;
    }
    g_emu_window->Present(*g_system);
    return 0;
  } catch (const std::exception& e) {
    return ReportException("azahar_step_frame", &e);
  } catch (...) {
    return ReportException("azahar_step_frame", nullptr);
  }
}

extern "C" int azahar_shutdown() {
    if (g_system != nullptr && g_system->IsPoweredOn()) {
        g_system->Shutdown();
    }
    g_emu_window.reset();
    InputCommon::Shutdown();
    g_initialized = false;
    g_rom_loaded = false;
    return 0;
}

/// Kept for API compatibility. The browser drives stepping through
/// requestAnimationFrame, so there is no native loop to enter.
extern "C" int azahar_run_loop() {
    return 0;
}

extern "C" int azahar_framebuffer_nonblack_pixels() {
    if (!g_initialized || g_system == nullptr) {
        return -1;
    }
    return g_emu_window->NonBlackPixels(*g_system);
}

/// Fill `out` with [game_fps, system_fps, emulation_speed, ...]; `count` is the
/// number of doubles the caller allocated.
extern "C" int azahar_get_perf_stats(double* out, int count) {
    if (!g_initialized || g_system == nullptr || out == nullptr || count < 3) {
        return -1;
    }
    const auto stats = g_system->GetLastPerfStats();
    for (int i = 0; i < count; ++i) {
        out[i] = 0.0;
    }
    out[0] = stats.game_fps;
    out[1] = stats.system_fps;
    out[2] = stats.emulation_speed;
    return 0;
}

extern "C" int azahar_set_fast_forward(int multiplier) {
    g_fast_forward_multiplier = std::clamp(multiplier, 1, 4);
    return g_fast_forward_multiplier;
}

extern "C" int azahar_get_fast_forward() {
    return g_fast_forward_multiplier;
}

// ── Not yet reconstructed ───────────────────────────────────────────────────
// These exist because tests/web_artifact_smoke.cjs pins the export list and
// web/azahar_ui.js feature-detects them. They report "unsupported" rather than
// pretending to work: a save-state stub that silently returned success would
// make the UI show a slot that cannot be restored.

extern "C" int azahar_save_state(const char* path) {
    (void)path;
    return -1;
}

extern "C" int azahar_load_state(const char* path) {
    (void)path;
    return -1;
}

extern "C" int azahar_get_state_operation() {
    return 0;
}

extern "C" const char* azahar_get_program_id() {
    return "";
}

/// Internal resolution scaling belongs to the hardware renderers; the software
/// rasterizer always draws at native size.
extern "C" int azahar_set_resolution_scale(int scale) {
    (void)scale;
    return 1;
}

extern "C" int azahar_get_resolution_scale() {
    return 1;
}

extern "C" int azahar_reset_renderer_stats() {
    return 0;
}

extern "C" int azahar_get_renderer_stats(double* out, int count) {
    if (out == nullptr) {
        return -1;
    }
    for (int i = 0; i < count; ++i) {
        out[i] = 0.0;
    }
    return 0;
}
