// SPDX-License-Identifier: GPL-2.0-or-later

#include "citra_web/emu_window_web.h"

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

/// Blit one software screen into the surface.
///
/// The renderer stores each screen rotated 90 degrees, the way the 3DS LCDs
/// are physically mounted: `pixels` runs down a column of the displayed image.
/// So source row `x` supplies destination column `x`, and the source is walked
/// backwards vertically to undo the rotation.
void BlitScreen(SDL_Surface* surface, const SwRenderer::ScreenInfo& screen, int dst_x, int dst_y,
                int dst_w, int dst_h) {
    if (screen.pixels.empty() || screen.width == 0 || screen.height == 0) {
        return;
    }
    auto* dst_base = static_cast<u8*>(surface->pixels);
    const int pitch = surface->pitch;

    for (int y = 0; y < dst_h; ++y) {
        auto* dst = reinterpret_cast<u32*>(dst_base + (dst_y + y) * pitch) + dst_x;
        for (int x = 0; x < dst_w; ++x) {
            // screen.width is the rotated extent, i.e. the displayed height.
            const u32 src_x = static_cast<u32>(screen.width - 1 - y);
            const u32 src_y = static_cast<u32>(x);
            const std::size_t index = (src_y * screen.width + src_x) * 4;
            if (index + 3 >= screen.pixels.size()) {
                continue;
            }
            const u8 r = screen.pixels[index + 0];
            const u8 g = screen.pixels[index + 1];
            const u8 b = screen.pixels[index + 2];
            dst[x] = (0xFFu << 24) | (static_cast<u32>(b) << 16) | (static_cast<u32>(g) << 8) | r;
        }
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
        if (event.type == SDL_QUIT) {
            is_open = false;
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
