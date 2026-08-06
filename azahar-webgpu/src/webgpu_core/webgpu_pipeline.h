#pragma once
#include <webgpu/webgpu.h>

namespace WebGPU {

class Device;
class ShaderModule;

class Pipeline {
public:
    Pipeline() = default;
    Pipeline(const Pipeline&) = delete;
    Pipeline& operator=(const Pipeline&) = delete;
    Pipeline(Pipeline&& other) noexcept;
    Pipeline& operator=(Pipeline&& other) noexcept;
    ~Pipeline();

    bool CreateGraphics(Device& device, const ShaderModule& shader,
                        const char* vertex_entry = "vs_main",
                        const char* fragment_entry = "fs_main");

    void Reset();
    bool IsValid() const { return pipeline_ != nullptr; }
    WGPURenderPipeline GetHandle() const { return pipeline_; }

private:
    WGPURenderPipeline pipeline_ = nullptr;
};

} // namespace WebGPU
