// webgpu_device.cpp
#ifdef USE_WEBGPU

#include "webgpu_device.h"
#include "common/logging/log.h"
#include <cstring>

#ifdef __EMSCRIPTEN__
#include <emscripten/html5_webgpu.h>
#endif


namespace WebGPU {

Device::Device() 
    : instance_(nullptr)
    , adapter_(nullptr)
    , device_(nullptr)
    , queue_(nullptr) {
}

Device::~Device() {
    Shutdown();
}

bool Device::Initialize() {
    LOG_INFO(Render_WebGPU, "Initializing WebGPU device...");

#ifdef __EMSCRIPTEN__
    // Emscripten path - simpler
    device_ = emscripten_webgpu_get_device();
    if (!device_) {
        LOG_ERROR(Render_WebGPU, "Failed to get WebGPU device from Emscripten");
        return false;
    }
    
    queue_ = wgpuDeviceGetQueue(device_);
    
#else
    // Native/Dawn path
    WGPUInstanceDescriptor instance_desc = {};
    instance_ = wgpuCreateInstance(&instance_desc);
    if (!instance_) {
        LOG_ERROR(Render_WebGPU, "Failed to create WebGPU instance");
        return false;
    }

    // Request adapter
    WGPURequestAdapterOptions adapter_options = {};
    adapter_options.powerPreference = WGPUPowerPreference_HighPerformance;
    
    struct UserData {
        WGPUAdapter adapter;
        bool done;
    } adapter_userdata = {nullptr, false};
    
    wgpuInstanceRequestAdapter(
        instance_,
        &adapter_options,
        [](WGPURequestAdapterStatus status, WGPUAdapter adapter, 
           const char* message, void* userdata) {
            auto* data = static_cast<UserData*>(userdata);
            if (status == WGPURequestAdapterStatus_Success) {
                data->adapter = adapter;
            } else {
                LOG_ERROR(Render_WebGPU, "Adapter request failed: {}", 
                         message ? message : "Unknown error");
            }
            data->done = true;
        },
        &adapter_userdata
    );
    
    // Wait for adapter (in real implementation, this would be async)
    while (!adapter_userdata.done) {
        // Process events
    }
    
    adapter_ = adapter_userdata.adapter;
    if (!adapter_) {
        LOG_ERROR(Render_WebGPU, "Failed to obtain WebGPU adapter");
        return false;
    }

    // Request device
    WGPUDeviceDescriptor device_desc = {};
    device_desc.label = "Azahar WebGPU Device";
    
    // Request required features
    WGPUFeatureName required_features[] = {
        WGPUFeatureName_Depth32FloatStencil8,
        WGPUFeatureName_TextureCompressionBC,
    };
    device_desc.requiredFeaturesCount = sizeof(required_features) / sizeof(WGPUFeatureName);
    device_desc.requiredFeatures = required_features;
    
    // Set limits
    WGPURequiredLimits required_limits = {};
    required_limits.limits.maxTextureDimension2D = 8192;
    required_limits.limits.maxStorageBufferBindingSize = 256 * 1024 * 1024; // 256MB
    required_limits.limits.maxBufferSize = 256 * 1024 * 1024;
    device_desc.requiredLimits = &required_limits;
    
    struct DeviceUserData {
        WGPUDevice device;
        bool done;
    } device_userdata = {nullptr, false};
    
    wgpuAdapterRequestDevice(
        adapter_,
        &device_desc,
        [](WGPURequestDeviceStatus status, WGPUDevice device,
           const char* message, void* userdata) {
            auto* data = static_cast<DeviceUserData*>(userdata);
            if (status == WGPURequestDeviceStatus_Success) {
                data->device = device;
            } else {
                LOG_ERROR(Render_WebGPU, "Device request failed: {}", 
                         message ? message : "Unknown error");
            }
            data->done = true;
        },
        &device_userdata
    );
    
    while (!device_userdata.done) {
        // Process events
    }
    
    device_ = device_userdata.device;
    if (!device_) {
        LOG_ERROR(Render_WebGPU, "Failed to obtain WebGPU device");
        return false;
    }

    queue_ = wgpuDeviceGetQueue(device_);
#endif

    // Set error callbacks
    wgpuDeviceSetUncapturedErrorCallback(device_, OnDeviceError, this);
    wgpuDeviceSetDeviceLostCallback(device_, OnDeviceLost, this);

    // Query limits
    WGPUSupportedLimits supported_limits;
    if (wgpuDeviceGetLimits(device_, &supported_limits)) {
        limits_.maxTextureDimension2D = supported_limits.limits.maxTextureDimension2D;
        limits_.maxTextureDimension3D = supported_limits.limits.maxTextureDimension3D;
        limits_.maxBindGroups = supported_limits.limits.maxBindGroups;
        // limits_.maxBufferSize = supported_limits.limits.maxBufferSize;
        limits_.maxStorageBufferBindingSize = supported_limits.limits.maxStorageBufferBindingSize;
        limits_.maxComputeWorkgroupSizeX = supported_limits.limits.maxComputeWorkgroupSizeX;
        limits_.maxComputeWorkgroupSizeY = supported_limits.limits.maxComputeWorkgroupSizeY;
        limits_.maxComputeWorkgroupSizeZ = supported_limits.limits.maxComputeWorkgroupSizeZ;
        
        LOG_INFO(Render_WebGPU, "Device limits:");
        LOG_INFO(Render_WebGPU, "  Max 2D texture size: {}", limits_.maxTextureDimension2D);
        LOG_INFO(Render_WebGPU, "  Max storage buffer size: {} MB", 
                 limits_.maxStorageBufferBindingSize / (1024 * 1024));
        LOG_INFO(Render_WebGPU, "  Max compute workgroup size: {}x{}x{}", 
                 limits_.maxComputeWorkgroupSizeX,
                 limits_.maxComputeWorkgroupSizeY,
                 limits_.maxComputeWorkgroupSizeZ);
    }

    LOG_INFO(Render_WebGPU, "WebGPU device initialized successfully");
    return true;
}

void Device::Shutdown() {
    if (queue_) {
        wgpuQueueRelease(queue_);
        queue_ = nullptr;
    }
    
    if (device_) {
        wgpuDeviceRelease(device_);
        device_ = nullptr;
    }
    
    if (adapter_) {
        wgpuAdapterRelease(adapter_);
        adapter_ = nullptr;
    }
    
    if (instance_) {
        wgpuInstanceRelease(instance_);
        instance_ = nullptr;
    }
    
    LOG_INFO(Render_WebGPU, "WebGPU device shut down");
}

void Device::SetUncapturedErrorCallback(std::function<void(const char*)> callback) {
    error_callback_ = std::move(callback);
}

bool Device::SupportsFeature(WGPUFeatureName feature) const {
    if (!adapter_) return false;
    
    // size_t feature_count = wgpuAdapterEnumerateFeatures(adapter_, nullptr);
    // std::vector<WGPUFeatureName> features(feature_count);
    // wgpuAdapterEnumerateFeatures(adapter_, features.data());
    
    // for (const auto& f : features) {
    //     if (f == feature) return true;
    // }
    return wgpuAdapterHasFeature(adapter_, feature);
}


void Device::OnDeviceError(WGPUErrorType type, const char* message, void* userdata) {
    auto* device = static_cast<Device*>(userdata);
    
    const char* type_str = "Unknown";
    switch (type) {
        case WGPUErrorType_Validation: type_str = "Validation"; break;
        case WGPUErrorType_OutOfMemory: type_str = "Out of Memory"; break;
        // case WGPUErrorType_Internal: type_str = "Internal"; break;
        case WGPUErrorType_Unknown: type_str = "Unknown"; break;
        default: break;
    }
    
    LOG_ERROR(Render_WebGPU, "WebGPU Error [{}]: {}", type_str, message);
    
    if (device->error_callback_) {
        device->error_callback_(message);
    }
}

void Device::OnDeviceLost(WGPUDeviceLostReason reason, const char* message, void* userdata) {
    const char* reason_str = "Unknown";
    switch (reason) {
        case WGPUDeviceLostReason_Destroyed: reason_str = "Destroyed"; break;
        default: break;
    }
    
    LOG_CRITICAL(Render_WebGPU, "WebGPU Device Lost [{}]: {}", reason_str, message);
}

} // namespace WebGPU

#endif // USE_WEBGPU