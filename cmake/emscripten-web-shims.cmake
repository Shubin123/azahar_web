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
