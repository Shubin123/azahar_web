// renderer_webgpu.cpp - WebGPU renderer stub implementation
#include "renderer/renderer_webgpu.h"

namespace SwRenderer {
namespace WebGPU {

RendererWebGPU::RendererWebGPU() = default;

RendererWebGPU::~RendererWebGPU() {
    Shutdown();
}

bool RendererWebGPU::Initialize() {
    initialized_ = true;
    return true;
}

void RendererWebGPU::Shutdown() {
    initialized_ = false;
}

void RendererWebGPU::RenderFrame() {
    if (!initialized_) {
        return;
    }
}

} // namespace WebGPU
} // namespace SwRenderer
