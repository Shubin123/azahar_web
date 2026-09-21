// SPDX-License-Identifier: GPL-2.0-or-later

#include "citra_web/emu_window_web.h"
#include "citra_web/web_input.h"

#include <algorithm>
#include <cstring>

#include "core/core.h"
#include "video_core/gpu.h"
#include "video_core/renderer_base.h"
#include "video_core/renderer_software/renderer_software.h"

namespace {

// The 3DS screens stacked as the UI canvas expects: 400x240 top, 320x240
// bottom centred beneath it. web/index.html declares exactly this size.
constexpr int kCanvasWidth = 400;
constexpr int kCanvasHeight = 480;
constexpr int kBottomXOffset = 40;
constexpr int kBottomYOffset = 240;

/// Blit one logical, row-major software screen into the surface.
void BlitScreen(SDL_Surface* surface, const SwRenderer::ScreenInfo& screen, int dst_x, int dst_y,
                int dst_w, int dst_h) {
    if (screen.pixels.empty() || screen.width == 0 || screen.height == 0) {
        return;
    }
    auto* dst_base = static_cast<u8*>(surface->pixels);
    const int pitch = surface->pitch;

    const int copy_width = std::min<int>(dst_w, screen.width);
    const int copy_height = std::min<int>(dst_h, screen.height);
    for (int y = 0; y < copy_height; ++y) {
        auto* dst = reinterpret_cast<u32*>(dst_base + (dst_y + y) * pitch) + dst_x;
        const auto* src = reinterpret_cast<const u32*>(screen.pixels.data()) + y * screen.width;
        std::memcpy(dst, src, static_cast<std::size_t>(copy_width) * sizeof(u32));
    }
}

} // anonymous namespace

EmuWindow_Web::EmuWindow_Web() : Frontend::EmuWindow() {
    SDL_Init(SDL_INIT_VIDEO);
    window = SDL_CreateWindow("Azahar", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,
                              kCanvasWidth, kCanvasHeight, 0);
    if (window != nullptr) {
        surface = SDL_GetWindowSurface(window);
    }
    // The core sizes its framebuffer layout from this, so it must be set before
    // a title is loaded rather than at first present.
    UpdateCurrentFramebufferLayout(kCanvasWidth, kCanvasHeight);
}

EmuWindow_Web::~EmuWindow_Web() {
    if (window != nullptr) {
        SDL_DestroyWindow(window);
        window = nullptr;
    }
    SDL_Quit();
}

void EmuWindow_Web::PollEvents() {
    SDL_Event event;
    while (SDL_PollEvent(&event) != 0) {
        switch (event.type) {
        case SDL_QUIT:
            is_open = false;
            break;
        case SDL_KEYDOWN:
        case SDL_KEYUP:
            if (event.key.repeat == 0) {
                WebInput::OnKey(event.key.keysym.sym, event.type == SDL_KEYDOWN);
            }
            break;
        case SDL_MOUSEBUTTONDOWN:
            if (event.button.button == SDL_BUTTON_LEFT) {
                TouchPressed(static_cast<unsigned>(event.button.x),
                             static_cast<unsigned>(event.button.y));
            }
            break;
        case SDL_MOUSEBUTTONUP:
            if (event.button.button == SDL_BUTTON_LEFT) {
                TouchReleased();
            }
            break;
        case SDL_MOUSEMOTION:
            if ((event.motion.state & SDL_BUTTON_LMASK) != 0) {
                TouchMoved(static_cast<unsigned>(event.motion.x),
                           static_cast<unsigned>(event.motion.y));
            }
            break;
        case SDL_FINGERDOWN:
        case SDL_FINGERMOTION:
            TouchPressed(static_cast<unsigned>(event.tfinger.x * kCanvasWidth),
                         static_cast<unsigned>(event.tfinger.y * kCanvasHeight));
            break;
        case SDL_FINGERUP:
            TouchReleased();
            break;
        default:
            break;
        }
    }
}

void EmuWindow_Web::Present(Core::System& system) {
    if (window == nullptr || !system.IsPoweredOn()) {
        return;
    }
    // Re-fetch every frame: Emscripten can replace the surface when the canvas
    // is resized, and holding a stale pointer writes into freed memory.
    surface = SDL_GetWindowSurface(window);
    if (surface == nullptr) {
        return;
    }

    const auto& renderer = static_cast<const SwRenderer::RendererSoftware&>(system.GPU().Renderer());
    SDL_LockSurface(surface);
    BlitScreen(surface, renderer.Screen(VideoCore::ScreenId::TopLeft), 0, 0, 400, 240);
    BlitScreen(surface, renderer.Screen(VideoCore::ScreenId::Bottom), kBottomXOffset,
               kBottomYOffset, 320, 240);
    SDL_UnlockSurface(surface);
    SDL_UpdateWindowSurface(window);
}

int EmuWindow_Web::NonBlackPixels(Core::System& system) const {
    if (!system.IsPoweredOn()) {
        return -1;
    }
    const auto& renderer = static_cast<const SwRenderer::RendererSoftware&>(system.GPU().Renderer());
    int count = 0;
    for (const auto id : {VideoCore::ScreenId::TopLeft, VideoCore::ScreenId::Bottom}) {
        const auto& pixels = renderer.Screen(id).pixels;
        for (std::size_t i = 0; i + 3 < pixels.size(); i += 4) {
            if (pixels[i] != 0 || pixels[i + 1] != 0 || pixels[i + 2] != 0) {
                ++count;
            }
        }
    }
    return count;
}
