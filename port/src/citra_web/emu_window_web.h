// SPDX-License-Identifier: GPL-2.0-or-later
//
// Minimal Emscripten frontend window for the software renderer.
//
// This is a reconstruction, not the original port. The fork that produced the
// checked-in web/*.wasm is unavailable, and upstream Azahar has no SDL
// frontend at all (`SDL_CreateWindow` appears nowhere in src/), so this
// supplies the missing piece against upstream APIs. See FORK_HANDOFF.md.

#pragma once

#include <SDL.h>
#include "core/frontend/emu_window.h"

namespace Core {
class System;
}

/// Presents the software renderer's framebuffers to the browser canvas.
///
/// SDL2 under Emscripten binds its window to `Module.canvas`, which is the
/// contract web/azahar_ui.js already expects: it blits that canvas onto the
/// visible `#canvas`. Keeping SDL here means the existing UI needs no change.
class EmuWindow_Web : public Frontend::EmuWindow {
public:
    EmuWindow_Web();
    ~EmuWindow_Web() override;

    /// Drains SDL's queue and forwards keyboard/touch input to the web devices.
    /// Emscripten also needs this pumped for the canvas to stay responsive.
    void PollEvents() override;

    void MakeCurrent() override {}
    void DoneCurrent() override {}

    /// Composites both 3DS screens into the SDL surface and pushes it to the
    /// canvas. Non-blocking: the browser owns frame pacing.
    void Present(Core::System& system);

    /// Non-black pixel count across both screens, for the browser regression's
    /// "is anything actually rendering" gate.
    int NonBlackPixels(Core::System& system) const;

    bool IsOpen() const {
        return is_open;
    }

private:
    SDL_Window* window = nullptr;
    SDL_Surface* surface = nullptr;
    bool is_open = true;
};
