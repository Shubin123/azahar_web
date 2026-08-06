// webgpu_buffer.h - WebGPU buffer wrapper
#pragma once

#ifdef USE_WEBGPU

// #include "common/webgpu_types.h"
#include "common/webgpu_common.h"
#include <webgpu/webgpu.h>

#include "webgpu_device.h"

struct CallbackData {
    WGPUBuffer buffer;  // <-- NOT WGPUBuffer*
    size_t size;
    std::function<void(const void*, size_t)> callback;
};


namespace WebGPU {

class Buffer {
public:
    Buffer(Device& device, size_t size, WGPUBufferUsageFlags usage, 
           const char* label = nullptr);
    ~Buffer();

    // No copy
    Buffer(const Buffer&) = delete;
    Buffer& operator=(const Buffer&) = delete;

    // Move
    Buffer(Buffer&& other) noexcept;
    Buffer& operator=(Buffer&& other) noexcept;

    // Upload data
    void Write(const void* data, size_t size, size_t offset = 0);
    
    // Map for reading
    void MapAsync(std::function<void(const void*, size_t)> callback);
    
    // Getters
    WGPUBuffer GetHandle() const { return buffer_; }
    size_t GetSize() const { return size_; }
    bool IsValid() const { return buffer_ != nullptr; }

private:
    Device& device_;
    WGPUBuffer buffer_;
    size_t size_;
    WGPUBufferUsageFlags usage_;
    
    static void OnMapCallback(WGPUBufferMapAsyncStatus status, void* userdata);
};

// Convenience typedefs
using VertexBuffer = Buffer;
using IndexBuffer = Buffer;
using UniformBuffer = Buffer;
using StorageBuffer = Buffer;

} // namespace WebGPU

#endif // USE_WEBGPU