// webgpu_shader.h - Shader module wrapper
#pragma once

#ifdef USE_WEBGPU

// #include "common/webgpu_types.h"
#include "common/webgpu_common.h"
#include <webgpu/webgpu.h>

#include "webgpu_device.h"

namespace WebGPU {

class ShaderModule {
public:
    ShaderModule(Device& device, const char* wgsl_code, const char* label = nullptr);
    ~ShaderModule();

    // No copy
    ShaderModule(const ShaderModule&) = delete;
    ShaderModule& operator=(const ShaderModule&) = delete;

    WGPUShaderModule GetHandle() const { return module_; }
    bool IsValid() const { return module_ != nullptr; }

private:
    WGPUShaderModule module_;
};


enum class ShaderStage {
    Vertex,
    Fragment,
    Compute
};


// Helper to convert GLSL to WGSL (stub - you'd use a real converter)
std::string ConvertGLSLToWGSL(const std::string& glsl_source, ShaderStage stage);

} // namespace WebGPU

#endif // USE_WEBGPU