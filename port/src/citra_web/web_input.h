// SPDX-License-Identifier: GPL-2.0-or-later

#pragma once

#include <SDL.h>

namespace WebInput {

/// Register the lightweight browser input factories and populate the active
/// profile with parameters understood by them.
void Init();

/// Unregister the factories and release their shared state.
void Shutdown();

/// Feed an SDL keyboard transition into the current 3DS button/analog state.
void OnKey(SDL_Keycode key, bool pressed);

} // namespace WebInput
