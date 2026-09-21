# Included via -DCMAKE_PROJECT_citra_INCLUDE, i.e. at the end of the top-level
# project() call, once C/CXX/ASM are enabled.
#
# cmake/emscripten-web-shims.cmake cannot do this: CMAKE_PROJECT_TOP_LEVEL_INCLUDES
# is processed *before* enable_language, for dependency providers, so adding a
# C++ target there fails with "required internal CMake variable not set:
# CMAKE_CXX_COMPILE_OBJECT".
#
# Upstream Azahar has no SDL frontend, so without this there is nothing to link
# a .wasm from. port/ carries a reconstruction; see FORK_HANDOFF.md.
#
# citra_core, video_core and SDL2-static do not exist yet at this point --
# src/ and externals/ are added later. That is fine: target_link_libraries
# records target names and resolves them at generate time.
if (EMSCRIPTEN AND AZAHAR_WEB_PORT_DIR AND EXISTS "${AZAHAR_WEB_PORT_DIR}/CMakeLists.txt")
    set(AZAHAR_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
    add_subdirectory("${AZAHAR_WEB_PORT_DIR}" "${CMAKE_BINARY_DIR}/azahar_web_port")
    message(STATUS "Web shim: frontend overlay from ${AZAHAR_WEB_PORT_DIR}")
endif()
