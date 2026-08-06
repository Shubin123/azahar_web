// webgpu_buffer.cpp
#ifdef USE_WEBGPU

#define WEBGPU_CHECK(cond, msg) \
    if (!(cond)) { \
        fprintf(stderr, "WebGPU check failed: %s\n", msg); \
        abort(); \
    }


#include "webgpu_buffer.h"
#include "common/logging/log.h"
#include <cstring>


namespace WebGPU {

Buffer::Buffer(Device& device, size_t size, WGPUBufferUsageFlags usage, const char* label)
    : device_(device)
    , buffer_(nullptr)
    , size_(size)
    , usage_(usage) {
    
    WGPUBufferDescriptor desc = {};
    desc.label = label;
    desc.size = size;
    desc.usage = usage;
    desc.mappedAtCreation = false;
    
    buffer_ = wgpuDeviceCreateBuffer(device_.GetHandle(), &desc);
    
    WEBGPU_CHECK(buffer_ != nullptr, "Failed to create buffer");
    
    LOG_DEBUG(Render_WebGPU, "Created buffer '{}' ({} bytes)", 
              label ? label : "unnamed", size);
}

Buffer::~Buffer() {
    if (buffer_) {
        wgpuBufferDestroy(buffer_);
        wgpuBufferRelease(buffer_);
        buffer_ = nullptr;
    }
}

Buffer::Buffer(Buffer&& other) noexcept
    : device_(other.device_)
    , buffer_(other.buffer_)
    , size_(other.size_)
    , usage_(other.usage_) {
    other.buffer_ = nullptr;
    other.size_ = 0;
}

Buffer& Buffer::operator=(Buffer&& other) noexcept {
    if (this != &other) {
        if (buffer_) {
            wgpuBufferDestroy(buffer_);
            wgpuBufferRelease(buffer_);
        }
        
        buffer_ = other.buffer_;
        size_ = other.size_;
        usage_ = other.usage_;
        
        other.buffer_ = nullptr;
        other.size_ = 0;
    }
    return *this;
}

void Buffer::Write(const void* data, size_t size, size_t offset) {
    WEBGPU_CHECK(buffer_ != nullptr, "Buffer is not valid");
    WEBGPU_CHECK(offset + size <= size_, "Write exceeds buffer size");
    
    wgpuQueueWriteBuffer(device_.GetQueue(), buffer_, offset, data, size);
}

void Buffer::MapAsync(std::function<void(const void*, size_t)> callback) {
    WEBGPU_CHECK(buffer_ != nullptr, "Buffer is not valid");
    WEBGPU_CHECK(usage_ & WGPUBufferUsage_MapRead, "Buffer not created with MapRead usage");
    
    struct CallbackData {
        Buffer* buffer;
        std::function<void(const void*, size_t)> callback;
    };
    
    auto* data = new CallbackData{this, std::move(callback)};
    
    wgpuBufferMapAsync(
        buffer_,
        WGPUMapMode_Read,
        0,
        size_,
        OnMapCallback,
        data
    );
}

void Buffer::OnMapCallback(WGPUBufferMapAsyncStatus status, void* userdata) {
    auto* data = static_cast<CallbackData*>(userdata);

    if (status == WGPUBufferMapAsyncStatus_Success) {
        const void* mapped_data = wgpuBufferGetConstMappedRange(data->buffer, 0, data->size);
        wgpuBufferUnmap(data->buffer);
        if (mapped_data && data->callback) {
            data->callback(mapped_data, data->size);
        }

        wgpuBufferUnmap(data->buffer);
    } else {
        LOG_ERROR(Render_WebGPU, "Buffer map failed with status {}", static_cast<int>(status));
    }

    delete data;
}


} // namespace WebGPU

#endif // USE_WEBGPU