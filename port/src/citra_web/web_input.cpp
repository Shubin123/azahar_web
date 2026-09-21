// SPDX-License-Identifier: GPL-2.0-or-later

#include "citra_web/web_input.h"

#include <array>
#include <atomic>
#include <memory>
#include <string>
#include <tuple>

#include "common/param_package.h"
#include "common/settings.h"
#include "core/frontend/input.h"

namespace WebInput {
namespace {

using Settings::NativeAnalog::CStick;
using Settings::NativeAnalog::CirclePad;
using Settings::NativeButton::Values;

struct State {
    std::array<std::atomic_bool, Settings::NativeButton::NumButtons> buttons{};
    std::array<std::atomic_bool, 4> circle{}; // up, down, left, right
    std::array<std::atomic_bool, 4> cstick{};
};

std::shared_ptr<State> state;

class ButtonDevice final : public Input::ButtonDevice {
public:
    ButtonDevice(std::shared_ptr<State> state_, std::size_t index_)
        : state{std::move(state_)}, index{index_} {}

    bool GetStatus() const override {
        return index < state->buttons.size() && state->buttons[index].load();
    }

private:
    std::shared_ptr<State> state;
    std::size_t index;
};

class ButtonFactory final : public Input::Factory<Input::ButtonDevice> {
public:
    explicit ButtonFactory(std::shared_ptr<State> state_) : state{std::move(state_)} {}

    std::unique_ptr<Input::ButtonDevice> Create(const Common::ParamPackage& params) override {
        return std::make_unique<ButtonDevice>(state, params.Get("index", 0));
    }

private:
    std::shared_ptr<State> state;
};

class AnalogDevice final : public Input::AnalogDevice {
public:
    AnalogDevice(std::shared_ptr<State> state_, std::size_t index_)
        : state{std::move(state_)}, index{index_} {}

    std::tuple<float, float> GetStatus() const override {
        const auto& keys = index == CStick ? state->cstick : state->circle;
        const float x = static_cast<float>(keys[3].load()) - static_cast<float>(keys[2].load());
        const float y = static_cast<float>(keys[0].load()) - static_cast<float>(keys[1].load());
        return {x, y};
    }

private:
    std::shared_ptr<State> state;
    std::size_t index;
};

class AnalogFactory final : public Input::Factory<Input::AnalogDevice> {
public:
    explicit AnalogFactory(std::shared_ptr<State> state_) : state{std::move(state_)} {}

    std::unique_ptr<Input::AnalogDevice> Create(const Common::ParamPackage& params) override {
        return std::make_unique<AnalogDevice>(state, params.Get("index", 0));
    }

private:
    std::shared_ptr<State> state;
};

constexpr std::array<std::pair<SDL_Keycode, Values>, Settings::NativeButton::NumButtons>
    button_map{{
        {SDLK_a, Values::A},       {SDLK_s, Values::B},     {SDLK_z, Values::X},
        {SDLK_x, Values::Y},       {SDLK_t, Values::Up},    {SDLK_g, Values::Down},
        {SDLK_f, Values::Left},    {SDLK_h, Values::Right}, {SDLK_q, Values::L},
        {SDLK_w, Values::R},       {SDLK_m, Values::Start}, {SDLK_n, Values::Select},
        {SDLK_o, Values::Debug},   {SDLK_p, Values::Gpio14},
        {SDLK_1, Values::ZL},      {SDLK_2, Values::ZR},
        {SDLK_b, Values::Home},    {SDLK_v, Values::Power},
    }};

void SetDirectional(std::array<std::atomic_bool, 4>& target, SDL_Keycode key, bool pressed,
                    const std::array<SDL_Keycode, 4>& mapping) {
    for (std::size_t i = 0; i < mapping.size(); ++i) {
        if (key == mapping[i]) {
            target[i].store(pressed);
        }
    }
}

} // anonymous namespace

void Init() {
    state = std::make_shared<State>();
    Input::RegisterFactory<Input::ButtonDevice>("web_button",
                                                 std::make_shared<ButtonFactory>(state));
    Input::RegisterFactory<Input::AnalogDevice>("web_analog",
                                                 std::make_shared<AnalogFactory>(state));

    auto& profile = Settings::values.current_input_profile;
    for (std::size_t i = 0; i < profile.buttons.size(); ++i) {
        profile.buttons[i] = "engine:web_button,index:" + std::to_string(i);
    }
    for (std::size_t i = 0; i < profile.analogs.size(); ++i) {
        profile.analogs[i] = "engine:web_analog,index:" + std::to_string(i);
    }
    profile.motion_device = "engine:null";
    profile.touch_device = "engine:emu_window";
    profile.controller_touch_device.clear();
    profile.use_touchpad = false;
    profile.use_touch_from_button = false;
}

void Shutdown() {
    Input::UnregisterFactory<Input::ButtonDevice>("web_button");
    Input::UnregisterFactory<Input::AnalogDevice>("web_analog");
    state.reset();
}

void OnKey(SDL_Keycode key, bool pressed) {
    if (!state) {
        return;
    }
    for (const auto& [mapped_key, button] : button_map) {
        if (key == mapped_key) {
            state->buttons[static_cast<std::size_t>(button)].store(pressed);
        }
    }
    SetDirectional(state->circle, key, pressed,
                   {SDLK_UP, SDLK_DOWN, SDLK_LEFT, SDLK_RIGHT});
    SetDirectional(state->cstick, key, pressed, {SDLK_i, SDLK_k, SDLK_j, SDLK_l});
}

} // namespace WebInput
