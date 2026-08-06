#include <webgpu/webgpu_cpp.h>
#include <emscripten/emscripten.h>
#include <iostream>

int main() {
    wgpu::Instance instance{};

    wgpu::RequestAdapterOptions options{};

    // CallbackMode can be default-constructed
    wgpu::CallbackMode mode{};

    instance.RequestAdapter(&options, mode,
        [](wgpu::RequestAdapterStatus status, wgpu::Adapter adapter, const char* message) {
            if (status != wgpu::RequestAdapterStatus::Success) {
                std::cerr << "Failed to get adapter: " << (message ? message : "") << "\n";
                return;
            }

            wgpu::DeviceDescriptor desc{};
            wgpu::CallbackMode mode{}; // must pass again

            adapter.RequestDevice(&desc, mode,
                [](wgpu::RequestDeviceStatus status, wgpu::Device device, const char* message) {
                    if (status != wgpu::RequestDeviceStatus::Success) {
                        std::cerr << "Failed to get device: " << (message ? message : "") << "\n";
                        return;
                    }

                    wgpu::Limits limits{};
                    device.GetLimits(&limits);
                    std::cout << "MaxBindGroups: " << limits.maxBindGroups << "\n";
                }
            );
        }
    );

    emscripten_exit_with_live_runtime(); // keep runtime alive
}
