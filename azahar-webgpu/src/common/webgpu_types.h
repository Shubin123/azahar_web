// webgpu_types.h - Common WebGPU types and utilities
#pragma once

#ifdef USE_WEBGPU

#include <webgpu/webgpu.h>
#include <cstdint>
#include <string>
#include <vector>
#include <memory>
#include <functional>

namespace WebGPU {

// Forward declarations
class Device;
class Buffer;
class Texture;
class Pipeline;
class Shader;

// Common enums matching our existing renderer
enum class BufferUsage {
    Vertex = WGPUBufferUsage_Vertex,
    Index = WGPUBufferUsage_Index,
    Uniform = WGPUBufferUsage_Uniform,
    Storage = WGPUBufferUsage_Storage,
    CopySrc = WGPUBufferUsage_CopySrc,
    CopyDst = WGPUBufferUsage_CopyDst,
};

inline WGPUBufferUsageFlags operator|(BufferUsage a, BufferUsage b) {
    return static_cast<WGPUBufferUsageFlags>(a) | static_cast<WGPUBufferUsageFlags>(b);
}

enum class TextureFormat {
    RGBA8Unorm = WGPUTextureFormat_RGBA8Unorm,
    RGBA8UnormSrgb = WGPUTextureFormat_RGBA8UnormSrgb,
    BGRA8Unorm = WGPUTextureFormat_BGRA8Unorm,
    BGRA8UnormSrgb = WGPUTextureFormat_BGRA8UnormSrgb,
    RGB565Unorm = WGPUTextureFormat_Undefined, // Will need conversion
    Depth24Plus = WGPUTextureFormat_Depth24Plus,
    Depth24PlusStencil8 = WGPUTextureFormat_Depth24PlusStencil8,
};

enum class ShaderStage {
    Vertex = WGPUShaderStage_Vertex,
    Fragment = WGPUShaderStage_Fragment,
    Compute = WGPUShaderStage_Compute,
};

enum class PrimitiveTopology {
    TriangleList = WGPUPrimitiveTopology_TriangleList,
    TriangleStrip = WGPUPrimitiveTopology_TriangleStrip,
    LineList = WGPUPrimitiveTopology_LineList,
    LineStrip = WGPUPrimitiveTopology_LineStrip,
    PointList = WGPUPrimitiveTopology_PointList,
};

enum class BlendFactor {
    Zero = WGPUBlendFactor_Zero,
    One = WGPUBlendFactor_One,
    Src = WGPUBlendFactor_Src,
    OneMinusSrc = WGPUBlendFactor_OneMinusSrc,
    SrcAlpha = WGPUBlendFactor_SrcAlpha,
    OneMinusSrcAlpha = WGPUBlendFactor_OneMinusSrcAlpha,
    Dst = WGPUBlendFactor_Dst,
    OneMinusDst = WGPUBlendFactor_OneMinusDst,
    DstAlpha = WGPUBlendFactor_DstAlpha,
    OneMinusDstAlpha = WGPUBlendFactor_OneMinusDstAlpha,
};

// Utility structures
struct Extent3D {
    uint32_t width;
    uint32_t height;
    uint32_t depth = 1;
    
    WGPUExtent3D ToWGPU() const {
        return {width, height, depth};
    }
};

struct Color {
    double r, g, b, a;
    
    WGPUColor ToWGPU() const {
        return {r, g, b, a};
    }
};

struct Viewport {
    float x, y;
    float width, height;
    float minDepth, maxDepth;
};

struct Scissor {
    uint32_t x, y;
    uint32_t width, height;
};

// Error handling
class WebGPUException : public std::runtime_error {
public:
    explicit WebGPUException(const std::string& msg) 
        : std::runtime_error(msg) {}
};

#define WEBGPU_CHECK(condition, message) \
    do { \
        if (!(condition)) { \
            throw WebGPU::WebGPUException(message); \
        } \
    } while(0)

} // namespace WebGPU

#endif // USE_WEBGPU