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