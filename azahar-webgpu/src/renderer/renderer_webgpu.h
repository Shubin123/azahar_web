// renderer_webgpu.h - WebGPU renderer stub interface
#pragma once

#include "webgpu_core/webgpu_device.h"

namespace SwRenderer {
namespace WebGPU {

class RendererWebGPU {
public:
    RendererWebGPU();
    ~RendererWebGPU();

    RendererWebGPU(const RendererWebGPU&) = delete;
    RendererWebGPU& operator=(const RendererWebGPU&) = delete;

    bool Initialize();
    void Shutdown();
    void RenderFrame();

    bool IsInitialized() const { return initialized_; }

private:
    bool initialized_{false};
};

} // namespace WebGPU
} // namespace SwRenderer
