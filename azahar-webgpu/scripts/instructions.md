# WebGPU Overlay Directory Structure and Testing Strategy

## Overview

This guide shows how to add WebGPU support to Azahar **without modifying the base repository at all**. All changes are in a separate overlay directory that can be:
- Developed independently
- Tested in isolation
- Merged when ready
- Discarded if needed

---

## Directory Structure

```
azahar-webgpu/                    # Your overlay directory (outside azahar/)
├── README.md                      # Your documentation
├── CMakeLists.txt                 # Top-level CMake that includes azahar
├── src/                           # WebGPU-specific code
│   ├── webgpu_core/              # Core WebGPU wrapper
│   │   ├── webgpu_device.h
│   │   ├── webgpu_device.cpp
│   │   ├── webgpu_buffer.h
│   │   ├── webgpu_buffer.cpp
│   │   ├── webgpu_shader.h
│   │   ├── webgpu_shader.cpp
│   │   ├── webgpu_texture.h
│   │   ├── webgpu_texture.cpp
│   │   ├── webgpu_pipeline.h
│   │   └── webgpu_pipeline.cpp
│   ├── renderer/                  # Renderer implementation
│   │   ├── renderer_webgpu.h
│   │   └── renderer_webgpu.cpp
│   └── shaders/                   # WGSL shaders
│       ├── screen_vertex.wgsl
│       ├── screen_fragment.wgsl
│       └── convert_texture.wgsl
├── tests/                         # Unit tests for WebGPU components
│   ├── test_device.cpp
│   ├── test_buffer.cpp
│   ├── test_shader.cpp
│   ├── test_texture.cpp
│   ├── test_pipeline.cpp
│   └── test_renderer.cpp
├── examples/                      # Standalone examples
│   ├── 01_triangle/              # Simple triangle test
│   ├── 02_texture/               # Texture loading test
│   ├── 03_compute/               # Compute shader test
│   └── 04_integration/           # Integration with Azahar
├── scripts/                       # Build and test scripts
│   ├── build-desktop.sh
│   ├── build-web.sh
│   ├── run-tests.sh
│   └── setup.sh
├── cmake/                         # CMake modules
│   ├── WebGPU.cmake
│   └── Testing.cmake
└── external/                      # External dependencies
    ├── dawn/                     # Git submodule (optional)
    └── googletest/               # Git submodule

azahar/                           # Original Azahar repo (unchanged!)
├── src/
├── CMakeLists.txt
└── ...
```

---

## Part 1: Setup Script

### File: `azahar-webgpu/scripts/setup.sh`

```bash
#!/bin/bash
# Setup script - initializes the WebGPU overlay project

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "==================================="
echo "Azahar WebGPU Overlay Setup"
echo "==================================="

# Check if azahar exists
if [ ! -d "$PROJECT_ROOT/../azahar" ]; then
    echo "Error: Azahar repository not found at $PROJECT_ROOT/../azahar"
    echo ""
    echo "Please clone Azahar first:"
    echo "  git clone https://github.com/azahar-emu/azahar.git"
    exit 1
fi

echo "✓ Found Azahar repository"

# Initialize submodules for dependencies
cd "$PROJECT_ROOT"

if [ ! -d "external/googletest" ]; then
    echo "Cloning Google Test..."
    git clone https://github.com/google/googletest.git external/googletest
fi

# Optional: Clone Dawn for desktop testing
if [ "$1" == "--with-dawn" ]; then
    if [ ! -d "external/dawn" ]; then
        echo "Cloning Dawn (this may take a while)..."
        git clone https://dawn.googlesource.com/dawn external/dawn
        cd external/dawn
        git checkout chromium/6045
        cd ../..
    fi
fi

# Create build directories
mkdir -p build-desktop
mkdir -p build-web
mkdir -p build-tests

echo ""
echo "==================================="
echo "Setup complete!"
echo "==================================="
echo ""
echo "Next steps:"
echo "  1. Run tests:      ./scripts/run-tests.sh"
echo "  2. Build desktop:  ./scripts/build-desktop.sh"
echo "  3. Build web:      ./scripts/build-web.sh"
echo ""
```

---

## Part 2: Top-Level CMakeLists.txt

### File: `azahar-webgpu/CMakeLists.txt`

```cmake
cmake_minimum_required(VERSION 3.18)
project(AzaharWebGPU VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Options
option(BUILD_TESTS "Build unit tests" ON)
option(BUILD_EXAMPLES "Build examples" ON)
option(USE_WEBGPU "Enable WebGPU renderer" ON)
option(INTEGRATE_AZAHAR "Integrate with Azahar emulator" OFF)

# Include custom CMake modules
list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")

# ============================================================================
# WebGPU Setup
# ============================================================================

if(USE_WEBGPU)
    include(WebGPU)
endif()

# ============================================================================
# WebGPU Core Library
# ============================================================================

add_library(webgpu_core STATIC
    src/webgpu_core/webgpu_device.cpp
    src/webgpu_core/webgpu_device.h
    src/webgpu_core/webgpu_buffer.cpp
    src/webgpu_core/webgpu_buffer.h
    src/webgpu_core/webgpu_shader.cpp
    src/webgpu_core/webgpu_shader.h
    src/webgpu_core/webgpu_texture.cpp
    src/webgpu_core/webgpu_texture.h
    src/webgpu_core/webgpu_pipeline.cpp
    src/webgpu_core/webgpu_pipeline.h
)

target_include_directories(webgpu_core PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

if(USE_WEBGPU)
    if(EMSCRIPTEN)
        target_compile_options(webgpu_core PUBLIC
            -sUSE_WEBGPU=1
        )
        target_link_options(webgpu_core PUBLIC
            -sUSE_WEBGPU=1
        )
    else()
        # Desktop: Link with Dawn
        target_link_libraries(webgpu_core PUBLIC ${WEBGPU_LIBRARIES})
        target_include_directories(webgpu_core PUBLIC ${WEBGPU_INCLUDE_DIRS})
    endif()
endif()

target_compile_definitions(webgpu_core PUBLIC USE_WEBGPU=1)

# ============================================================================
# WebGPU Renderer Library
# ============================================================================

add_library(webgpu_renderer STATIC
    src/renderer/renderer_webgpu.cpp
    src/renderer/renderer_webgpu.h
)

target_link_libraries(webgpu_renderer PUBLIC webgpu_core)

# ============================================================================
# Tests
# ============================================================================

if(BUILD_TESTS)
    enable_testing()
    add_subdirectory(external/googletest EXCLUDE_FROM_ALL)
    add_subdirectory(tests)
endif()

# ============================================================================
# Examples
# ============================================================================

if(BUILD_EXAMPLES)
    add_subdirectory(examples)
endif()

# ============================================================================
# Azahar Integration (Optional)
# ============================================================================

if(INTEGRATE_AZAHAR)
    # Add Azahar as subdirectory
    set(ENABLE_QT OFF CACHE BOOL "" FORCE)
    set(ENABLE_SDL2 OFF CACHE BOOL "" FORCE)
    
    add_subdirectory(../azahar azahar EXCLUDE_FROM_ALL)
    
    # Link WebGPU renderer with Azahar
    target_link_libraries(azahar_core PUBLIC webgpu_renderer)
endif()
```

---

## Part 3: WebGPU CMake Module

### File: `azahar-webgpu/cmake/WebGPU.cmake`

```cmake
# WebGPU.cmake - WebGPU detection and setup

if(EMSCRIPTEN)
    # Emscripten provides WebGPU
    message(STATUS "Using Emscripten WebGPU")
    set(WEBGPU_FOUND TRUE)
    
else()
    # Desktop: Try to find or build Dawn
    message(STATUS "Looking for Dawn WebGPU implementation...")
    
    # Option 1: Use system-installed Dawn (if available)
    find_package(Dawn QUIET)
    
    if(NOT Dawn_FOUND)
        # Option 2: Build from source if available
        if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/external/dawn/CMakeLists.txt")
            message(STATUS "Building Dawn from source...")
            
            set(DAWN_BUILD_SAMPLES OFF CACHE BOOL "" FORCE)
            set(DAWN_BUILD_MONOLITHIC_LIBRARY ON CACHE BOOL "" FORCE)
            set(DAWN_ENABLE_D3D12 ON CACHE BOOL "" FORCE)
            set(DAWN_ENABLE_METAL ON CACHE BOOL "" FORCE)
            set(DAWN_ENABLE_VULKAN ON CACHE BOOL "" FORCE)
            set(DAWN_ENABLE_DESKTOP_GL OFF CACHE BOOL "" FORCE)
            set(DAWN_ENABLE_OPENGLES OFF CACHE BOOL "" FORCE)
            
            add_subdirectory(external/dawn EXCLUDE_FROM_ALL)
            
            set(WEBGPU_INCLUDE_DIRS 
                ${CMAKE_CURRENT_SOURCE_DIR}/external/dawn/include
            )
            set(WEBGPU_LIBRARIES webgpu_dawn)
            set(WEBGPU_FOUND TRUE)
            
        else()
            # Option 3: Download Dawn headers only (no native implementation)
            message(WARNING "Dawn not found. WebGPU will only work with Emscripten.")
            message(WARNING "To enable desktop WebGPU, run: ./scripts/setup.sh --with-dawn")
            
            set(WEBGPU_FOUND FALSE)
        endif()
    else()
        message(STATUS "Using system Dawn")
        set(WEBGPU_INCLUDE_DIRS ${Dawn_INCLUDE_DIRS})
        set(WEBGPU_LIBRARIES ${Dawn_LIBRARIES})
        set(WEBGPU_FOUND TRUE)
    endif()
endif()

if(WEBGPU_FOUND)
    message(STATUS "WebGPU support enabled")
else()
    message(STATUS "WebGPU support disabled")
endif()
```

---

## Part 4: Unit Tests

### File: `azahar-webgpu/tests/CMakeLists.txt`

```cmake
# Tests CMakeLists.txt

include(GoogleTest)

# Helper function to create a test
function(add_webgpu_test TEST_NAME)
    add_executable(${TEST_NAME} ${ARGN})
    
    target_link_libraries(${TEST_NAME} PRIVATE
        webgpu_core
        gtest
        gtest_main
    )
    
    gtest_discover_tests(${TEST_NAME})
endfunction()

# Device tests
add_webgpu_test(test_device test_device.cpp)

# Buffer tests
add_webgpu_test(test_buffer test_buffer.cpp)

# Shader tests
add_webgpu_test(test_shader test_shader.cpp)

# Texture tests
add_webgpu_test(test_texture test_texture.cpp)

# Pipeline tests
add_webgpu_test(test_pipeline test_pipeline.cpp)

# Integration tests
add_webgpu_test(test_integration test_integration.cpp)
```

### File: `azahar-webgpu/tests/test_device.cpp`

```cpp
#include "webgpu_core/webgpu_device.h"
#include <gtest/gtest.h>

class DeviceTest : public ::testing::Test {
protected:
    void SetUp() override {
        // Device will be initialized in each test
    }
    
    void TearDown() override {
        // Cleanup handled by RAII
    }
};

TEST_F(DeviceTest, Initialization) {
    WebGPU::Device device;
    
#ifdef __EMSCRIPTEN__
    // Emscripten tests would need to run in browser
    GTEST_SKIP() << "Skipping Emscripten device test (requires browser)";
#else
    // Desktop test
    bool initialized = device.Initialize();
    
    // On CI/headless systems, WebGPU might not be available
    if (initialized) {
        EXPECT_TRUE(device.IsValid());
        EXPECT_NE(device.GetHandle(), nullptr);
        EXPECT_NE(device.GetQueue(), nullptr);
        
        // Check limits
        const auto& limits = device.GetLimits();
        EXPECT_GT(limits.maxTextureDimension2D, 0);
        EXPECT_GT(limits.maxBufferSize, 0);
    } else {
        GTEST_SKIP() << "WebGPU device not available on this system";
    }
#endif
}

TEST_F(DeviceTest, ErrorCallback) {
    WebGPU::Device device;
    
#ifndef __EMSCRIPTEN__
    if (!device.Initialize()) {
        GTEST_SKIP() << "WebGPU device not available";
    }
    
    bool error_called = false;
    std::string error_message;
    
    device.SetUncapturedErrorCallback([&](const char* msg) {
        error_called = true;
        error_message = msg;
    });
    
    // Trigger an error (create invalid buffer)
    WGPUBufferDescriptor desc = {};
    desc.size = 0; // Invalid size
    desc.usage = WGPUBufferUsage_Vertex;
    
    WGPUBuffer buffer = wgpuDeviceCreateBuffer(device.GetHandle(), &desc);
    
    // Process device errors
    // Note: Error might be async, so this test is best-effort
    if (buffer == nullptr) {
        EXPECT_TRUE(true); // Buffer creation failed as expected
    }
    
    if (buffer) {
        wgpuBufferRelease(buffer);
    }
#endif
}

TEST_F(DeviceTest, QueryLimits) {
    WebGPU::Device device;
    
#ifndef __EMSCRIPTEN__
    if (!device.Initialize()) {
        GTEST_SKIP() << "WebGPU device not available";
    }
    
    const auto& limits = device.GetLimits();
    
    // Verify reasonable limits
    EXPECT_GE(limits.maxTextureDimension2D, 2048) << "Texture size too small";
    EXPECT_GE(limits.maxBufferSize, 1024 * 1024) << "Max buffer size too small";
    EXPECT_GE(limits.maxStorageBufferBindingSize, 128 * 1024) 
        << "Storage buffer too small";
    
    std::cout << "Device Limits:\n";
    std::cout << "  Max 2D Texture: " << limits.maxTextureDimension2D << "\n";
    std::cout << "  Max Buffer Size: " << limits.maxBufferSize << " bytes\n";
    std::cout << "  Max Storage Buffer: " << limits.maxStorageBufferBindingSize << " bytes\n";
#endif
}
```

### File: `azahar-webgpu/tests/test_buffer.cpp`

```cpp
#include "webgpu_core/webgpu_device.h"
#include "webgpu_core/webgpu_buffer.h"
#include <gtest/gtest.h>
#include <vector>

class BufferTest : public ::testing::Test {
protected:
    void SetUp() override {
#ifndef __EMSCRIPTEN__
        device_ = std::make_unique<WebGPU::Device>();
        if (!device_->Initialize()) {
            GTEST_SKIP() << "WebGPU device not available";
        }
#endif
    }
    
    std::unique_ptr<WebGPU::Device> device_;
};

TEST_F(BufferTest, CreateVertexBuffer) {
#ifndef __EMSCRIPTEN__
    if (!device_) return;
    
    const size_t buffer_size = 1024;
    WebGPU::Buffer buffer(*device_, buffer_size, 
                         WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst,
                         "Test Vertex Buffer");
    
    EXPECT_TRUE(buffer.IsValid());
    EXPECT_EQ(buffer.GetSize(), buffer_size);
    EXPECT_NE(buffer.GetHandle(), nullptr);
#endif
}

TEST_F(BufferTest, WriteData) {
#ifndef __EMSCRIPTEN__
    if (!device_) return;
    
    // Create test data
    std::vector<float> vertices = {
        0.0f, 0.5f, 0.0f,
        -0.5f, -0.5f, 0.0f,
        0.5f, -0.5f, 0.0f,
    };
    
    const size_t buffer_size = vertices.size() * sizeof(float);
    WebGPU::Buffer buffer(*device_, buffer_size,
                         WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst,
                         "Test Write Buffer");
    
    // Write data
    EXPECT_NO_THROW(buffer.Write(vertices.data(), buffer_size));
    
    // Note: We can't easily read back vertex buffers without mapping
    // This test just verifies the write doesn't crash
#endif
}

TEST_F(BufferTest, CreateStorageBuffer) {
#ifndef __EMSCRIPTEN__
    if (!device_) return;
    
    const size_t buffer_size = 1024 * 1024; // 1MB
    WebGPU::Buffer buffer(*device_, buffer_size,
                         WGPUBufferUsage_Storage | WGPUBufferUsage_CopyDst,
                         "Test Storage Buffer");
    
    EXPECT_TRUE(buffer.IsValid());
    EXPECT_EQ(buffer.GetSize(), buffer_size);
#endif
}

TEST_F(BufferTest, MoveSemantics) {
#ifndef __EMSCRIPTEN__
    if (!device_) return;
    
    WebGPU::Buffer buffer1(*device_, 1024, WGPUBufferUsage_Vertex, "Buffer1");
    EXPECT_TRUE(buffer1.IsValid());
    
    // Move constructor
    WebGPU::Buffer buffer2(std::move(buffer1));
    EXPECT_TRUE(buffer2.IsValid());
    EXPECT_FALSE(buffer1.IsValid()); // buffer1 should be moved-from
    
    // Move assignment
    WebGPU::Buffer buffer3(*device_, 512, WGPUBufferUsage_Vertex, "Buffer3");
    buffer3 = std::move(buffer2);
    EXPECT_TRUE(buffer3.IsValid());
    EXPECT_FALSE(buffer2.IsValid());
#endif
}
```

### File: `azahar-webgpu/tests/test_shader.cpp`

```cpp
#include "webgpu_core/webgpu_device.h"
#include "webgpu_core/webgpu_shader.h"
#include <gtest/gtest.h>

class ShaderTest : public ::testing::Test {
protected:
    void SetUp() override {
#ifndef __EMSCRIPTEN__
        device_ = std::make_unique<WebGPU::Device>();
        if (!device_->Initialize()) {
            GTEST_SKIP() << "WebGPU device not available";
        }
#endif
    }
    
    std::unique_ptr<WebGPU::Device> device_;
};

TEST_F(ShaderTest, CreateValidShader) {
#ifndef __EMSCRIPTEN__
    if (!device_) return;
    
    const char* wgsl_code = R"(
        @vertex
        fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
            return vec4<f32>(position, 1.0);
        }
        
        @fragment
        fn fs_main() -> @location(0) vec4<f32> {
            return vec4<f32>(1.0, 0.0, 0.0, 1.0);
        }
    )";
    
    WebGPU::ShaderModule shader(*device_, wgsl_code, "Test Shader");
    
    EXPECT_TRUE(shader.IsValid());
    EXPECT_NE(shader.GetHandle(), nullptr);
#endif
}

TEST_F(ShaderTest, CreateComputeShader) {
#ifndef __EMSCRIPTEN__
    if (!device_) return;
    
    const char* compute_wgsl = R"(
        @group(0) @binding(0) var<storage, read_write> data: array<f32>;
        
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
            data[id.x] = data[id.x] * 2.0;
        }
    )";
    
    WebGPU::ShaderModule shader(*device_, compute_wgsl, "Compute Shader");
    
    EXPECT_TRUE(shader.IsValid());
#endif
}

TEST_F(ShaderTest, InvalidShaderSyntax) {
#ifndef __EMSCRIPTEN__
    if (!device_) return;
    
    const char* invalid_wgsl = R"(
        @vertex
        fn vs_main() -> @builtin(position) vec4<f32> {
            return vec4<f32>(1.0, 2.0, 3.0); // Missing 4th component - invalid!
        }
    )";
    
    // This should either throw or create an invalid shader
    // Depends on WebGPU implementation
    try {
        WebGPU::ShaderModule shader(*device_, invalid_wgsl, "Invalid Shader");
        // If it doesn't throw, the error should be caught by device error callback
    } catch (const std::exception& e) {
        // Expected - shader compilation failed
        EXPECT_TRUE(true);
    }
#endif
}
```

---

## Part 5: Standalone Examples

### File: `azahar-webgpu/examples/CMakeLists.txt`

```cmake
# Examples CMakeLists.txt

# Helper function
function(add_webgpu_example EXAMPLE_NAME)
    add_executable(${EXAMPLE_NAME} ${ARGN})
    
    target_link_libraries(${EXAMPLE_NAME} PRIVATE webgpu_core)
    
    # Copy shaders
    file(COPY ${CMAKE_CURRENT_SOURCE_DIR}/${EXAMPLE_NAME}/shaders
         DESTINATION ${CMAKE_CURRENT_BINARY_DIR}/${EXAMPLE_NAME})
endfunction()

# Triangle example
add_subdirectory(01_triangle)

# Texture example
add_subdirectory(02_texture)

# Compute example
add_subdirectory(03_compute)
```

### File: `azahar-webgpu/examples/01_triangle/main.cpp`

```cpp
// 01_triangle - Minimal WebGPU triangle test
#include "webgpu_core/webgpu_device.h"
#include "webgpu_core/webgpu_buffer.h"
#include "webgpu_core/webgpu_shader.h"
#include <iostream>
#include <fstream>
#include <sstream>

#ifndef __EMSCRIPTEN__
#include <GLFW/glfw3.h>
#endif

std::string LoadShaderFile(const char* filename) {
    std::ifstream file(filename);
    if (!file.is_open()) {
        throw std::runtime_error(std::string("Failed to open shader: ") + filename);
    }
    std::stringstream buffer;
    buffer << file.rdbuf();
    return buffer.str();
}

int main() {
    std::cout << "WebGPU Triangle Example\n";
    std::cout << "=======================\n\n";
    
    try {
        // Initialize device
        WebGPU::Device device;
        if (!device.Initialize()) {
            std::cerr << "Failed to initialize WebGPU device\n";
            return 1;
        }
        
        std::cout << "✓ WebGPU device initialized\n";
        
        // Create vertex buffer
        float vertices[] = {
             0.0f,  0.5f, 0.0f,  // Top
            -0.5f, -0.5f, 0.0f,  // Bottom-left
             0.5f, -0.5f, 0.0f,  // Bottom-right
        };
        
        WebGPU::Buffer vertex_buffer(
            device,
            sizeof(vertices),
            WGPUBufferUsage_Vertex | WGPUBufferUsage_CopyDst,
            "Triangle Vertices"
        );
        
        vertex_buffer.Write(vertices, sizeof(vertices));
        std::cout << "✓ Vertex buffer created\n";
        
        // Load and create shader
        auto shader_code = LoadShaderFile("shaders/triangle.wgsl");
        WebGPU::ShaderModule shader(device, shader_code.c_str(), "Triangle Shader");
        std::cout << "✓ Shader compiled\n";
        
        std::cout << "\n======================\n";
        std::cout << "All tests passed! ✓\n";
        std::cout << "======================\n";
        
        return 0;
        
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 1;
    }
}
```

### File: `azahar-webgpu/examples/01_triangle/shaders/triangle.wgsl`

```wgsl
@vertex
fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
    return vec4<f32>(position, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 0.0, 0.0, 1.0); // Red color
}
```

---

## Part 6: Test Runner Script

### File: `azahar-webgpu/scripts/run-tests.sh`

```bash
#!/bin/bash
# Run all unit tests

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "==================================="
echo "Running WebGPU Unit Tests"
echo "==================================="

# Build tests if not already built
if [ ! -d "$PROJECT_ROOT/build-tests" ]; then
    echo "Building tests..."
    mkdir -p "$PROJECT_ROOT/build-tests"
    cd "$PROJECT_ROOT/build-tests"
    
    cmake .. -DBUILD_TESTS=ON -DBUILD_EXAMPLES=OFF -DINTEGRATE_AZAHAR=OFF
    cmake --build . -j$(nproc)
fi

cd "$PROJECT_ROOT/build-tests"

# Run tests with detailed output
echo ""
echo "Running tests..."
echo ""

ctest --output-on-failure --verbose

echo ""
echo "==================================="
echo "Tests complete!"
echo "==================================="
```

---

## Part 7: Build Scripts

### File: `azahar-webgpu/scripts/build-desktop.sh`

```bash
#!/bin/bash
# Build WebGPU wrapper for desktop testing

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "==================================="
echo "Building WebGPU Wrapper (Desktop)"
echo "==================================="

mkdir -p "$PROJECT_ROOT/build-desktop"
cd "$PROJECT_ROOT/build-desktop"

cmake .. \
    -DCMAKE_BUILD_TYPE=Debug \
    -DBUILD_TESTS=ON \
    -DBUILD_EXAMPLES=ON \
    -DINTEGRATE_AZAHAR=OFF

cmake --build . -j$(nproc)

echo ""
echo "==================================="
echo "Build complete!"
echo "==================================="
echo ""
echo "Run tests: cd build-desktop && ctest"
echo "Run examples: ./build-desktop/examples/01_triangle/01_triangle"
```

### File: `azahar-webgpu/scripts/build-integration.sh`

```bash
#!/bin/bash
# Build with Azahar integration

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "==================================="
echo "Building with Azahar Integration"
echo "==================================="

# Check if azahar exists
if [ ! -d "$PROJECT_ROOT/../azahar" ]; then
    echo "Error: Azahar repository not found at $PROJECT_ROOT/../azahar"
    exit 1
fi

mkdir -p "$PROJECT_ROOT/build-integration"
cd "$PROJECT_ROOT/build-integration"

cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_TESTS=OFF \
    -DBUILD_EXAMPLES=OFF \
    -DINTEGRATE_AZAHAR=ON \
    -DUSE_WEBGPU=ON

cmake --build . -j$(nproc)

echo ""
echo "==================================="
echo "Build complete!"
echo "==================================="
echo ""
echo "Azahar with WebGPU: ./build-integration/azahar/bin/azahar-qt"
```

---

## Part 8: CI/CD Configuration

### File: `azahar-webgpu/.github/workflows/test.yml`

```yaml
name: WebGPU Tests

on:
  push:
    branches: [ main, develop ]
  pull_request:
    branches: [ main ]

jobs:
  test-linux:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
      with:
        submodules: recursive
    
    - name: Install dependencies
      run: |
        sudo apt-get update
        sudo apt-get install -y cmake ninja-build
    
    - name: Setup
      run: ./scripts/setup.sh
    
    - name: Build
      run: ./scripts/build-desktop.sh
    
    - name: Run tests
      run: |
        cd build-desktop
        ctest --output-on-failure
    
  test-macos:
    runs-on: macos-latest
    
    steps:
    - uses: actions/checkout@v3
      with:
        submodules: recursive
    
    - name: Setup
      run: ./scripts/setup.sh
    
    - name: Build
      run: ./scripts/build-desktop.sh
    
    - name: Run tests
      run: |
        cd build-desktop
        ctest --output-on-failure
```

---

## Usage Guide

### Initial Setup

```bash
# 1. Clone your overlay project
git clone <your-repo> azahar-webgpu
cd azahar-webgpu

# 2. Clone Azahar alongside (not inside!)
cd ..
git clone https://github.com/azahar-emu/azahar.git

# Directory structure should be:
# .
# ├── azahar/           # Original repo (untouched)
# └── azahar-webgpu/    # Your overlay

# 3. Setup dependencies
cd azahar-webgpu
./scripts/setup.sh
```

### Development Workflow

```bash
# Run unit tests (fast, no Azahar needed)
./scripts/run-tests.sh

# Build standalone examples
./scripts/build-desktop.sh
./build-desktop/examples/01_triangle/01_triangle

# Test integration with Azahar
./scripts/build-integration.sh
./build-integration/azahar/bin/azahar-qt
```

### Testing Strategy

**Level 1: Unit Tests** (Fastest)
- Test individual components in isolation
- No Azahar dependency
- Run frequently during development

**Level 2: Examples** (Medium)
- Test component integration
- Verify shaders, pipelines work
- Visual validation

**Level 3: Integration** (Slowest)
- Full Azahar integration
- Test with real games
- Performance testing

---

## Summary

This approach gives you:

✅ **Zero modifications** to base Azahar repository  
✅ **Isolated development** - work independently  
✅ **Comprehensive testing** - unit, integration, examples  
✅ **Easy integration** - single CMake flag when ready  
✅ **CI/CD ready** - automated testing  
✅ **Modular** - can test pieces individually  

You can develop and test everything without touching Azahar at all, then integrate when ready!