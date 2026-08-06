// webgpu_device.h - WebGPU device management
#pragma once

#ifdef USE_WEBGPU

// #include "common/webgpu_types.h"
#include "common/webgpu_common.h"
#include <webgpu/webgpu.h>

#include <memory>
#include <string>

namespace WebGPU {

class Device {
public:
    Device();
    ~Device();

    // No copy
    Device(const Device&) = delete;
    Device& operator=(const Device&) = delete;

    // Initialize the device
    bool Initialize();
    void Shutdown();

    // Device properties
    bool IsValid() const { return device_ != nullptr; }
    WGPUDevice GetHandle() const { return device_; }
    WGPUQueue GetQueue() const { return queue_; }
    
    // Limits
    struct Limits {
        uint32_t maxTextureDimension2D;
        uint32_t maxTextureDimension3D;
        uint32_t maxBindGroups;
        uint32_t maxDynamicUniformBuffersPerPipelineLayout;
        uint64_t maxBufferSize;
        uint64_t maxStorageBufferBindingSize;
        uint32_t maxComputeWorkgroupSizeX;
        uint32_t maxComputeWorkgroupSizeY;
        uint32_t maxComputeWorkgroupSizeZ;
    };
    
    const Limits& GetLimits() const { return limits_; }
    
    // Error handling
    void SetUncapturedErrorCallback(std::function<void(const char*)> callback);
    
    // Features
    bool SupportsFeature(WGPUFeatureName feature) const;

private:
    WGPUInstance instance_;
    WGPUAdapter adapter_;
    WGPUDevice device_;
    WGPUQueue queue_;
    Limits limits_;
    
    std::function<void(const char*)> error_callback_;
    
    static void OnDeviceError(WGPUErrorType type, const char* message, void* userdata);
    static void OnDeviceLost(WGPUDeviceLostReason reason, const char* message, void* userdata);
    static void OnAdapterRequest(WGPURequestAdapterStatus status, WGPUAdapter adapter, 
                                 const char* message, void* userdata);
    static void OnDeviceRequest(WGPURequestDeviceStatus status, WGPUDevice device, 
                                const char* message, void* userdata);
};

} // namespace WebGPU

#endif // USE_WEBGPU