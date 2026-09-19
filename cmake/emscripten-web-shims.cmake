# Emscripten build shims for the nested Azahar checkout.
#
# Injected with -DCMAKE_PROJECT_TOP_LEVEL_INCLUDES so the upstream tree stays
# unmodified; everything here compensates for assumptions upstream makes that
# only hold on native targets.
#
# Run via ../build_web.sh, which passes the matching cache variables.

# ── tsl::robin_map ───────────────────────────────────────────────────────────
# Upstream gets robin-map from the copy bundled with dynarmic, but
# externals/CMakeLists.txt only adds dynarmic for x86_64/arm64. Emscripten
# reports ARCHITECTURE=GENERIC, so the subdirectory is skipped while
# src/video_core/CMakeLists.txt still links tsl::robin_map unconditionally and
# the generate step fails.
#
# robin-map is header-only, so declare the interface target against the bundled
# headers. Calling add_subdirectory() on it here instead would run its own
# project() before any language is enabled, which fails with
# "CMAKE_ASM_COMPILER not set, after EnableLanguage".
if (NOT TARGET tsl::robin_map)
    set(AZAHAR_WEB_ROBIN_MAP
        "${CMAKE_CURRENT_SOURCE_DIR}/externals/dynarmic/externals/robin-map/include")
    if (NOT EXISTS "${AZAHAR_WEB_ROBIN_MAP}/tsl/robin_map.h")
        message(FATAL_ERROR
            "Bundled robin-map headers are missing at ${AZAHAR_WEB_ROBIN_MAP}. "
            "Run: git submodule update --init --recursive")
    endif()
    add_library(azahar_web_robin_map INTERFACE)
    target_include_directories(azahar_web_robin_map INTERFACE "${AZAHAR_WEB_ROBIN_MAP}")
    add_library(tsl::robin_map ALIAS azahar_web_robin_map)
    message(STATUS "Web shim: tsl::robin_map from the dynarmic-bundled headers")
endif()

# ── OpenSSL / LibreSSL ───────────────────────────────────────────────────────
# LibreSSL is built from externals/libressl rather than stubbed: citra_core's
# 3DS SSL service (hle/service/ssl/ssl_c.cpp) includes <openssl/rand.h>, so
# empty interface targets satisfy the link line but not the compile.
#
# Its one Emscripten incompatibility is the entropy-backend selection, which
# cmake/emscripten-libressl.cmake fixes; build_web.sh injects that file with
# -DCMAKE_PROJECT_LibreSSL_INCLUDE. Leave USE_SYSTEM_OPENSSL off so upstream
# takes the bundled branch.

# ── Emscripten compile options ───────────────────────────────────────────────
# wasm32 has a 32-bit size_t, so `ResultVal<u64>` narrows `unsigned long long`
# to `unsigned long` inside a braced initializer in common/expected.h. Clang
# reports -Wc++11-narrowing as a default-*error*, which the tree's existing `-w`
# cannot suppress, so citra_core will not compile without opting out explicitly.
#
# This mirrors the port's own `if (EMSCRIPTEN)` block, recorded in
# patches/cmake-web.patch, which upstream HEAD does not have:
#     add_compile_options(-Wno-c++11-narrowing -pthread -msimd128)
#     add_link_options(-msimd128)
# -pthread and -msimd128 are part of that block and must be applied uniformly,
# since both change the ABI of every object. Repeating them is harmless if a
# checkout already sets them itself.
# Exceptions: Emscripten disables catching by default, but citra_core throws
# (file IO, boost serialization), so a title aborts at load with
# "Exception thrown, but exception catching is not enabled". -fwasm-exceptions
# uses the native WebAssembly EH proposal rather than JS trampolines; the
# shipped artifact's glue contains no invoke_* thunks, which is what the JS
# fallback would generate, so it was built this way too. Must match on compile
# and link, and across every object.
if (EMSCRIPTEN)
    add_compile_options(-Wno-c++11-narrowing -pthread -msimd128 -fwasm-exceptions)
    add_link_options(-pthread -msimd128 -fwasm-exceptions)
    message(STATUS "Web shim: Emscripten compile options (narrowing, pthreads, SIMD, wasm EH)")
endif()
