# Web frontend overlay for the nested Azahar checkout.
#
# Added by cmake/emscripten-web-overlay.cmake through
# CMAKE_PROJECT_citra_INCLUDE. Target names referenced here are resolved when
# CMake generates the build, after upstream has created its libraries, so the
# upstream tree needs no modification.
#
# This reconstructs the software frontend the shipped web/azahar.wasm was built
# from. The original code is cold-stored and has no upstream equivalent: Azahar
# has no SDL frontend at all. See FORK_HANDOFF.md for the optional accelerated
# renderer recovery procedure.

add_executable(azahar_web
    src/citra_web/emu_window_web.cpp
    src/citra_web/emu_window_web.h
    src/citra_web/web_main.cpp
    src/citra_web/web_input.cpp
    src/citra_web/web_input.h
    src/citra_web/web_stubs.cpp
    # Upstream gap: src/core/CMakeLists.txt compiles fastinterp for every
    # non-MSVC target, but only compiles the arm_tick_counts.cpp it calls for
    # x86_64/arm64. Emscripten reports ARCHITECTURE=GENERIC, so citra_core is
    # left with an undefined Core::TicksForInstruction. Compile it here.
    ${AZAHAR_SOURCE_DIR}/src/core/arm/dynarmic/arm_tick_counts.cpp
)

target_include_directories(azahar_web PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${AZAHAR_SOURCE_DIR}/src
)

# The upstream targets set this per-target rather than globally, so a target
# added from outside src/ inherits nothing and would compile as C++98.
target_compile_features(azahar_web PRIVATE cxx_std_20)

# settings.h hard-errors with "At least one renderer must be enabled." unless a
# renderer macro is defined. src/ sets these per-target, so a target added from
# outside the tree has to declare its own.
target_compile_definitions(azahar_web PRIVATE ENABLE_SOFTWARE_RENDERER)

# Do not link input_common here. Its desktop initializer starts SDL controller,
# motion-emulation, and Cemuhook UDP worker threads. The UDP client is always
# constructed, even when no UDP input is configured; with value-initialized
# settings that means sendto(0.0.0.0:0), which Emscripten translates into an
# endless WebSocket retry loop before the module becomes ready. The web
# frontend carries small keyboard/analog factories and uses EmuWindow's touch
# device instead.
target_link_libraries(azahar_web PRIVATE citra_common citra_core video_core SDL2-static)

# Match the shipped artifact's runtime contract:
#  - the exported C API that web/azahar_ui.js calls
#  - pthreads with a preallocated pool, which needs COOP/COEP isolation
#  - a growable heap, because a 256 MB title plus decompressed RomFS does not
#    fit a fixed allocation
set(AZAHAR_WEB_EXPORT_LIST
    _azahar_init
    _azahar_load_rom
    _azahar_step_frame
    _azahar_run_loop
    _azahar_shutdown
    _azahar_framebuffer_nonblack_pixels
    _azahar_get_perf_stats
    _azahar_get_renderer_stats
    _azahar_reset_renderer_stats
    _azahar_save_state
    _azahar_load_state
    _azahar_get_state_operation
    _azahar_get_program_id
    _azahar_set_fast_forward
    _azahar_get_fast_forward
    _azahar_set_resolution_scale
    _azahar_get_resolution_scale
    _malloc
    _free
)
list(JOIN AZAHAR_WEB_EXPORT_LIST "," AZAHAR_WEB_EXPORTS)

target_link_options(azahar_web PRIVATE
    # Keep a compact function-index map beside the release artifact. It does
    # not add debug data to the Wasm, but makes production CPU profiles
    # attributable to C++ without rebuilding a slower diagnostic binary.
    --emit-symbol-map
    -sEXPORTED_FUNCTIONS=${AZAHAR_WEB_EXPORTS}
    -sEXPORTED_RUNTIME_METHODS=FS,ccall,cwrap,HEAPU8
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=768MB
    -sMAXIMUM_MEMORY=4GB
    -sSTACK_SIZE=2MB
    -sPTHREAD_POOL_SIZE=8
    -sFORCE_FILESYSTEM=1
    -sEXIT_RUNTIME=0
    -sASSERTIONS=$<IF:$<BOOL:${AZAHAR_WEB_ASSERTIONS}>,1,0>
    # Attach a JS stack to thrown C++ exceptions. Without it a std::out_of_range
    # from deep inside the core is just "key not found" with no location.
    $<$<BOOL:${AZAHAR_WEB_ASSERTIONS}>:-sEXCEPTION_STACK_TRACES=1>
    -lidbfs.js
)

set_target_properties(azahar_web PROPERTIES
    OUTPUT_NAME azahar
    SUFFIX ".js"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/Release"
)
